"""Synthetic end-to-end fixtures for every supported preserved-source adapter."""
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('normalize', Path(__file__).with_name('normalize-archives.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NormalizeTests(unittest.TestCase):
    def test_every_source_role_integrity_and_changed_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def save(path, value):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value), encoding='utf-8')

            chat = root/'corpus-chatgpt.jsonl'
            save(chat, {'conversation_id': 'chat1', 'messages': [{
                'source': {'node_id': 'n1', 'export_sha256': 'a'*64}, 'role': 'assistant',
                'raw_create_time': None, 'text_parts': [{'text': 'Assistant invented approval'}],
                'authorship_status': 'role_only'}]})
            save(root/'corpus-status.json', {'corpus_sha256': m.digest(chat.read_bytes())})
            whatsapp = root/'wa/corpus-whatsapp.jsonl'
            save(whatsapp, {'thread_id': 'wa1', 'record_id': 'w1', 'raw': {'text': 'Unresolved speaker',
                'timestamp': 'not-a-date'}, 'author_attribution': 'unresolved_human_or_other_agent',
                'source_refs': [{'source_id': 'original', 'line': 1}]})
            save(root/'whatsapp-status.json', {'snapshot_directory': str(whatsapp.parent),
                'corpus_sha256': m.digest(whatsapp.read_bytes())})
            archive = root/'claude.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('conversations.json', json.dumps([{'uuid': 'c1', 'chat_messages': [{
                    'uuid': 'm1', 'sender': 'human', 'created_at': '2026-09-14T00:00:00Z',
                    'text': 'Human request', 'content': [{'type': 'thinking', 'text': 'Not source writing'}]}]}]))
            save(root/'claude-export-20260913/indexes/version/coverage.json', {'index_version': 2,
                'sources': [{'category': 'conversations', 'snapshot_path': str(archive), 'sha256': m.digest(archive.read_bytes())}]})
            spoken = root/'spoken.txt'
            spoken.write_text('Summary: James allegedly approved\n**James Cockburn:** I require review.\nJason Hoggan: Fine.\n', encoding='utf-8', newline='\n')
            save(root/'spoken-manifests/manifest.json', {'sources': [{'local_original': str(spoken),
                'sha256': m.digest(spoken.read_bytes()), 'speaker_line_numbers': [2, 3],
                'speaker_label_counts': {'James Cockburn': 1, 'Jason Hoggan': 1},
                'authorship_basis': 'transcript_labels'}]})
            recent = root/'recent-chatgpt-app-20260913'
            save(recent/'manifest.json', {'conversations': [{'id': 'r1', 'explicitSyntheticContentDetected': True}]})
            page = {'thread': {'id': 'r1'}, 'turns': [{'id': 't1', 'startedAt': None,
                'items': [{'type': 'userMessage', 'id': 'u1', 'content': [{'type': 'text', 'text': 'Synthetic not biography'}]}]}]}
            save(recent/'r1/page1.json', page)
            save(recent/'r1/page2.json', page)
            rows = list(m.records(root))
            self.assertEqual(len(rows), 7)
            self.assertEqual(len({r['id'] for r in rows}), 7)
            self.assertEqual(next(r for r in rows if r['source'] == 'chatgpt-export')['role'], 'assistant')
            self.assertEqual(next(r for r in rows if r['source'] == 'whatsapp-archive')['role'], 'unresolved')
            self.assertEqual(next(r for r in rows if r['source'] == 'whatsapp-archive')['date'], None)
            self.assertEqual(next(r for r in rows if r['role'] == 'James-labelled')['text'], '**James Cockburn:** I require review.\n')
            self.assertTrue(any(r['role'] == 'transcript_context' for r in rows))
            self.assertEqual(next(r for r in rows if r['source'] == 'chatgpt-recent-app')['attribution'], 'synthetic_not_biographical')
            self.assertFalse(any('Not source writing' in r['text'] for r in rows))
            chat.write_text('changed', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'chatgpt_snapshot_changed'):
                list(m.records(root))


if __name__ == '__main__':
    unittest.main()
