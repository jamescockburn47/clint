import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKnowledge } from '../scripts/build-knowledge.mjs';
import { queryKnowledge } from '../src/knowledge/store.js';
import { knowledgeTool } from '../src/knowledge/tools.js';
import { createConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-knowledge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { input: join(dir, 'records.jsonl'), db: join(dir, 'knowledge.sqlite') };
}
const row = (id, role, text) => ({ id, source: 'synthetic', episode: 'e1', role, date: null,
  text, reference: `source:${id}`, sourceHash: 'a'.repeat(64), attribution: 'role_only', part: 0, parts: 1 });
const scope = patch => createConversationContext({ transport: 'slack', conversationId: 'slack:team:channel',
  actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'open' },
  localOnly: true, readOnly: true, ...patch });

test('archive preserves opposed user/assistant positions and null dates through real FTS retrieval', async t => {
  const f = fixture(t);
  writeFileSync(f.input, [row('user', 'user', 'Reject autonomous deployment.'),
    row('assistant', 'assistant', 'Allow autonomous deployment.')].map(JSON.stringify).join('\n'));
  await buildKnowledge(f.input, f.db, new Date('2026-09-14T00:00:00Z'));
  const results = queryKnowledge(f.db, 'search', { query: 'autonomous deployment' });
  assert.equal(results.records.length, 2);
  assert.equal(results.records.find(r => r.id === 'user').role, 'user');
  assert.equal(results.records.find(r => r.id === 'assistant').role, 'assistant');
  assert.equal(results.records[0].date, null);
  assert.equal(queryKnowledge(f.db, 'status').liveAccountConnection, false);
  assert.equal(queryKnowledge(f.db, 'read', { id: 'user' }).records[0].text, 'Reject autonomous deployment.');
  assert.doesNotThrow(() => queryKnowledge(f.db, 'search', { query: '" OR * ) NEAR( ^' }));
});

test('missing or nonprivate authority rejects before opening archive, including forged tool calls', () => {
  for (const s of [undefined, scope({ audience: 'unknown' }), scope({ actorId: 'other' }),
    scope({ policy: { mode: 'colleague' } }), scope({ localOnly: false }), scope({ webOnly: true })]) {
    assert.equal(permitsTool('knowledge_search', {}, s), false);
    assert.equal(JSON.parse(knowledgeTool('search', {}, { scope: s,
      query: () => assert.fail('unauthorized read') })).state, 'not_authorized');
  }
  assert.equal(permitsTool('knowledge_search', {}, scope({})), true);
  for (const name of ['live_briefing', 'lqc_knowledge']) {
    assert.equal(permitsTool(name, { query: 'private source text' }, scope({})), false);
  }
  assert.equal(permitsTool('web_search', { query: 'contextual research' }, scope({})), true);
  assert.equal(permitsTool('web_fetch', { url: 'https://example.com' }, scope({})), true);
});

test('failed/duplicate/empty imports preserve existing snapshot and never publish partial data', async t => {
  const f = fixture(t);
  writeFileSync(f.input, JSON.stringify(row('a', 'user', 'source')));
  await buildKnowledge(f.input, f.db);
  const before = readFileSync(f.db);
  await assert.rejects(buildKnowledge(f.input, f.db), /destination_exists/);
  assert.deepEqual(readFileSync(f.db), before);
  for (const input of ['', '{bad}', JSON.stringify(row('a', 'user', 'x')) + '\n' + JSON.stringify(row('a', 'user', 'y'))]) {
    writeFileSync(f.input, input);
    await assert.rejects(buildKnowledge(f.input, f.db + '.new'));
    assert.equal(existsSync(f.db + '.new'), false);
  }
});
