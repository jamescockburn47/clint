import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryClient } from '../src/memory.js';

const online = async () => ({ status: 'online', results: [{ memory: { fact: 'x', chatJid: 'other@g.us' } }] });

test('a disabled memory client never contacts or queues for the archive', async () => {
  let fetches = 0;
  const client = new MemoryClient({ memoryUrl: 'http://127.0.0.1:1', enabled: false,
    fetchJSON: async () => { fetches++; return online(); }, fetchRaw: null });
  const depth = client._getQueueDepth();
  assert.equal(await client.checkHealth(), null);
  assert.equal(client.isOnline(), false);
  assert.deepEqual(await client.store('fact', 'general', [], 0.5, 'test'), { stored: false, offline: true, disabled: true });
  assert.equal(client._getQueueDepth(), depth);
  assert.deepEqual(await client.search('anything'), []);
  assert.equal(fetches, 0);
});

test('queueOnFailure=false reports an unpersisted write instead of leaving a duplicate for the drain', async () => {
  const client = new MemoryClient({ memoryUrl: 'http://127.0.0.1:1', fetchRaw: null,
    fetchJSON: async (url) => { if (url.endsWith('/health')) return online(); throw new Error('ECONNREFUSED'); } });
  const depth = client._getQueueDepth();
  await client.checkHealth({ recover: false });
  assert.equal(client.isOnline(), true);
  assert.deepEqual(await client.store('fact', 'general', [], 0.5, 'test', { queueOnFailure: false }), { stored: false, offline: true });
  assert.equal(client._getQueueDepth(), depth);
});
