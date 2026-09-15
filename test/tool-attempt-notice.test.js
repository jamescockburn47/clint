import { test } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { createConversationContext } from '../src/conversation-context.js';
import { finishToolAttempt } from '../src/tool-attempt-notice.js';

const makeScope = extra => createConversationContext({ transport: 'slack', conversationId: 'slack:synthetic',
  actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'project' },
  localOnly: true, readOnly: true, ...extra });
const reply = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {} });
const step = id => ({ stop_reason: 'tool_use', usage: {}, content: [
  { type: 'text', text: 'INTERMEDIATE_NOT_AN_ANSWER' },
  { type: 'tool_use', id, name: 'web_fetch', input: { id } }] });

async function harness(responses, { scope = makeScope(), critique = false } = {}) {
  const requests = [], reads = [];
  let usageCalls = 0, critiques = 0;
  const { LLMService } = await esmock('../src/claude.js', {
    '../src/tools/handler.js': { executeTool: async (name, input) => {
      reads.push({ name, input }); return JSON.stringify({ id: input.id, source: 'synthetic evidence' });
    } },
    '../src/usage-tracker.js': { checkDailyLimit: () => true, incrementDailyCalls: () => 1,
      trackTokens: () => {}, recordCallInUsage: () => usageCalls++ },
    '../src/quality-gate.js': { shouldCritique: () => critique,
      runCritique: async text => { critiques++; return text; } },
  });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic',
    gatherIntelligence: async () => ({ route: { category: 'general_knowledge', source: 'fixture' },
      memoryFragment: '', timing: { totalMs: 1, phase1Ms: 1 } }) });
  service._getAvailableTools = () => [{ name: 'web_fetch', input_schema: { type: 'object' } }];
  service._qwenClient = { messages: { create: async input => {
    requests.push(structuredClone(input)); assert.ok(responses.length, 'unexpected replay or finalization');
    return responses.shift();
  } } };
  const result = await service.getResponse('Read the synthetic evidence.', 'professional', 'owner', null,
    scope.conversationId, { conversation: scope });
  return { result, requests, reads, usageCalls, critiques };
}

test('exhausted tool loop becomes a notice with no extra call, tool replay or critique', async () => {
  const out = await harness(Array.from({ length: 6 }, (_, i) => step(String(i))), { critique: true });
  assert.equal(out.requests.length, 6); assert.equal(out.reads.length, 5);
  assert.ok(out.requests.every(request => request.tools.length === 1));
  assert.ok(out.requests.every(request => request.enableThinking === undefined));
  assert.equal(out.result.meta.termination, 'tool_round_limit'); assert.equal(out.result.meta.toolRounds, 5);
  assert.equal(out.result.meta.incomplete, true); assert.equal(out.result.meta.applicationNotice, true);
  assert.doesNotMatch(out.result.text, /INTERMEDIATE/); assert.equal(out.critiques, 0); assert.equal(out.usageCalls, 1);
});

test('post-tool loss and empty or malformed tool steps return notices, initial outage remains transient', async () => {
  for (const [responses, reason, calls, reads] of [
    [[step('first'), null], 'provider_lost', 2, 1],
    [[{ ...reply('I completed everything.'), stop_reason: 'tool_use' }], 'empty_tool_use', 1, 0],
    [[{ stop_reason: 'tool_use', content: null }], 'empty_tool_use', 1, 0],
  ]) {
    const out = await harness(responses, { critique: true });
    assert.equal(out.requests.length, calls); assert.equal(out.reads.length, reads);
    assert.equal(out.result.meta.termination, reason); assert.equal(out.critiques, 0);
    assert.doesNotMatch(out.result.text, /completed everything|INTERMEDIATE/);
  }
  const initial = await harness([null]);
  assert.equal(initial.result.meta.provider, 'unavailable'); assert.equal(initial.requests.length, 1);
});

test('truncation and unusable final content produce honest notices without another model request', async () => {
  for (const response of [{ ...reply('UNFINISHED'), stop_reason: 'max_tokens' },
    reply('<tool_call>\n<function=unknown>'), reply('<think>internal</think>'), reply(' '), reply('a'.repeat(10001)),
    { stop_reason: 'end_turn', content: [null] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: {} }] }]) {
    const out = await harness([response], { critique: true });
    assert.equal(out.requests.length, 1); assert.equal(out.reads.length, 0); assert.equal(out.critiques, 0);
    assert.equal(out.result.meta.applicationNotice, true); assert.equal(out.result.meta.incomplete, true);
    assert.doesNotMatch(out.result.text, /UNFINISHED|<tool_call>|<think>/);
  }
});

test('normal answers retain critique and outer output filtering; unoffered tools stay denied', async () => {
  const denied = step('denied'); denied.content[1].name = 'not_offered';
  const normal = await harness([denied, reply('Normal answer.')], { critique: true });
  assert.equal(normal.result.text, 'Normal answer.'); assert.equal(normal.reads.length, 0);
  assert.equal(normal.critiques, 1); assert.equal(normal.requests.length, 2);
  assert.match(normal.requests[1].messages.at(-1).content[0].content, /not offered/);
  const blocked = await harness([reply('secret project')], {
    scope: makeScope({ policy: { mode: 'project', blockedTopics: ['secret project'] } }), critique: true });
  assert.equal(blocked.critiques, 1); assert.equal(blocked.result.meta.outputBlocked, true);
  assert.doesNotMatch(blocked.result.text, /secret project/);
});

test('other transports, actors, audiences and write-capable scopes receive no new notice or replay', async () => {
  for (const scope of [makeScope({ readOnly: false }), makeScope({ localOnly: false }),
    makeScope({ transport: 'internal' }), makeScope({ audience: 'unknown' }), makeScope({ actorId: 'other' })]) {
    assert.equal(finishToolAttempt({ response: null }, {}, scope), null);
  }
  for (const scope of [makeScope({ readOnly: false }), makeScope({ transport: 'internal' })]) {
    const out = await harness([step('possible-effect'), null], { scope });
    assert.equal(out.requests.length, 2); assert.equal(out.reads.length, 1);
    assert.deepEqual(out.result, { text: null, meta: null });
  }
});
