import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKnowledge } from '../scripts/build-knowledge.mjs';
import { queryKnowledge } from '../src/knowledge/store.js';
import { knowledgeTool } from '../src/knowledge/tools.js';
import { boundToolResult } from '../src/tool-result.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';

const record = (id, text) => ({ id, text, source: 'synthetic', episode: id, role: 'user',
  date: null, reference: `synthetic:${id}`, sourceHash: 'a'.repeat(64), attribution: 'source_role_only', part: 0, parts: 1 });
async function fixture(t, records) {
  const directory = mkdtempSync(join(tmpdir(), 'clint-query-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'records.jsonl'), db = join(directory, 'knowledge.sqlite');
  writeFileSync(input, records.map(JSON.stringify).join('\n'));
  await buildKnowledge(input, db);
  return db;
}
const prefix = 'please locate an earlier saved discussion where someone mentioned this particular rare mineral';

test('a distinguishing term after twelve distinct words remains searchable through the authorized tool boundary', async t => {
  const source = 'Asterite was proposed as a specimen label; the notebook does not confirm that identification.';
  const db = await fixture(t, [record('mineral', source)]);
  const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:synthetic:query',
    actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'open' }, localOnly: true, readOnly: true });
  const query = `${prefix} Asterite`;
  assert.equal(new Set(prefix.match(/[\p{L}\p{N}_-]+/gu)).size, 13);
  const before = readFileSync(db);
  const result = await withConversationContext(scope, () => JSON.parse(boundToolResult('knowledge_search',
    knowledgeTool('search', { query }, { path: db }))));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, source);
  assert.equal(result.records[0].role, 'user');
  assert.equal(result.records[0].date, null);
  assert.equal(result.records[0].completeness, 'all_indexed_parts');
  assert.equal(result.liveAccountConnection, false);
  assert.equal(result.verification.externalTruth, 'not_checked');
  assert.deepEqual(readFileSync(db), before);
});

test('moving the only matching term across the old boundary does not discard it; short queries retain their result', async t => {
  const db = await fixture(t, [record('target', 'Virelite: classification unconfirmed.')]);
  const filler = prefix.split(' ');
  for (const position of [0, 5, 11, 12, 13]) {
    const terms = [...filler]; terms.splice(position, 0, 'Virelite');
    const result = queryKnowledge(db, 'search', { query: terms.join(' ') });
    assert.deepEqual(result.records.map(row => row.id), ['target']);
  }
  const exact = queryKnowledge(db, 'search', { query: 'Virelite' });
  assert.deepEqual(exact.records.map(row => row.id), ['target']);
});

test('all unique terms fitting the existing character limit work while invalid length and FTS grammar stay bounded', async t => {
  const terms = Array.from({ length: 100 }, (_, index) => String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26));
  const query = terms.join(' '); assert.equal(query.length, 299);
  const db = await fixture(t, [record('last', terms.at(-1)), record('grammar', 'NEAR is a literal token here.')]);
  const before = readFileSync(db);
  assert.deepEqual(queryKnowledge(db, 'search', { query }).records.map(row => row.id), ['last']);
  assert.throws(() => queryKnowledge(db, 'search', { query: query + ' xx' }));
  assert.deepEqual(queryKnowledge(db, 'search', { query: '" NEAR( * ) OR \"; DROP TABLE records; --' })
    .records.map(row => row.id), ['grammar']);
  assert.equal(queryKnowledge(db, 'search', { query: '?!' }).records.length, 0);
  assert.deepEqual(readFileSync(db), before);
});
