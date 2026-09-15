import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedToolReads } from '../src/parallel-reads.js';

const scope = { transport: 'slack', isOwner: true, privateContext: true, localOnly: true, readOnly: true };
test('independent reads overlap at most three at once while preserving model call order', async () => {
  let active = 0, peak = 0;
  const blocks = Array.from({ length: 7 }, (_, id) => ({ id, name: 'web_fetch' }));
  const output = await orderedToolReads(blocks, async block => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, block.id % 2 ? 1 : 10));
    active--; return block.id;
  }, scope);
  assert.equal(peak, 3); assert.deepEqual(output, [0, 1, 2, 3, 4, 5, 6]);
});
test('writes, other scopes and duplicate expensive reads retain sequential execution', async () => {
  for (const [names, context] of [
    [['web_fetch', 'calendar_create_event'], scope], [['web_fetch', 'web_fetch'], undefined],
    [['web_fetch', 'web_fetch'], { ...scope, privateContext: false }],
    [['knowledge_search', 'knowledge_search'], scope], [['drive_read', 'drive_read'], scope],
  ]) {
    let active = 0, peak = 0;
    await orderedToolReads(names.map(name => ({ name })), async () => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    }, context);
    assert.equal(peak, 1);
  }
});
test('errors propagate after started reads settle, without orphaned work', async () => {
  let completed = false;
  await assert.rejects(orderedToolReads([{ name: 'web_fetch', id: 0 }, { name: 'web_fetch', id: 1 }], async block => {
    if (!block.id) throw new Error('read_failure');
    await new Promise(resolve => setTimeout(resolve, 10)); completed = true;
  }, scope), /read_failure/);
  assert.equal(completed, true);
});
