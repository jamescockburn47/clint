import { test } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { boundToolResult } from '../src/tool-result.js';

test('source qualifier beyond old 1500-character boundary survives exactly in valid JSON', () => {
  const result = JSON.stringify({ state: 'snapshot', records: [{ id: 's1', text: 'x'.repeat(5000) + ' This was hypothetical; no action is recorded.' }] });
  assert.equal(boundToolResult('knowledge_read', result), result);
  assert.match(JSON.parse(boundToolResult('knowledge_search', result)).records[0].text, /no action is recorded\.$/);
});
test('oversized search drops whole records and identifies omissions without truncating retained evidence', () => {
  const records = ['a', 'b', 'c'].map(id => ({ id, text: id.repeat(11000) }));
  const packed = boundToolResult('knowledge_search', JSON.stringify({ state: 'snapshot', records }));
  assert.ok(packed.length <= 24000);
  const result = JSON.parse(packed);
  assert.deepEqual(result.records, records.slice(0, 2));
  assert.deepEqual(result.omittedRecordIds, ['c']);
});
test('invalid or oversized individual evidence is rejected without exposing an affirmative prefix', () => {
  for (const result of ['{"text":"PRIVATE_PREFIX', 'null', '[]', JSON.stringify({ records: [{ text: 'PRIVATE_PREFIX' + 'x'.repeat(25000) }] })]) {
    const bounded = boundToolResult('knowledge_read', result);
    assert.equal(JSON.parse(bounded).state, 'evidence_unavailable');
    assert.deepEqual(JSON.parse(bounded).records, []);
    assert.doesNotMatch(bounded, /PRIVATE_PREFIX/);
  }
});
test('real shared-core tool loop passes complete evidence to its next model request', async () => {
  const payload = JSON.stringify({ state: 'snapshot', records: [{ id: 's1', text: 'x'.repeat(5000) + ' Trailing denial preserved.' }] });
  const { LLMService } = await esmock('../src/claude.js', {
    '../src/tools/handler.js': { executeTool: async () => payload },
    '../src/usage-tracker.js': { trackTokens: () => {} },
  });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic' });
  const requests = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'knowledge_read', input: { id: 's1' } }], usage: {} },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic complete reply.' }], usage: {} },
  ];
  const client = { messages: { create: async input => { requests.push(structuredClone(input)); return replies.shift(); } } };
  service._qwenClient = client;
  await service._toolLoop(client, 'synthetic', { call: fn => fn() }, [], [], [{ name: 'knowledge_read' }],
    true, 'professional', 'synthetic', 'synthetic', 'synthetic', 'recall');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).content[0].content, payload);
});
