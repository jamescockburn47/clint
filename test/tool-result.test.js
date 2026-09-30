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
for (const tool of ['knowledge_read', 'task_save', 'task_read', 'task_list', 'task_set_status']) {
test(`real shared-core loop passes complete ${tool} result to its next model request`, async () => {
  const payload = JSON.stringify({ state: 'snapshot', records: [{ id: 's1', text: 'x'.repeat(5000) + ' Trailing denial preserved.' }] });
  const { LLMService } = await esmock('../src/claude.js', {
    '../src/slack/flow-guard.js': { guardedExecuteTool: async () => payload },
    '../src/usage-tracker.js': { trackTokens: () => {} },
  });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic' });
  const requests = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: tool, input: { id: 's1' } }], usage: {} },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic complete reply.' }], usage: {} },
  ];
  const client = { messages: { create: async input => { requests.push(structuredClone(input)); return replies.shift(); } } };
  service._qwenClient = client;
  await service._toolLoop(client, 'synthetic', { call: fn => fn() }, [], [], [{ name: tool }],
    true, 'professional', 'synthetic', 'synthetic', 'synthetic', 'recall');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).content[0].content, payload);
});
}

test('task results preserve maximally escaped permitted fields and 100 complete summaries', () => {
  const task = { id: 'a'.repeat(24), owner: 'u'.repeat(200), conversation: 'c'.repeat(200),
    title: '\u0000'.repeat(200), details: '\u0000'.repeat(12000), original_request: '\u0000'.repeat(12000),
    status: 'queued', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  for (const name of ['task_save', 'task_read', 'task_set_status']) {
    const payload = JSON.stringify({ state: 'recorded', task, execution: 'Does not execute the underlying work.' });
    assert.ok(payload.length > 145000 && payload.length < 160000);
    assert.equal(boundToolResult(name, payload), payload);
  }
  const { details, original_request, owner, conversation, ...summary } = task;
  const payload = JSON.stringify({ tasks: Array.from({ length: 100 }, () => summary), limit: 100 });
  assert.ok(payload.length > 120000 && payload.length < 160000);
  assert.equal(boundToolResult('task_list', payload), payload);
});

test('task result boundary returns complete JSON or explicit unavailability, never a prefix', () => {
  const exact = JSON.stringify({ value: 'x'.repeat(159988) });
  assert.equal(exact.length, 160000);
  for (const name of ['task_save', 'task_read', 'task_list', 'task_set_status']) {
    assert.equal(boundToolResult(name, exact), exact);
    for (const payload of [exact + ' ', '{"private":"PREFIX', 'null', '[]', 3]) {
      const result = JSON.parse(boundToolResult(name, payload));
      assert.equal(result.state, 'evidence_unavailable');
      assert.deepEqual(result.records, []);
      assert.doesNotMatch(JSON.stringify(result), /PREFIX|truncated/);
    }
  }
});
