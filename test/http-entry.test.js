import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
process.env.DASHBOARD_TOKEN = 'synthetic-test-credential';
const { startHttpServer } = await import('../src/http-server.js');

test('real HTTP entry remains observable while WhatsApp is logged out and rejects unauthenticated actions', async () => {
  let channel = 'needs_pairing';
  let sent = 0;
  const server = startHttpServer(0, { getActiveSock: () => null, getChannelState: () => channel,
    getLastActivity: () => 0, sendProactiveMessage: async () => { sent++; }, startWidgetRefresh: () => {} });
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(base + '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: 'degraded', channel: 'needs_pairing' });
    for (const path of ['/debate', '/api/send', '/api/messages', '/api/learning/2026-09-13', '/']) {
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
    }
    assert.equal(sent, 0);
    assert.equal((await fetch(base + '/api/messages', { headers: { authorization: 'Bearer synthetic-test-credential' } })).status, 200);
    assert.equal((await fetch(base + '/api/messages', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    channel = 'connected';
    assert.equal((await fetch(base + '/health')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
