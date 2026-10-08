// Proves src/mcp-client.js speaks the exact wire shape of The Spire's /mcp
// endpoint (relay/mcp-http.mjs): bearer auth, plain application/json responses,
// tool results encoded as a JSON string in a text content block, and 202-no-body
// notifications. Self-contained — a tiny inline HTTP server, no network, no deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpHttpClient } from '../src/mcp-client.js';

const KEY = 'test-key';
const okContent = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

// A minimal stand-in for relay/mcp-http.mjs: same auth + JSON-RPC + content shape.
function makeServer() {
  return http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    const key = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    if (key !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_token' })); return; }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw || '{}');
      const rpc = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      const rpcErr = (code, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })); };
      if (method === 'initialize') return rpc({ protocolVersion: '2025-06-18', serverInfo: { name: 'spire', version: '0.3.0' }, capabilities: { tools: {} } });
      if (method?.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      if (method === 'tools/list') return rpc({ tools: [{ name: 'spire_await_event' }, { name: 'spire_say' }, { name: 'spire_status' }] });
      if (method === 'tools/call') {
        const name = params?.name;
        if (name === 'spire_status') return rpc(okContent({ reachable: true, keyValid: true, connected: true, floor: 'lobby' }));
        if (name === 'spire_say') return rpc(okContent({ ok: true, said: params.arguments?.text }));
        if (name === 'spire_boom') return rpc({ content: [{ type: 'text', text: JSON.stringify({ error: 'denied' }) }], isError: true });
        return rpc(okContent({ none: true }));
      }
      return rpcErr(-32601, `Method not found: ${method}`);
    });
  });
}

async function withServer(fn) {
  const server = makeServer();
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try { await fn(`http://127.0.0.1:${port}/mcp`); } finally { await new Promise((r) => server.close(r)); }
}

test('initialize captures serverInfo and the notification does not throw', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    const init = await c.initialize();
    assert.equal(init.serverInfo.name, 'spire');
    assert.equal(c.serverInfo.name, 'spire');
  });
});

test('tools/list returns the venue tools', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    const tools = await c.listTools();
    assert.ok(tools.map((t) => t.name).includes('spire_await_event'));
  });
});

test('callTool unwraps the JSON text content block into data', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    const { data, isError } = await c.callTool('spire_status', {});
    assert.equal(isError, false);
    assert.equal(data.connected, true);
    assert.equal(data.floor, 'lobby');
  });
});

test('callTool round-trips arguments', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    const { data } = await c.callTool('spire_say', { text: 'At your service.' });
    assert.equal(data.said, 'At your service.');
  });
});

test('callTool surfaces isError with the error payload in data', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    const { data, isError } = await c.callTool('spire_boom', {});
    assert.equal(isError, true);
    assert.equal(data.error, 'denied');
  });
});

test('a bad bearer key throws unauthorized', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: 'Bearer wrong' } });
    await assert.rejects(() => c.initialize(), /unauthorized/i);
  });
});

test('an RPC-level error is thrown', async () => {
  await withServer(async (url) => {
    const c = new McpHttpClient({ url, headers: { authorization: `Bearer ${KEY}` } });
    await assert.rejects(() => c._rpc('nonsense/method', {}), /Method not found/);
  });
});
