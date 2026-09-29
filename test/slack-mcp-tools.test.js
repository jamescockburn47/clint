import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { getToolsForCategory, CATEGORY } from '../src/router.js';
import { TOOL_DEFINITIONS } from '../src/tools/definitions.js';
import { executeTool } from '../src/tools/handler.js';
import { boundToolResult } from '../src/tool-result.js';
import { McpHttpClient, parseRpcBody } from '../src/mcp-client.js';
import { mcpCall, mcpListTools } from '../src/slack/mcp-tools.js';
import { channelConfigs } from '../src/slack/workspace-channels.js';
import { SLACK_PROMPT_VERSION } from '../src/slack/model.js';
import coreConfig from '../src/config.js';

const base = { teamId: 'TTEAM12345', appId: 'AAPP12345', ownerId: 'UOWNER123', botUserId: 'UBOT12345',
  channelId: 'GPRIVATE12', publicChannelId: 'CPUBLIC123', peerChannelId: 'CPEERLANE1', peerAppId: 'APEERAPP12', policy: { mode: 'open' } };
const [privateConfig, shared, lane] = channelConfigs(base);
const core = { ...coreConfig, evoMemoryEnabled: true };
const scope = (config, actorId, extra = {}) => createConversationContext({ transport: 'slack',
  conversationId: `slack:${base.teamId}:${config.channelId}`, actorId, ownerId: base.ownerId, audience: 'group',
  policy: config.policy, localOnly: true, requestId: 'EvTEST12345', originalRequest: 'Clint, use the MCP server',
  readOnly: config.workspaceShared === true || actorId !== base.ownerId || config.policy?.mode !== 'open', ...extra });
const owner = scope(privateConfig, base.ownerId);
const run = (name, input) => withConversationContext(owner, () => executeTool(name, input, owner.actorId, owner.conversationId));
const MCP = ['mcp_list_tools', 'mcp_call'];

/** A local MCP server. `sse` answers as an event stream and issues a session id that later requests must carry. */
async function server(t, { sse = false, tools, onCall = () => ({ content: [{ type: 'text', text: 'ok' }] }), raw } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') { seen.push({ method: 'DELETE', session: req.headers['mcp-session-id'] ?? null }); res.writeHead(200); res.end(); return; }
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'] ?? null, accept: req.headers.accept, params: msg.params,
        protocol: req.headers['mcp-protocol-version'] ?? null });
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (raw) { raw(req, res, msg); return; }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1' } }
        : msg.method === 'tools/list' ? { tools: tools ?? [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          annotations: { readOnlyHint: true } }, { name: 'delete_all', description: 'Deletes', inputSchema: { type: 'object' } }] }
          : onCall(msg.params);
      const answer = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(msg.method === 'initialize' ? { 'mcp-session-id': 'sess-123' } : {}) });
        res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${answer}\n\n`);
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(answer); }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, seen };
}

test('release is v43; MCP tools are permitted to the owner in the private channel only, and offered in every category', () => {
  assert.equal(SLACK_PROMPT_VERSION, 'clint-shared-core-v43');
  const names = conversation => TOOL_DEFINITIONS.filter(tool => permitsTool(tool.name, undefined, conversation, core));
  for (const category of Object.values(CATEGORY)) {
    for (const name of MCP) assert.ok(getToolsForCategory(category, names(owner)).some(tool => tool.name === name), `${name} ${category}`);
  }
  for (const name of MCP) {
    assert.equal(permitsTool(name, { url: 'https://x.example/mcp' }, owner, core), true);
    for (const [where, conversation] of [['public member', scope(shared, 'UMEMBER123')], ['owner in public', scope(shared, base.ownerId)],
      ['lane', scope(lane, base.ownerId, { webOnly: true, forceRestricted: true })], ['another person in private', scope(privateConfig, 'UOTHER1234')],
      ['owner, colleague policy', scope({ ...privateConfig, policy: { mode: 'colleague' } }, base.ownerId)],
      ['whatsapp owner', createConversationContext({ transport: 'whatsapp', conversationId: 'o@s.whatsapp.net', actorId: 'o', ownerId: 'o', audience: 'direct' })],
      ['no scope', undefined]]) {
      assert.equal(permitsTool(name, undefined, conversation, core), false, `${name}: ${where}`);
    }
  }
});

test('lists and calls tools on a plain JSON server, including a tool that is not read-only (unguarded by decision)', async t => {
  const { url, seen } = await server(t, { onCall: p => ({ content: [{ type: 'text', text: `called ${p.name} with ${JSON.stringify(p.arguments)}` }] }) });
  const listed = JSON.parse(await run('mcp_list_tools', { url }));
  assert.equal(listed.state, 'listed');
  assert.deepEqual(listed.server, { name: 'test-server', version: '1' });
  assert.deepEqual(listed.tools.map(x => [x.name, x.readOnly]), [['lookup', true], ['delete_all', false]]);
  assert.match(listed.tools[0].input_schema, /"q"/);
  const called = JSON.parse(await run('mcp_call', { url, tool: 'lookup', arguments: { q: 'fair and equitable treatment' } }));
  assert.deepEqual([called.state, called.content, called.truncated], ['called', 'called lookup with {"q":"fair and equitable treatment"}', false]);
  const acted = JSON.parse(await run('mcp_call', { url, tool: 'delete_all', arguments: {} }));
  assert.equal(acted.state, 'called');
  assert.ok(seen.some(s => s.method === 'tools/call' && s.params.name === 'delete_all'));
  assert.ok(seen.some(s => s.method === 'notifications/initialized'));
});

test('an SSE server: the answer is taken from the stream and the session id is carried on every later request', async t => {
  const { url, seen } = await server(t, { sse: true });
  const called = JSON.parse(await run('mcp_call', { url, tool: 'lookup', arguments: { q: 'x' } }));
  assert.deepEqual([called.state, called.content], ['called', 'ok']);
  assert.equal(seen[0].method, 'initialize');
  assert.equal(seen[0].session, null);
  assert.match(seen[0].accept, /text\/event-stream/);
  for (const later of seen.slice(1)) assert.equal(later.session, 'sess-123', later.method);
});

test('known-bad: a stream carrying no answer to the request is an error, not an empty success', async t => {
  const { url } = await server(t, { raw: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"jsonrpc":"2.0","id":999,"result":{"tools":[]}}\n\ndata: not json\n\n'); } });
  const listed = JSON.parse(await run('mcp_list_tools', { url }));
  assert.equal(listed.state, 'unavailable');
  assert.equal(listed.error, 'mcp_no_answer_in_stream');
  assert.throws(() => parseRpcBody('data: {"id":2,"result":{}}\n\n', 'text/event-stream', 1), /mcp_no_answer_in_stream/);
});

test('large answers fit the result limit whole: long escaped text is shortened and flagged, a big tool list drops tools and says how many', async t => {
  const long = '"\n'.repeat(30000); // every character doubles when escaped
  const { url } = await server(t, { tools: Array.from({ length: 60 }, (_, i) => ({ name: `tool${i}`, description: 'd'.repeat(2000),
    inputSchema: { type: 'object', properties: { p: { type: 'string', description: 's'.repeat(5000) } } } })),
  onCall: () => ({ content: [{ type: 'text', text: long }, { type: 'image', data: 'AAAA' }] }) });
  const call = await run('mcp_call', { url, tool: 'tool0', arguments: {} });
  assert.ok(call.length <= 24000, String(call.length));
  assert.equal(boundToolResult('mcp_call', call), call, 'passed whole');
  const parsed = JSON.parse(call);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.content.length > 11000, `kept ${parsed.content.length} characters of a text that doubles when escaped`);
  const list = await run('mcp_list_tools', { url });
  assert.equal(boundToolResult('mcp_list_tools', list), list, 'passed whole');
  const listed = JSON.parse(list);
  assert.ok(listed.tools.length > 0 && listed.omitted === 60 - listed.tools.length, JSON.stringify([listed.tools.length, listed.omitted]));
  const image = JSON.parse(await (async () => { const s = await server(t, { onCall: () => ({ content: [{ type: 'image', data: 'AAAA' }] }) });
    return run('mcp_call', { url: s.url, tool: 'lookup' }); })());
  assert.equal(image.content, '[image content not shown]');
});

test('failures come back as a readable state: HTTP error, tool error, nothing listening', async t => {
  const { url: bad } = await server(t, { raw: (req, res) => { res.writeHead(405); res.end(); } });
  assert.deepEqual(JSON.parse(await run('mcp_list_tools', { url: bad })), { state: 'unavailable', error: 'MCP initialize HTTP 405' });
  const { url } = await server(t, { onCall: () => ({ isError: true, content: [{ type: 'text', text: 'Missing required field(s): model' }] }) });
  const toolError = JSON.parse(await run('mcp_call', { url, tool: 'lookup', arguments: {} }));
  assert.deepEqual([toolError.state, toolError.content], ['tool_error', 'Missing required field(s): model']);
  const closed = JSON.parse(await run('mcp_list_tools', { url: 'http://127.0.0.1:9/mcp' }));
  assert.equal(closed.state, 'unavailable');
});

test('the Spire client is unchanged: JSON only, no session header, even when a server sends one', async t => {
  const { url, seen } = await server(t, { raw: (req, res, msg) => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'ignored' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: [] } : { serverInfo: { name: 's' } } }));
  } });
  const client = new McpHttpClient({ url });
  await client.initialize();
  await client.listTools();
  assert.deepEqual(seen.map(s => [s.method, s.accept, s.session, s.protocol]), [['initialize', 'application/json', null, null],
    ['notifications/initialized', 'application/json', null, null], ['tools/list', 'application/json', null, null]]);
  await client.close();
  assert.equal(seen.length, 3, 'close() sends nothing on the Spire path');
});

test('fit keeps as much as fits: plain text is kept to about the limit, and plain text before escape-heavy text survives', async t => {
  const { url } = await server(t, { onCall: () => ({ content: [{ type: 'text', text: 'a'.repeat(30000) }] }) });
  const out = await run('mcp_call', { url, tool: 'lookup' });
  assert.ok(out.length <= 23500 && JSON.parse(out).content.length >= 19000, String(out.length));
  const { url: mixed } = await server(t, { onCall: () => ({ content: [{ type: 'text', text: 'p'.repeat(4000) + '\u0001'.repeat(16000) }] }) });
  const kept = JSON.parse(await run('mcp_call', { url: mixed, tool: 'lookup' }));
  assert.ok(kept.content.startsWith('p'.repeat(4000)), 'the plain prefix is kept');
});

test('scope: with no conversation, or outside the owner private channel, the handlers refuse and contact no server', async t => {
  const { url, seen } = await server(t);
  assert.deepEqual(JSON.parse(await mcpCall({ url, tool: 'lookup' })), { state: 'not_authorized' });
  assert.deepEqual(JSON.parse(await mcpListTools({ url })), { state: 'not_authorized' });
  assert.deepEqual(JSON.parse(await mcpCall({ url, tool: 'lookup' }, { scope: scope(shared, base.ownerId) })), { state: 'not_authorized' });
  assert.deepEqual(JSON.parse(await mcpCall({ url, tool: 'lookup' },
    { scope: scope(lane, base.ownerId, { webOnly: true, forceRestricted: true }) })), { state: 'not_authorized' });
  assert.equal(seen.length, 0);
});

test('mcp_call does not list tools first: a server whose tools/list fails can still be called; each session is ended with DELETE', async t => {
  const { url, seen } = await server(t, { sse: true });
  const called = JSON.parse(await run('mcp_call', { url, tool: 'lookup' }));
  assert.equal(called.state, 'called');
  assert.ok(!seen.some(s => s.method === 'tools/list'));
  assert.deepEqual(seen.at(-1), { method: 'DELETE', session: 'sess-123' });
  const { url: noList } = await server(t, { raw: (req, res, msg) => {
    if (msg.method === 'tools/list') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
      result: msg.method === 'initialize' ? { serverInfo: { name: 's' } } : { content: [{ type: 'text', text: 'answered' }] } }));
  } });
  assert.equal(JSON.parse(await run('mcp_call', { url: noList, tool: 'x' })).content, 'answered');
  assert.equal(JSON.parse(await run('mcp_list_tools', { url: noList })).error, 'MCP tools/list HTTP 500');
});

test('the protocol version is sent on every request after initialise, with or without a session', async t => {
  const { url, seen } = await server(t);
  await run('mcp_list_tools', { url });
  assert.deepEqual(seen.map(s => [s.method, s.protocol]),
    [['initialize', null], ['notifications/initialized', '2025-06-18'], ['tools/list', '2025-06-18']]);
});

test('known-bad: a stream held open after the answer still returns promptly with the answer', async t => {
  const { url } = await server(t, { raw: (req, res, msg) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const result = msg.method === 'initialize' ? { serverInfo: { name: 's' } } : { content: [{ type: 'text', text: 'streamed' }] };
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 200);
    res.on('close', () => clearInterval(ping));
  } });
  const started = Date.now();
  const called = JSON.parse(await run('mcp_call', { url, tool: 'lookup' }));
  assert.deepEqual([called.state, called.content], ['called', 'streamed']);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('known-bad: a server request reusing the id, a JSON answer with the wrong id or no result, and null are not answers', async t => {
  assert.throws(() => parseRpcBody('data: {"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}\n\n', 'text/event-stream', 1),
    /mcp_no_answer_in_stream/);
  assert.equal(parseRpcBody('data: {"id":1,"method":"ping"}\n\ndata: {"id":1,"result":{"ok":true}}\n\n', 'text/event-stream', 1).result.ok, true);
  for (const body of ['{"jsonrpc":"2.0","id":99,"result":{}}', '{"jsonrpc":"2.0","id":1}', '42', 'null', 'not json']) {
    assert.throws(() => parseRpcBody(body, 'application/json', 1), /mcp_invalid_answer/, body);
  }
  const { url } = await server(t, { raw: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":99}'); } });
  assert.deepEqual(JSON.parse(await run('mcp_list_tools', { url })), { state: 'unavailable', error: 'mcp_invalid_answer' });
});

test('known-bad: an answer over 1 MB is refused, not read whole; content that is not a list is read as empty, not thrown', async t => {
  const { url } = await server(t, { raw: (req, res, msg) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'x'.repeat(1_100_000) } } })); } });
  assert.deepEqual(JSON.parse(await run('mcp_list_tools', { url })), { state: 'unavailable', error: 'mcp_response_too_large' });
  const { url: odd } = await server(t, { onCall: () => ({ content: 'hi' }) });
  const called = JSON.parse(await run('mcp_call', { url: odd, tool: 'lookup' }));
  assert.deepEqual([called.state, called.content], ['called', '']);
});

test('a 401 says the server needs authorisation, which is not supported', async t => {
  const { url } = await server(t, { raw: (req, res) => { res.writeHead(401); res.end('no'); } });
  assert.deepEqual(JSON.parse(await run('mcp_list_tools', { url })),
    { state: 'unavailable', error: 'mcp_server_requires_authorisation_not_supported' });
});
