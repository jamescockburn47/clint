import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import esmock from 'esmock';
import * as context from '../src/conversation-context.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { LeakGuard, normalise, SPAN, strings } from '../src/slack/leak-guard.js';
import { precheck, guardedExecuteTool, leakGuard, rememberUrls, urlKnown, canonical } from '../src/slack/flow-guard.js';
import { scanUntrusted, visible } from '../src/slack/injection-guard.js';

const PRIVATE = 'Meeting with Sarah Okafor about the Harbourside settlement figure of £2.4m + costs, venue Room 4B at Fetter Lane';
const SPAN_TEXT = 'the Harbourside settlement figure of £2.4m + costs';
let n = 0;
const convo = (text = 'Clint, read <https://docs.example.com/page|this>', extra = {}) => createConversationContext({
  transport: 'slack', conversationId: extra.id ?? `slack:T:G${++n}`, actorId: 'UOWNER', ownerId: 'UOWNER', audience: 'group',
  policy: { mode: 'open' }, localOnly: true, requestId: 'EvT', originalRequest: text, ...extra, id: undefined });
const words = count => Array.from({ length: count }, (_, i) => ['alpha', 'harbour', 'claim', 'venue', 'ledger', 'north', 'fixture', 'orbit'][(i * 7 + (i >> 3)) % 8] + i).join(' ');
const fresh = () => ({ tainted: null, untrusted: false, outbound: [] });

test('leak guard: a private span is caught raw, re-spaced, URL-, base64- (any alignment, with symbols), hex- (either alignment) and tag-encoded', () => {
  const guard = new LeakGuard();
  guard.record('c1', PRIVATE);
  assert.ok(normalise(SPAN_TEXT).length >= SPAN);
  const b64 = Buffer.from(SPAN_TEXT).toString('base64');
  const hex = Buffer.from(SPAN_TEXT).toString('hex');
  // Tag-encode a span with no '+' or '%', so only tag decoding can reveal it.
  const tag = [...'Meeting with Sarah Okafor about the Harbourside'].map(ch => String.fromCodePoint(0xE0000 + ch.charCodeAt(0))).join('');
  for (const [how, text] of [['raw', `https://x.example/?q=${SPAN_TEXT}`], ['respaced', 'THE harbourside-settlement_figure OF £2 4m + COSTS'],
    ['url', `https://x.example/?q=${encodeURIComponent(SPAN_TEXT)}`], ['double url', encodeURIComponent(encodeURIComponent(SPAN_TEXT))],
    ['base64', b64], ['base64url', Buffer.from(SPAN_TEXT).toString('base64url')], ['base64 after a path', `https://e.com/${b64}`],
    ['base64 misaligned', `?d=A${b64}`], ['hex', hex], ['hex misaligned', `?d=a${hex}`], ['tags', `hello ${tag}`]]) {
    assert.equal(guard.leaks('c1', [text]), true, how);
  }
});

test('leak guard: a JSON result is fingerprinted as its decoded strings, so escaped newlines cannot split a span', () => {
  const guard = new LeakGuard();
  const record = { client: 'Client: Sarah Okafor\n14 Fetter Lane\nLondon EC4A 1BR\nTel 020 7946 0000\nMatter: Kestrel v Harbourside' };
  guard.recordResult('c', JSON.stringify(record));
  assert.equal(guard.leaks('c', ['Sarah Okafor 14 Fetter Lane London EC4A 1BR Tel 020 7946 0000']), true);
});

test('leak guard: owner-typed spans, short spans, other conversations and expired records are not leaks (stated residual)', () => {
  let now = 1_000_000;
  const guard = new LeakGuard({ now: () => now });
  guard.record('c1', PRIVATE);
  assert.equal(guard.leaks('c1', [SPAN_TEXT], `Clint, search for ${SPAN_TEXT}`), false, 'the owner typed it');
  assert.equal(guard.leaks('c1', ['Sarah Okafor Room 4B']), false, 'shorter than SPAN: residual, not caught');
  assert.equal(guard.leaks('c2', [SPAN_TEXT]), false, 'another conversation');
  now += 24 * 3600 * 1000 + 1;
  assert.equal(guard.leaks('c1', [SPAN_TEXT]), false, 'expired after 24 hours');
});

test('property: every span of SPAN or more normalised characters is caught, at any offset (winnowing guarantee)', () => {
  const guard = new LeakGuard();
  const text = words(3000);
  guard.record('c', text);
  const flat = normalise(text);
  let seed = 7;
  const rand = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < 300; i++) {
    const length = SPAN + rand(60);
    const start = rand(flat.length - length);
    assert.equal(guard.leaks('c', [flat.slice(start, start + length)]), true, `offset ${start} length ${length}`);
  }
  assert.equal(guard.leaks('c', ['completely unrelated text about the weather in Leeds today and tomorrow']), false);
});

test('known-bad: private text in an object key, split across array items, or split across calls in one turn is refused', () => {
  const scope = convo('Clint, look this up');
  leakGuard.record(scope.conversationId, PRIVATE);
  const reason = (name, input, state = fresh()) => precheck(name, input, scope, state)?.[0] ?? 'allowed';
  assert.equal(reason('mcp_call', { url: 'https://m.example/mcp', tool: 't', arguments: { [SPAN_TEXT]: 1 } }), 'private_data_in_outbound_request');
  assert.equal(reason('mcp_call', { url: 'https://m.example/mcp', tool: 't', arguments: { parts: SPAN_TEXT.match(/.{1,10}/g) } }), 'private_data_in_outbound_request');
  const state = fresh();
  const pieces = SPAN_TEXT.match(/.{1,12}/g);
  const outcomes = [];
  for (const piece of pieces) {
    const out = reason('web_search', { query: piece }, state);
    outcomes.push(out);
    if (out === 'allowed') state.outbound.push(piece);
  }
  assert.equal(outcomes[0], 'allowed', 'one short piece alone is not a leak');
  const refusedAt = outcomes.indexOf('private_data_in_outbound_request');
  assert.ok(refusedAt > 0, `refused once the pieces add up to a span: ${outcomes}`);
});

test('URL provenance: web_fetch opens only URLs the owner typed or that a tool result showed verbatim; composed URLs are refused', () => {
  const scope = convo('Clint, read <https://docs.example.com/page|this> and https://news.example.org/a.');
  const reason = url => precheck('web_fetch', { url }, scope, fresh())?.[0] ?? 'allowed';
  assert.equal(reason('https://docs.example.com/page'), 'allowed');
  assert.equal(reason('https://news.example.org/a'), 'allowed', 'trailing punctuation is not part of the URL');
  assert.equal(reason('https://docs.example.com/page?d=anything'), 'url_not_from_owner_or_results', 'a named host is not enough');
  assert.equal(reason('https://evil.example/c?d=secret'), 'url_not_from_owner_or_results');
  rememberUrls(scope.conversationId, [JSON.stringify({ results: [{ url: 'https://found.example/story?id=7' }] })]);
  assert.equal(reason('https://found.example/story?id=7'), 'allowed', 'seen verbatim in a result');
  assert.equal(reason('https://found.example/story?id=8'), 'url_not_from_owner_or_results');
  const later = convo('Clint, carry on', { id: scope.conversationId });
  assert.equal(urlKnown('https://found.example/story?id=7', later), true, 'remembered in the conversation');
  assert.equal(urlKnown('https://found.example/story?id=7', later, Date.now() + 25 * 3600 * 1000), false, 'for 24 hours');
});

test('flow rules: untrusted content blocks writes; flagged content limits MCP to the URL the owner typed; web search stays open', () => {
  const scope = convo('Clint, use <https://mcp.example.com/mcp>');
  const check = (name, input, state) => precheck(name, input, scope, { ...fresh(), ...state })?.[0] ?? 'allowed';
  assert.equal(check('task_save', {}, {}), 'allowed');
  assert.equal(check('task_save', {}, { untrusted: true }), 'untrusted_content_restricts_writes');
  assert.equal(check('task_set_status', {}, { untrusted: true }), 'untrusted_content_restricts_writes');
  assert.equal(check('knowledge_search', { query: 'x' }, { untrusted: true, tainted: 'flagged' }), 'allowed');
  assert.equal(check('web_search', { query: 'x' }, { untrusted: true, tainted: 'flagged' }), 'allowed');
  assert.equal(check('mcp_call', { url: 'https://mcp.example.com/mcp', tool: 't' }, { untrusted: true, tainted: 'unscanned' }), 'allowed');
  assert.equal(check('mcp_call', { url: 'https://mcp.example.com/other', tool: 't' }, { untrusted: true, tainted: 'flagged' }), 'untrusted_content_restricts_mcp');
});

test('the real guarded executor: refusals and errors are not untrusted content; a real web result is', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clint-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scope = convo('Clint, list my tasks', { taskStorePath: join(dir, 'owner-tasks.sqlite') });
  const run = (name, input) => withConversationContext(scope, () => guardedExecuteTool(name, input, scope.actorId, scope.conversationId));
  await run('task_list', {});
  assert.equal(JSON.parse(await run('mcp_list_tools', { url: 'https://unnamed.example/mcp' })).reason, 'server_not_named_by_owner');
  assert.equal(JSON.parse(await run('web_fetch', { url: 'https://composed.example/x' })).reason, 'url_not_from_owner_or_results');
  const saved = await run('task_save', { title: 'follow up', details: 'x' });
  assert.notEqual(JSON.parse(saved).reason, 'untrusted_content_restricts_writes', 'refusals did not taint the turn');
});

test('known-bad: in the real tool loop, with the real guard, a private read then a search carrying it never reaches the tool', async () => {
  const calls = [];
  const privateResult = JSON.stringify({ state: 'snapshot', records: [{ id: 's1', text: PRIVATE }] });
  const { LLMService } = await esmock('../src/claude.js', {}, {
    '../src/tools/handler.js': { executeTool: async name => { calls.push(name); return name === 'knowledge_read' ? privateResult : '{"results":[]}'; } },
    '../src/usage-tracker.js': { trackTokens: () => {} },
    // The real module, shared, so the guard inside the mocked tree reads the scope this test sets.
    '../src/conversation-context.js': { ...context },
  });
  const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:T:GLOOP', actorId: 'UOWNER', ownerId: 'UOWNER', audience: 'group',
    policy: { mode: 'open' }, localOnly: true, requestId: 'EvLoop', originalRequest: 'Clint, what does the record say?' });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic' });
  const requests = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'knowledge_read', input: { id: 's1' } }], usage: {} },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'web_search', input: { query: SPAN_TEXT } }], usage: {} },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} },
  ];
  const client = { messages: { create: async input => { requests.push(structuredClone(input)); return replies.shift(); } } };
  service._qwenClient = client;
  await withConversationContext(scope, () => service._toolLoop(client, 'synthetic', { call: fn => fn() }, [], [],
    [{ name: 'knowledge_read' }, { name: 'web_search' }], true, 'professional', 'UOWNER', 'slack:T:GLOOP', 'EvLoop', 'recall'));
  assert.deepEqual(calls, ['knowledge_read'], 'the search never reached the tool');
  assert.equal(JSON.parse(requests[2].messages.at(-1).content[0].content).reason, 'private_data_in_outbound_request');
});

test('other transports pass straight through the guard', async () => {
  const whatsapp = createConversationContext({ transport: 'whatsapp', conversationId: 'o@s.whatsapp.net', actorId: 'o', ownerId: 'o', audience: 'direct' });
  const out = await withConversationContext(whatsapp, () => guardedExecuteTool('no_such_tool', {}, 'o', 'o@s.whatsapp.net'));
  assert.equal(out, 'Unknown tool: no_such_tool');
});

test('the classifier client: flags restrict; a wrong-shaped answer, an HTTP error, no service or too much input read as unscanned', async () => {
  const answer = body => async () => new Response(JSON.stringify(body), { status: 200 });
  assert.equal((await scanUntrusted(['a', 'b'], { fetchImpl: answer({ results: [{ flagged: false, score: 0.1 }, { flagged: true, score: 0.99 }] }) })).state, 'flagged');
  assert.equal((await scanUntrusted(['a'], { fetchImpl: answer({ results: [{ flagged: false, score: 0.1 }] }) })).state, 'clean');
  assert.equal((await scanUntrusted(['a', 'b'], { fetchImpl: answer({ results: [{ flagged: false }] }) })).state, 'unscanned');
  assert.equal((await scanUntrusted(['a'], { fetchImpl: answer({ results: [{ flagged: 'no' }] }) })).state, 'unscanned');
  assert.equal((await scanUntrusted(['a'], { fetchImpl: async () => new Response('x', { status: 500 }) })).state, 'unscanned');
  assert.equal((await scanUntrusted(['a'], { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).state, 'unscanned');
  assert.equal((await scanUntrusted(['x'.repeat(400001)], { fetchImpl: answer({}) })).state, 'unscanned');
  assert.equal((await scanUntrusted(Array(257).fill('a'), { fetchImpl: answer({}) })).state, 'unscanned');
  let called = false;
  assert.equal((await scanUntrusted(['', null], { fetchImpl: async () => { called = true; } })).state, 'clean');
  assert.equal(called, false);
  assert.equal(visible('a\u200Bb\u{E0041}c\uFE0Fd\u00ADe\x1b[31mf\ng'), 'abcdef\ng');
});

test('every Slack tool call goes through the guard: claude.js imports the guarded executor as executeTool', () => {
  const source = readFileSync(new URL('../src/claude.js', import.meta.url), 'utf8');
  assert.match(source, /^import \{ guardedExecuteTool as executeTool \} from '\.\/slack\/flow-guard\.js';/m);
  assert.doesNotMatch(source, /from '\.\/tools\/handler\.js'/);
});

test('strings() returns object keys as well as values, numbers as text, and array items in order', () => {
  assert.deepEqual(strings({ a: 'x', secretKey: [1, 'y'], nested: { k: 'z' } }), ['a', 'x', 'secretKey', '1', 'y', 'nested', 'k', 'z']);
});

test('known-bad (C1): a known URL with anything appended, even punctuation, is not known; the tool is sent exactly what was checked', () => {
  const scope = convo('Clint, read https://owner.example/a. Thanks');
  rememberUrls(scope.conversationId, ['{"url":"https://found.example/story?id=7"}']);
  const reason = url => precheck('web_fetch', { url }, scope, fresh())?.[0] ?? 'allowed';
  assert.equal(reason('https://owner.example/a'), 'allowed', 'sentence punctuation after an owner link');
  assert.equal(reason('https://found.example/story?id=7'), 'allowed');
  for (const suffix of ['.', '..', ')', '!?', "'", ';;.']) assert.equal(reason(`https://found.example/story?id=7${suffix}`), 'url_not_from_owner_or_results', suffix);
  assert.equal(canonical('HTTPS://Found.Example/story?id=7'), 'https://found.example/story?id=7');
});

test('a long link from a private result can be opened: a known URL is not itself treated as a leak', () => {
  const scope = convo('Clint, open the link in my calendar entry');
  const link = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
  leakGuard.recordResult(scope.conversationId, JSON.stringify({ event: `Board pack ${link}` }));
  rememberUrls(scope.conversationId, [JSON.stringify({ event: `Board pack ${link}` })]);
  assert.equal(precheck('web_fetch', { url: link }, scope, fresh()), null);
  assert.equal(precheck('web_search', { query: link }, scope, fresh())?.[0], 'private_data_in_outbound_request', 'but not as a search query');
});

test('after a private read, at most 3 links from results are opened in one message; owner links are not counted', () => {
  const scope = convo('Clint, read <https://owner.example/x>');
  rememberUrls(scope.conversationId, ['https://r.example/1 https://r.example/2']);
  const state = { ...fresh(), private: true, fetchedAfterPrivate: 3 };
  assert.equal(precheck('web_fetch', { url: 'https://r.example/1' }, scope, state)?.[0], 'fetch_limit_after_private_read');
  assert.equal(precheck('web_fetch', { url: 'https://owner.example/x' }, scope, state), null);
  assert.equal(precheck('web_fetch', { url: 'https://r.example/2' }, scope, { ...state, fetchedAfterPrivate: 2 }), null);
});

test('known-bad (M4): scan flags keep their positions when a text is empty', async () => {
  const fetchImpl = async (url, options) => new Response(JSON.stringify({ results: JSON.parse(options.body).texts.map(() => ({ flagged: true, score: 1 })) }));
  const out = await scanUntrusted(['', 'server name'], { fetchImpl });
  assert.deepEqual(out.flags, [false, true]);
});

test('known-bad (N1): in sequence through the real guarded executor, a long private link opens, continues, and later searches still run', async () => {
  const link = 'https://docs.google.com/document/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit';
  const sent = [];
  const { guardedExecuteTool: guarded } = await esmock('../src/slack/flow-guard.js', {}, {
    '../src/tools/handler.js': { executeTool: async (name, input) => { sent.push([name, input]);
      return name === 'calendar_read_events' ? JSON.stringify({ events: [{ title: 'Board pack', description: link }] }) : '{"text":"page"}'; } },
    '../src/slack/injection-guard.js': { scanUntrusted: async () => ({ state: 'clean', score: 0, flags: [false] }), scannable: t => t },
    '../src/conversation-context.js': { ...context },
  });
  const scope = convo('Clint, open the board pack link from my calendar');
  const run = (name, input) => withConversationContext(scope, () => guarded(name, input, scope.actorId, scope.conversationId));
  await run('calendar_read_events', { date: '2026-10-01' });
  assert.equal(await run('web_fetch', { url: link }), '{"text":"page"}');
  assert.equal(await run('web_fetch', { url: link, offset: 8000, source_hash: 'a'.repeat(64) }), '{"text":"page"}', 'continuation');
  assert.equal(await run('web_search', { query: 'board pack template' }), '{"text":"page"}', 'an unrelated search');
  const leak = JSON.parse(await run('web_search', { query: link }));
  assert.equal(leak.reason, 'private_data_in_outbound_request', 'the link as a search query is still a leak');
  assert.deepEqual(sent.map(([name]) => name), ['calendar_read_events', 'web_fetch', 'web_fetch', 'web_search']);
  assert.equal(sent[1][1].url, link, 'sent exactly the checked URL');
});

test('the 3-link cap applies from the start of every turn; links the owner typed are not counted', async () => {
  const { guardedExecuteTool: guarded } = await esmock('../src/slack/flow-guard.js', {}, {
    '../src/tools/handler.js': { executeTool: async () => 'https://r.example/1 https://r.example/2 https://r.example/3 https://r.example/4' },
    '../src/slack/injection-guard.js': { scanUntrusted: async () => ({ state: 'clean', score: 0, flags: [false] }), scannable: t => t },
    '../src/conversation-context.js': { ...context },
  });
  const scope = convo('Clint, read <https://owner.example/x>');
  const run = (name, input) => withConversationContext(scope, () => guarded(name, input, scope.actorId, scope.conversationId));
  await run('web_search', { query: 'things' });
  for (const i of [1, 2, 3]) assert.doesNotMatch(await run('web_fetch', { url: `https://r.example/${i}` }), /refused/, `link ${i}`);
  assert.equal(JSON.parse(await run('web_fetch', { url: 'https://r.example/4' })).reason, 'fetch_limit_after_private_read');
  assert.doesNotMatch(await run('web_fetch', { url: 'https://owner.example/x' }), /refused/, 'owner link');
});
