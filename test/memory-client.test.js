import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryClient } from '../src/memory.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const online = async () => ({ status: 'online', results: [{ memory: { fact: 'x', chatJid: 'other@g.us' } }] });

test('a disabled memory client never contacts, reads cached facts or queues for the archive', async t => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'clint-disabled-memory-'));
  t.after(() => { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); });
  process.chdir(dir);
  mkdirSync('data/memory-queue/text', { recursive: true });
  const cache = JSON.stringify({ memories: [{ fact: 'SYNTHETIC_PRIVATE_FACT', category: 'general' }], timestamp: 1 });
  const pending = JSON.stringify({ type: 'note', text: 'SYNTHETIC_PENDING_NOTE', source: 'fixture' });
  writeFileSync('data/memory-cache.json', cache);
  writeFileSync('data/memory-queue/text/pending.json', pending);
  let fetches = 0;
  const client = new MemoryClient({ memoryUrl: 'http://127.0.0.1:1', enabled: false,
    fetchJSON: async () => { fetches++; return online(); }, fetchRaw: null });
  const depth = client._getQueueDepth();
  assert.equal(await client.checkHealth(), null);
  assert.equal(client.isOnline(), false);
  assert.deepEqual(await client.store('fact', 'general', [], 0.5, 'test'), { stored: false, offline: true, disabled: true });
  assert.deepEqual(await client.storeNote('new note'), { stored: false, offline: true, disabled: true });
  await client.syncCache();
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(await client.extractWithoutStoring('source'), { extracted: [], offline: true });
  assert.equal(await client.analyseImage(Buffer.from('fixture')), null);
  assert.equal(await client.transcribeAudio(Buffer.from('fixture')), null);
  assert.equal(client._getQueueDepth(), depth);
  assert.deepEqual(await client.search('anything'), []);
  assert.equal(fetches, 0);
  assert.equal(readFileSync('data/memory-cache.json', 'utf8'), cache);
  assert.equal(readFileSync('data/memory-queue/text/pending.json', 'utf8'), pending);
  const enabled = new MemoryClient({ memoryUrl: 'http://127.0.0.1:1', fetchJSON: async () => online(), fetchRaw: null });
  assert.equal((await enabled.list()).length, 1, 'fixture proves cached data exists when enabled');
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
