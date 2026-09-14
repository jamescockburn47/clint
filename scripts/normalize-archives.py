"""Normalize the previously preserved corpora, retaining all text and original references.

Usage: python scripts/normalize-archives.py PRIVATE_EVIDENCE_DIR NEW_OUTPUT_JSONL
No network/model calls. No claim of original authorship or semantic analysis.
"""
import hashlib
import json
import re
import sys
import zipfile
from uuid import uuid4
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def date_value(raw):
    try:
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            return datetime.fromtimestamp(raw, timezone.utc).isoformat()
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return parsed.isoformat() if parsed.tzinfo else None
    except (AttributeError, ValueError, OverflowError, OSError, TypeError):
        return None


def chunks(source, episode, ident, role, date, text, reference, source_hash, attribution):
    if not isinstance(text, str):
        raise ValueError('invalid_source_text')
    # Runtime schema counts UTF-16 code units; do not split a supplementary Unicode character.
    texts, start, units = [], 0, 0
    for i, char in enumerate(text):
        width = 2 if ord(char) > 0xffff else 1
        if units + width > 4000:
            texts.append(text[start:i])
            start, units = i, 0
        units += width
    texts.append(text[start:])
    parts = len(texts)
    for part, value in enumerate(texts):
        yield dict(id=digest(f'{source}:{episode}:{ident}:{part}'.encode()),
                   source=source, episode=episode, role=role, date=date_value(date),
                   text=value, reference=reference,
                   sourceHash=source_hash, attribution=attribution, part=part, parts=parts)


def json_lines(path):
    with path.open(encoding='utf-8') as source:
        for line in source:
            yield json.loads(line)


def records(root):
    path = root/'corpus-chatgpt.jsonl'
    expected = json.loads((root/'corpus-status.json').read_text())['corpus_sha256']
    if digest(path.read_bytes()) != expected:
        raise ValueError('chatgpt_snapshot_changed')
    for c in json_lines(path):
        for m in c['messages']:
            text = '\n'.join(p['text'] for p in m['text_parts'])
            yield from chunks('chatgpt-export', c['conversation_id'], m['source']['node_id'],
                              m['role'], m['raw_create_time'], text, json.dumps(m['source']),
                              m['source']['export_sha256'], m['authorship_status'])
    status = json.loads((root/'whatsapp-status.json').read_text())
    path = Path(status['snapshot_directory'])/'corpus-whatsapp.jsonl'
    if digest(path.read_bytes()) != status['corpus_sha256']:
        raise ValueError('whatsapp_snapshot_changed')
    for r in json_lines(path):
        role = {'exact_configured_owner_id': 'owner', 'bot_flag': 'bot'}.get(r['author_attribution'], 'unresolved')
        yield from chunks('whatsapp-archive', r['thread_id'], r['record_id'], role,
                          r['raw'].get('timestamp'), r['raw'].get('text', ''),
                          json.dumps(r['source_refs']), status['corpus_sha256'], r['author_attribution'])
    coverage = [p for p in (root/'claude-export-20260913/indexes').glob('*/coverage.json')
                if json.loads(p.read_text()).get('index_version') == 2]
    if len(coverage) != 1:
        raise ValueError('select_claude_index_explicitly')
    meta = json.loads(coverage[0].read_text())
    source = next(s for s in meta['sources'] if s['category'] == 'conversations')
    raw = Path(source['snapshot_path']).read_bytes()
    if digest(raw) != source['sha256']:
        raise ValueError('claude_snapshot_changed')
    with zipfile.ZipFile(source['snapshot_path']) as archive:
        conversations = json.loads(archive.read('conversations.json'))
    for ci, c in enumerate(conversations):
        for mi, m in enumerate(c['chat_messages']):
            # The exported visible text field is distinct from thinking/tools/injected blocks.
            yield from chunks('claude-export', c['uuid'], m['uuid'], m['sender'], m.get('created_at'),
                              m.get('text', ''), f'{source["sha256"]}:conversations.json/{ci}/chat_messages/{mi}',
                              source['sha256'], 'role_only_not_verified_original_writing')
    manifests = list((root/'spoken-manifests').glob('*.json'))
    if len(manifests) != 1:
        raise ValueError('select_spoken_manifest_explicitly')
    for s in json.loads(manifests[0].read_text())['sources']:
        raw = Path(s['local_original']).read_bytes()
        if digest(raw) != s['sha256']:
            raise ValueError('spoken_snapshot_changed')
        labels, registered = Counter(), set(s['speaker_line_numbers'])
        for n, line in enumerate(raw.decode('utf-8-sig').splitlines(keepends=True), 1):
            speaker = re.match(r'^\s*(?:\*\*)?(James Cockburn|Jason Hoggan|Alexander Calthrop):', line) if n in registered else None
            if n in registered and not speaker:
                raise ValueError('registered_speaker_line_unrecognized')
            if speaker:
                labels[speaker[1]] += 1
            role = 'James-labelled' if speaker and speaker[1] == 'James Cockburn' else 'other-labelled' if speaker else 'transcript_context'
            yield from chunks('spoken-transcript', s['sha256'], str(n), role, None, line,
                              f'{s["sha256"]}:line:{n}', s['sha256'], s['authorship_basis'] if speaker else 'machine_summary_or_unattributed_transcript_context')
        if dict(labels) != s['speaker_label_counts']:
            raise ValueError('spoken_attribution_count_mismatch')
    recent = root/'recent-chatgpt-app-20260913'
    manifest = json.loads((recent/'manifest.json').read_text())
    synthetic = {c['id'] for c in manifest['conversations'] if c['explicitSyntheticContentDetected']}
    seen = set()
    for path in sorted(recent.glob('*/*.json')):
        raw = path.read_bytes()
        page = json.loads(raw)
        cid = page['thread']['id']
        for turn in page['turns']:
            for i, item in enumerate(turn['items']):
                key = (cid, turn['id'], item.get('id', str(i)))
                if key in seen:
                    continue
                seen.add(key)
                if item['type'] == 'userMessage':
                    role = 'user'
                    text = '\n'.join(c['text'] for c in item.get('content', []) if c.get('type') == 'text')
                elif item['type'] == 'agentMessage':
                    role, text = 'assistant', item.get('text', '')
                else:
                    continue
                attribution = 'synthetic_not_biographical' if cid in synthetic else 'role_only_not_verified_original_writing'
                yield from chunks('chatgpt-recent-app', cid, ':'.join(key), role, turn.get('startedAt'), text,
                                  f'{path.relative_to(root).as_posix()}:turn:{turn["id"]}:item:{i}', digest(raw), attribution)


def main(root, output):
    counts = Counter()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive output, so reruns cannot destroy prior evidence. A failed file remains explicitly partial.
    if output.exists():
        raise ValueError('destination_exists')
    partial = output.with_name(output.name + '.' + uuid4().hex + '.partial')
    with partial.open('x', encoding='utf-8', newline='\n') as target:
        for r in records(root):
            counts[r['source']] += 1
            target.write(json.dumps(r, ensure_ascii=False) + '\n')
    if not counts:
        raise ValueError('empty_corpus')
    import os
    os.link(partial, output)
    partial.unlink()
    report = {'chunks': dict(counts), 'semantic_analysis_completed': 0,
              'source': 'preserved_text_fields_and_full_spoken_files',
              'exclusions': ['non-text attachments, tool output, thinking and injected content remain in originals',
                             'derived memory store and supplied profile are not primary behavioral evidence',
                             'coding session inventory is not normalized here'],
              'output_sha256': digest(output.read_bytes())}
    output.with_suffix('.coverage.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
