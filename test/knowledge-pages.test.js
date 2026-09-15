import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildKnowledge } from '../scripts/build-knowledge.mjs';
import { queryKnowledge } from '../src/knowledge/store.js';

async function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, source: 'synthetic',
    episode: 'e1', reference: 'message:one', role: 'unknown', date: null,
    sourceHash: 'a'.repeat(64), attribution: 'role_only', part: i, parts: 7,
    text: i === 6 ? 'FINAL QUALIFIER: the preceding proposal was rejected.😀' : `Proposal evidence ${i}.\n`,
    ...(patch[i] ?? {}) }));
  const input = join(dir, 'input.jsonl'), path = join(dir, 'knowledge.sqlite');
  writeFileSync(input, rows.map(JSON.stringify).join('\n'));
  await buildKnowledge(input, path);
  return { path, rows };
}

test('versioned pages reconstruct the entire long record with its final qualifier', async t => {
  const { path, rows } = await fixture(t), before = readFileSync(path);
  let input = { id: 'p0' }, text = '', pages = 0;
  do {
    const result = queryKnowledge(path, 'record', input);
    assert.equal(result.state, 'snapshot');
    assert.equal(result.records[0].completeness, 'partial_indexed_record');
    assert.equal(result.page.completeRecordInThisResponse, false);
    assert.equal(result.page.startPart, pages * 3);
    assert.equal(result.records[0].role, 'unknown');
    assert.equal(result.records[0].date, null);
    assert.ok(result.records[0].text.length <= 12000);
    assert.ok(result.records[0].sourceChunkIds.length <= 3);
    text += result.records[0].text;
    input = result.page.nextRead;
    pages++;
    if (!input) {
      assert.equal(result.page.unreadPartsBefore, 6);
      assert.equal(result.page.unreadPartsAfter, 0);
      assert.match(result.interpretation, /final page is not the whole record/);
    }
  } while (input);
  assert.equal(pages, 3);
  assert.equal(text, rows.map(row => row.text).join(''));
  assert.deepEqual(readFileSync(path), before);
});

test('a search hit opens its own region immediately and offers versioned backward reading', async t => {
  const { path } = await fixture(t);
  const result = queryKnowledge(path, 'record', { id: 'p6' });
  assert.equal(result.page.startPart, 6);
  assert.equal(result.page.unreadPartsBefore, 6);
  assert.match(result.records[0].text, /FINAL QUALIFIER/);
  const previous = queryKnowledge(path, 'record', result.page.previousRead);
  assert.equal(previous.page.startPart, 3);
  assert.equal(previous.page.recordVersion, result.page.recordVersion);
});

test('continuations require the original version and reject changed text or snapshot identity', async t => {
  for (const change of ['text', 'snapshot']) {
    const { path } = await fixture(t);
    const next = queryKnowledge(path, 'record', { id: 'p0' }).page.nextRead;
    assert.equal(queryKnowledge(path, 'record', { id: 'p0', part: 3 }).reason, 'record_version_required');
    assert.equal(queryKnowledge(path, 'record', { ...next, part: 7 }).reason, 'record_page_out_of_range');
    const db = new DatabaseSync(path);
    if (change === 'text') db.prepare('UPDATE records SET text=? WHERE id=?').run('A changed later qualifier.', 'p6');
    else db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify('b'.repeat(64)), 'inputSha256');
    db.close();
    const result = queryKnowledge(path, 'record', next);
    assert.equal(result.reason, 'record_changed');
    assert.deepEqual(result.records, []);
  }
});

test('conflicting attribution in an unread page rejects the first page', async t => {
  const { path } = await fixture(t, { 6: { role: 'assistant' } });
  const result = queryKnowledge(path, 'record', { id: 'p0' });
  assert.equal(result.reason, 'record_metadata_conflict');
  assert.deepEqual(result.records, []);
});

test('search exposes an actionable long-record read without claiming complete evidence', async t => {
  const { path } = await fixture(t);
  const result = queryKnowledge(path, 'search', { query: 'proposal' });
  assert.deepEqual(result.records, []);
  assert.equal(result.unavailableRecords.length, 1);
  const match = result.unavailableRecords[0];
  assert.equal(match.readWith, 'knowledge_read');
  assert.equal(match.readingMode, 'versioned_pages');
  assert.equal(queryKnowledge(path, 'record', match.input).page.startPart, 0);
});
