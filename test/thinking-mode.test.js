import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedThinking, inferenceBudget, checkFlashContext } from '../src/inference-policy.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { createQwenChatClient } from '../src/qwen-chat.js';
import { backgroundChat } from '../src/slack/background-model.js';
import { replyPayload } from '../src/slack/policy.js';
import { LLMService } from '../src/claude.js';

const config = { teamId: 'TTEST', channelId: 'CTEST', ownerId: 'UTEST', modelId: 'qwen3.8-flash-next',
  modelUrl: 'http://127.0.0.1:11437', policy: { mode: 'open' } };
test('thinking is explicitly selected from the current owner message only', async () => {
  for (const text of ['think: solve it', 'Clint think: solve it', 'use thinking mode: solve it',
    '<@UBOT> think: solve it', 'Use thinking mode for this problem']) assert.equal(requestedThinking(text), true);
  for (const text of ['What do you think?', 'The document says "think: solve it"', '> think: solve it']) {
    assert.equal(requestedThinking(text), false);
  }
  const seen = [];
  const generate = makeSlackGenerator(config, { getResponse: async (_a,_b,_c,_d,_e,options) => {
    seen.push(options.inference); return { text: 'Complete answer' };
  } }, async () => null);
  const event = { team: config.teamId, channel: config.channelId, owner: config.ownerId };
  await generate({ ...event, text: 'think: work it out' }, []);
  await generate({ ...event, text: 'Hello' }, [{ text: 'think: old request', answer: 'old answer' }]);
  assert.deepEqual(seen, [{ enableThinking: true, maxTokens: 32768 }, { enableThinking: false, maxTokens: 8192 }]);
  await assert.rejects(generate({ ...event, owner: 'UOTHER', text: 'think: private' }, []), /identity_mismatch/);
});

test('thinking survives every tool-loop request even when routing calls it conversational', async () => {
  const seen = [];
  const client = { messages: { create: async body => {
    seen.push(body); return seen.length === 1 ? { content: [{ type: 'tool_use', id: 'one', name: 'unoffered', input: {} }],
      stop_reason: 'tool_use' } : { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
  } } };
  const service = new LLMService({ qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId });
  service._qwenClient = client;
  await service._toolLoop(client, config.modelId, { call: fn => fn() }, 'system', [], [], true,
    'professional', 'UTEST', 'slack:TTEST:CTEST', 'synthetic', 'conversational',
    { enableThinking: true, maxTokens: 32768 });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(body => body.enableThinking === true && body.max_tokens === 32768));
});

function transport(promptTokens = 100) {
  const calls = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: 'rendered including schemas' });
    if (url.endsWith('/tokenize')) return Response.json({ tokens: Array(promptTokens).fill(1) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Final answer',
      reasoning_content: 'PRIVATE INTERNAL REASONING' } }], usage: { completion_tokens: 6000 } });
  };
  return { fetchFn, calls };
}

test('Flash counts rendered input and preserves its full thinking-plus-answer reserve', async () => {
  const { fetchFn, calls } = transport(97280);
  const client = createQwenChatClient({ baseUrl: config.modelUrl, defaultModel: config.modelId, fetchFn });
  const result = await client.messages.create({ messages: [{ role: 'user', content: 'Solve it' }],
    max_tokens: 32768, enableThinking: true, tools: [{ name: 'example', input_schema: { type: 'object' } }] });
  assert.equal(calls.length, 3); assert.equal(calls[0].body.tools[0].function.name, 'example');
  assert.equal(calls[2].body.chat_template_kwargs.enable_thinking, true);
  assert.equal(calls[2].body.max_tokens, 32768);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Final answer' }]);
  const over = transport(97281);
  await assert.rejects(checkFlashContext(config.modelUrl, { messages: [] }, over.fetchFn,
    new AbortController().signal), /budget_exceeded/);
  assert.equal(over.calls.length, 2, 'No generation with an overfull prompt');
  const rejected = await createQwenChatClient({ baseUrl: config.modelUrl, defaultModel: config.modelId,
    fetchFn: over.fetchFn }).messages.create({ messages: [] });
  assert.match(rejected.content[0].text, /not silently cut/);
  assert.equal(inferenceBudget(true).timeoutMs, 1800000);
});

test('overnight research always enables thinking and ignores old 700-token final-answer hints', async () => {
  const { fetchFn, calls } = transport();
  const answer = await backgroundChat(config, new AbortController().signal, fetchFn)('system', 'research', 700);
  assert.equal(answer, 'Final answer');
  assert.equal(calls[2].body.max_tokens, 32768);
  assert.equal(calls[2].body.chat_template_kwargs.enable_thinking, true);
});

test('long finished answers survive Slack formatting intact without exposing internal reasoning', () => {
  const text = 'Complete answer.'.repeat(2000);
  const payload = replyPayload({ channel: 'CTEST' }, text);
  assert.equal(payload.blocks.flatMap(block => block.elements).flatMap(item => item.elements).map(item => item.text).join(''), text);
  assert.ok(payload.blocks.length <= 50);
  assert.throws(() => replyPayload({}, text + 'x'));
  assert.throws(() => replyPayload({}, '<think>internal</think>Answer'));
});
