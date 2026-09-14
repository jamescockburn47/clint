// test/qwen-chat.test.js — Anthropic ↔ OpenAI translation layer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  createQwenChatClient,
  translateOpenAIResponseToAnthropic,
  flattenSystem,
  translateMessages,
  translateTools,
} = await import('../src/qwen-chat.js');

describe('flattenSystem', () => {
  it('returns empty string for null/undefined', () => {
    assert.equal(flattenSystem(null), '');
    assert.equal(flattenSystem(undefined), '');
  });
  it('passes through strings', () => {
    assert.equal(flattenSystem('hello'), 'hello');
  });
  it('joins array-of-text-blocks with blank lines, ignoring cache_control', () => {
    const sys = [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
    ];
    assert.equal(flattenSystem(sys), 'A\n\nB');
  });
});

describe('translateMessages', () => {
  it('converts user text (string or blocks) to OpenAI user message', () => {
    const out = translateMessages([
      { role: 'user', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'world' }] },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]);
  });

  it('converts assistant text + tool_use blocks to OpenAI tool_calls', () => {
    const anthropicAssistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling a tool...' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
    };
    const out = translateMessages([anthropicAssistant]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].content, 'Calling a tool...');
    assert.equal(out[0].tool_calls.length, 1);
    assert.equal(out[0].tool_calls[0].function.name, 'search');
    assert.equal(out[0].tool_calls[0].function.arguments, '{"q":"x"}');
  });

  it('splits user tool_result blocks into separate tool-role messages', () => {
    const out = translateMessages([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'result 1' },
        { type: 'tool_result', tool_use_id: 'call_2', content: { structured: true } },
      ],
    }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'tool');
    assert.equal(out[0].tool_call_id, 'call_1');
    assert.equal(out[0].content, 'result 1');
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].content, '{"structured":true}');
  });
});

describe('translateTools', () => {
  it('returns undefined for empty/missing', () => {
    assert.equal(translateTools(undefined), undefined);
    assert.equal(translateTools([]), undefined);
  });
  it('wraps each Anthropic tool in OpenAI function envelope', () => {
    const anthropicTools = [
      { name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    ];
    const out = translateTools(anthropicTools);
    assert.deepEqual(out, [{
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    }]);
  });
});

describe('translateOpenAIResponseToAnthropic', () => {
  it('translates a pure-text finish into Anthropic end_turn', () => {
    const oai = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    };
    const out = translateOpenAIResponseToAnthropic(oai);
    assert.deepEqual(out.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out.usage.input_tokens, 10);
    assert.equal(out.usage.output_tokens, 3);
  });

  it('translates tool_calls into Anthropic tool_use + stop_reason=tool_use', () => {
    const oai = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":"foo"}' } },
          ],
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    };
    const out = translateOpenAIResponseToAnthropic(oai);
    assert.equal(out.stop_reason, 'tool_use');
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, 'tool_use');
    assert.equal(out.content[0].name, 'search');
    assert.deepEqual(out.content[0].input, { q: 'foo' });
  });

  it('survives malformed tool_call arguments by capturing the raw string', () => {
    const oai = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            { id: 'call_b', function: { name: 'x', arguments: 'not-json,oops' } },
          ],
        },
      }],
      usage: {},
    };
    const out = translateOpenAIResponseToAnthropic(oai);
    assert.equal(out.content[0].input._raw, 'not-json,oops');
  });

  it('emits a fresh id when the upstream omits tool_calls[].id', () => {
    const oai = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{ function: { name: 'x', arguments: '{}' } }],
        },
      }],
      usage: {},
    };
    const out = translateOpenAIResponseToAnthropic(oai);
    assert.ok(out.content[0].id && out.content[0].id.length > 0);
  });
});

describe('createQwenChatClient — end-to-end via mocked fetch', () => {
  function mockFetchOnce(oaiResponse) {
    let seenUrl = null;
    let seenPayload = null;
    const fetchFn = async (url, init) => {
      seenUrl = url;
      seenPayload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => oaiResponse,
        text: async () => JSON.stringify(oaiResponse),
      };
    };
    return { fetchFn, getSeenUrl: () => seenUrl, getSeenPayload: () => seenPayload };
  }

  it('constructs a client and routes an end-turn request through the adapter', async () => {
    const mock = mockFetchOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'yes' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
    const client = createQwenChatClient({ baseUrl: 'http://localhost:8080', fetchFn: mock.fetchFn });
    const res = await client.messages.create({
      model: 'qwen3.6-27b',
      max_tokens: 128,
      system: 'You are Clint.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(res.stop_reason, 'end_turn');
    assert.equal(res.content[0].text, 'yes');
    assert.equal(mock.getSeenUrl(), 'http://localhost:8080/v1/chat/completions');
    const payload = mock.getSeenPayload();
    assert.equal(payload.messages[0].role, 'system');
    assert.equal(payload.messages[1].role, 'user');
    assert.equal(payload.cache_prompt, true);
    assert.equal(payload.chat_template_kwargs, undefined);
    await client.messages.create({ messages: [{ role: 'user', content: 'Hi' }], enableThinking: false });
    assert.deepEqual(mock.getSeenPayload().chat_template_kwargs, { enable_thinking: false });
  });

  it('includes translated tools when provided', async () => {
    const mock = mockFetchOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
      usage: {},
    });
    const client = createQwenChatClient({ baseUrl: 'http://localhost:8080', fetchFn: mock.fetchFn });
    await client.messages.create({
      model: 'q', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
    });
    const payload = mock.getSeenPayload();
    assert.equal(payload.tool_choice, 'auto');
    assert.equal(payload.tools[0].function.name, 'search');
  });

  it('throws on non-2xx so LLMService fallback can kick in', async () => {
    const fetchFn = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const client = createQwenChatClient({ baseUrl: 'http://localhost:8080', fetchFn });
    await assert.rejects(
      client.messages.create({ messages: [{ role: 'user', content: 'hi' }] }),
      /qwen-chat 500/,
    );
  });

  it('requires baseUrl', () => {
    assert.throws(() => createQwenChatClient({}), /baseUrl required/);
  });
});
