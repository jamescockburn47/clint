import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvoClient } from '../src/evo-client.js';
const urls = { evoLlmUrl: 'http://fixture', evoClassifierUrl: 'http://classifier', evoPlannerUrl: 'http://planner', evoMemoryUrl: 'http://memory', evoChatModel: 'fixture-model' };

test('gateway requests use the configured model ID and preserve explicit model overrides', async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response('{}'); });
  const client = new EvoClient(urls);
  await client.fetch('http://fixture/v1/chat/completions', { body: '{"messages":[]}' });
  await client.fetch('http://fixture/v1/chat/completions', { body: '{"messages":[],"model":"specific"}' });
  assert.equal(bodies[0].model, 'fixture-model'); assert.equal(bodies[1].model, 'specific');
});
test('gateway model inventory supports health without a JSON /health endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/health') ? new Response('<html>gateway</html>') :
    Response.json({ data: [{ id: 'fixture-model' }] }));
  assert.equal(await new EvoClient(urls).checkLlamaHealth(), true);
  assert.equal(await new EvoClient({ ...urls, evoChatModel: 'missing' }).checkLlamaHealth(), false);
});
test('upstream failures do not expose echoed confidential inputs', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('private synthetic input and credential', { status: 500 }));
  await assert.rejects(new EvoClient(urls).fetch('http://fixture'), error => {
    assert.equal(error.message, 'EVO HTTP 500'); return true;
  });
});
