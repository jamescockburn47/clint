import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildKnowledge } from '../scripts/build-knowledge.mjs';
import { queryKnowledge } from '../src/knowledge/store.js';
import { knowledgeTool } from '../src/knowledge/tools.js';

const part = (index, text, patch = {}) => ({ id: `part-${index}`, source: 'synthetic', episode: 'e1',
  role: 'user', date: null, text, reference: 'message:one', sourceHash: 'a'.repeat(64),
  attribution: 'role_only', part: index, parts: 2, ...patch });
async function fixture(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'records.jsonl'), db = join(dir, 'knowledge.sqlite');
  writeFileSync(input, rows.map(JSON.stringify).join('\n'));
  await buildKnowledge(input, db);
  return db;
}
test('reading any part reconstructs the exact full normalized record including trailing denial', async t => {
  const rows = [part(0, 'Daniel wrote: "I contacted the client".'),
    part(1, ' That was Daniel speaking. I have not said whether I contacted them.\n😀')];
  const db = await fixture(t, rows);
  const before = readFileSync(db);
  for (const row of rows) {
    const result = queryKnowledge(db, 'record', { id: row.id });
    assert.equal(result.state, 'snapshot');
    assert.equal(result.records[0].text, rows.map(r => r.text).join(''));
    assert.equal(result.records[0].requestedChunkId, row.id);
    assert.deepEqual(result.records[0].sourceChunkIds, ['part-0', 'part-1']);
    assert.equal(result.records[0].completeness, 'all_indexed_parts');
    assert.equal(result.records[0].sourceHash, 'a'.repeat(64));
    assert.equal(result.records[0].normalizedTextSha256, createHash('sha256').update(rows.map(r => r.text).join('')).digest('hex'));
  }
  const searched = queryKnowledge(db, 'search', { query: 'contacted client' });
  assert.equal(searched.records.length, 1, 'matching chunks are deduplicated into one complete source record');
  assert.equal(searched.records[0].text, rows.map(r => r.text).join(''));
  assert.deepEqual(readFileSync(db), before);
});
test('missing parts, duplicate part numbers, and conflicting attribution never expose partial text', async t => {
  const variants = [
    [part(0, 'affirmative prefix')],
    [part(0, 'affirmative prefix'), part(0, 'different prefix', { id: 'other-id' })],
    [part(0, 'affirmative prefix'), part(1, 'qualifier', { role: 'assistant' })],
    [part(0, 'affirmative prefix'), part(1, 'qualifier', { sourceHash: 'b'.repeat(64) })],
  ];
  for (const rows of variants) {
    const result = queryKnowledge(await fixture(t, rows), 'record', { id: 'part-0' });
    assert.equal(result.state, 'record_unavailable');
    assert.deepEqual(result.records, []);
  }
});
test('an incomplete long record is unavailable even when the missing part is on a later page', async t => {
  const db = await fixture(t, [part(0, 'source', { parts: 4 })]);
  const result = queryKnowledge(db, 'record', { id: 'part-0' });
  assert.equal(result.reason, 'record_incomplete');
  assert.deepEqual(result.records, []);
});
test('different episodes sharing a reference are never stitched together', async t => {
  const db = await fixture(t, [part(0, 'own prefix'), part(1, 'other episode', { episode: 'e2' })]);
  assert.equal(queryKnowledge(db, 'record', { id: 'part-0' }).reason, 'record_incomplete');
});
test('record reads remain behind the existing private-owner boundary before I/O', () => {
  for (const scope of [undefined, {}, { isOwner: true, privateContext: false, localOnly: true },
    { isOwner: true, privateContext: true, localOnly: true, webOnly: true }]) {
    assert.equal(JSON.parse(knowledgeTool('record', { id: 'part-0' }, {
      scope, query: () => assert.fail('unauthorized database read'),
    })).state, 'not_authorized');
  }
});

test('snapshot creation time and assistant role never become live observation or corroboration', async t => {
  const db = await fixture(t, [part(0, 'Assistant text says the deployment is confirmed.', {
    role: 'assistant', date: '2026-09-01T00:00:00Z', parts: 1,
  })]);
  for (const [operation, input] of [['status', {}], ['search', { query: 'deployment' }],
    ['record', { id: 'part-0' }], ['read', { id: 'part-0' }], ['search', { query: '!!!' }]]) {
    const result = queryKnowledge(db, operation, input);
    assert.equal(result.evidenceType, 'archive_snapshot');
    assert.equal(result.liveAccountConnection, false);
    assert.equal(result.verification.currentState, 'not_checked');
    assert.equal(result.verification.assistantStatements, 'not_independent_corroboration');
    assert.equal(result.verification.authorship, 'source_attribution_labels_only');
    if (result.records?.length) {
      assert.equal(result.records[0].role, 'assistant');
      assert.equal(result.records[0].date, '2026-09-01T00:00:00Z');
      assert.notEqual(result.snapshotRecordedAt, result.records[0].date);
    }
  }
});
