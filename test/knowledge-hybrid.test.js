import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKnowledge } from '../scripts/build-knowledge.mjs';
import { buildDenseKnowledge } from '../scripts/build-dense-knowledge.mjs';
import { hybridSearch, fuseCandidates, denseWorker } from '../src/knowledge/hybrid.js';
import { passageSegments, verifyEmbeddingRuntime, EMBEDDING_BUILD, EMBEDDING_MODEL } from '../src/knowledge/embedding.js';
import { searchKnowledgeTool } from '../src/knowledge/tools.js';
import { queryKnowledge } from '../src/knowledge/store.js';

const vector = axis => Array.from({ length: 4096 }, (_, i) => i === axis ? 1 : 0);
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-hybrid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = ['Cancelled the seaside break. The earlier booking proposal was withdrawn.',
    'Equipment stock list.', 'Holiday planning software uses an unrelated test database.'].map((text, i) => ({
    id: `r${i}`, source: 'synthetic', episode: 'e1', reference: `message:${i}`, role: 'user', date: null,
    sourceHash: 'a'.repeat(64), attribution: 'role_only', part: 0, parts: 1, text }));
  const input = join(dir, 'input.jsonl'), path = join(dir, 'knowledge.sqlite'), densePath = join(dir, 'dense.sqlite');
  writeFileSync(input, rows.map(JSON.stringify).join('\n'));
  await buildKnowledge(input, path);
  return { path, densePath, rows };
}

test('dense hits with no lexical overlap are hydrated from the original source with qualifications', async t => {
  const { path, densePath, rows } = await fixture(t), before = readFileSync(path);
  const built = await buildDenseKnowledge(path, densePath, { segment: async s => [s], yieldMs: 0,
    embed: async text => vector(rows.findIndex(r => r.text === text)) });
  assert.equal(built.state, 'complete');
  assert.deepEqual(queryKnowledge(path, 'search', { query: 'vacation' }).records, []);
  const result = await hybridSearch(path, { query: 'vacation' }, { embed: async () => vector(0) });
  assert.equal(result.retrieval.strategy, 'bm25_dense_rrf');
  assert.equal(result.retrieval.coverage.mode, 'dense_complete');
  assert.equal(result.records[0].id, 'r0');
  assert.equal(result.records[0].text, rows[0].text);
  assert.equal(result.records[0].completeness, 'all_indexed_parts');
  assert.deepEqual(readFileSync(path), before);
});

test('partial indexing resumes without reembedding completed records and remains explicitly partial', async t => {
  const { path, densePath } = await fixture(t);
  const options = { segment: async s => [s], yieldMs: 0, embed: async () => vector(0), maxChunks: 1 };
  assert.equal((await buildDenseKnowledge(path, densePath, options)).indexedChunks, 1);
  assert.equal((await buildDenseKnowledge(path, densePath, options)).indexedChunks, 2);
  const result = await hybridSearch(path, { query: 'equipment' }, { embed: async () => vector(0) });
  assert.equal(result.retrieval.coverage.mode, 'dense_partial');
  assert.equal(result.retrieval.coverage.indexedChunks, 2);
  assert.ok(result.records.some(r => r.id === 'r1'));
});

test('missing, incompatible or unavailable dense search preserves useful lexical retrieval', async t => {
  const { path, densePath } = await fixture(t);
  const missing = await hybridSearch(path, { query: 'equipment' }, { embed: () => assert.fail('embedding without index') });
  assert.equal(missing.retrieval.fallbackReason, 'dense_index_not_built');
  assert.equal(missing.records[0].id, 'r1');
  await buildDenseKnowledge(path, densePath, { segment: async s => [s], yieldMs: 0, embed: async () => vector(0) });
  await assert.rejects(denseWorker({ path: densePath, inputSha256: 'b'.repeat(64), vector: vector(0) }));
  const unavailable = await hybridSearch(path, { query: 'equipment' }, { embed: async () => { throw new Error('offline'); } });
  assert.equal(unavailable.retrieval.fallbackReason, 'dense_search_unavailable');
  assert.equal(unavailable.records[0].id, 'r1');
});

test('fusion counts distinct records, not repeated chunks, with deterministic ties', () => {
  const a = { id: 'a', recordKey: 'one' }, duplicate = { id: 'z', recordKey: 'one' }, b = { id: 'b', recordKey: 'two' };
  assert.deepEqual(fuseCandidates([a, duplicate, b], [b, a]).map(r => r.id), ['a', 'b']);
});

test('token-aware splitting retains all characters and splits only overlong passages', async () => {
  const original = '🦊'.repeat(3000);
  const pieces = await passageSegments(original, async (_path, { content }) => ({ tokens: Array(Array.from(content).length) }));
  assert.equal(pieces.length, 2);
  assert.equal(pieces.join(''), original);
  assert.ok(pieces.every(p => Array.from(p).length <= 1792));
});

test('private scope is enforced before archive, embedding or worker access', async () => {
  for (const scope of [undefined, {}, { isOwner: false, privateContext: true, localOnly: true },
    { isOwner: true, privateContext: true, localOnly: true, webOnly: true }]) {
    const result = await searchKnowledgeTool({ query: 'private' }, { scope,
      search: () => assert.fail('unauthorized retrieval') });
    assert.equal(JSON.parse(result).state, 'not_authorized');
  }
});

test('hard-linked destinations cannot mutate or chmod the original archive', async t => {
  const { path, densePath } = await fixture(t), before = readFileSync(path);
  linkSync(path, densePath);
  await assert.rejects(buildDenseKnowledge(path, densePath, { admit: () => false }), /index_cannot_replace_source/);
  assert.deepEqual(readFileSync(path), before);
});

test('changed source bytes invalidate resumed indexes even when archive metadata was not updated', async t => {
  const { path, densePath } = await fixture(t);
  const opts = { segment: async s => [s], embed: async () => vector(0), yieldMs: 0 };
  await buildDenseKnowledge(path, densePath, opts);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE records SET text=? WHERE id=?').run('Changed evidence.', 'r0'); db.close();
  await assert.rejects(buildDenseKnowledge(path, densePath, opts), /dense_index_mismatch/);
});

test('query embedding runtime identity rejects a same-dimension replacement', async () => {
  const props = { model_path: '/models/' + EMBEDDING_MODEL, build_info: EMBEDDING_BUILD,
    default_generation_settings: { n_ctx: 2048 } };
  await verifyEmbeddingRuntime(async () => props);
  await assert.rejects(verifyEmbeddingRuntime(async () => ({ ...props, model_path: '/models/different-4096d.gguf' })), /runtime_mismatch/);
  await assert.rejects(verifyEmbeddingRuntime(async () => ({ ...props, build_info: 'different' })), /runtime_mismatch/);
  await assert.rejects(verifyEmbeddingRuntime(async () => ({ ...props, default_generation_settings: {} })), /runtime_mismatch/);
  await assert.rejects(verifyEmbeddingRuntime(async () => ({ ...props, model_path: '/models/other-' + EMBEDDING_MODEL })), /runtime_mismatch/);
});
