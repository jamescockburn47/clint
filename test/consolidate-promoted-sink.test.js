import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromotedSink } from '../src/overnight/consolidate-promoted-sink.ts';
import { readSourceLine, groundCandidate } from '../src/overnight/grounded-memory.ts';
import { selectStoreClient } from '../src/overnight/consolidate-shadow-task.ts';

const message = readSourceLine(JSON.stringify({ text: 'I prefer meetings on Fridays.', isBot: false,
  sender: 'Fixture speaker', senderJid: 'speaker', chatJid: 'fixture@g.us', timestamp: '2026-09-12T12:00:00Z' }), 'fixture.jsonl', 1);
const candidate = groundCandidate({ message_id: message.id, category: 'preference' }, [message]);

test('promotion preserves attribution and distinguishes an assertion from a verified fact', async () => {
  let call;
  await new PromotedSink({ deps: { storeMemory: async (...args) => { call = args; return { stored: true }; } } }).storeValidated(candidate);
  assert.match(call[0], /Recorded statement by Fixture speaker \(unverified claim\)/);
  assert.ok(call[0].includes(JSON.stringify(message.text)));
  assert.ok(call[2].includes('chat:fixture@g.us'));
  const provenance = JSON.parse(call[4]);
  assert.deepEqual(provenance.sources, candidate.sources);
  assert.equal(provenance.factual_status, 'unverified_statement');
});
test('offline, queued, absent and failed acknowledgements do not count as persisted', async () => {
  for (const result of [undefined, { queued: true }, { stored: false }, { stored: true, offline: true }, { error: 'private detail' }]) {
    await assert.rejects(new PromotedSink({ deps: { storeMemory: async () => result } }).storeValidated(candidate), /memory_(not_persisted|store_failed)/);
  }
});
test('unsourced model output never reaches the memory service', async () => {
  let calls = 0;
  const sink = new PromotedSink({ deps: { storeMemory: async () => { calls++; return { stored: true }; } } });
  await assert.rejects(sink.storeValidated({ ...candidate, sources: [] }), /not_promotable/);
  await assert.rejects(sink.storeValidated({ ...candidate, verification: undefined }), /not_promotable/);
  assert.equal(calls, 0);
});
test('private DM evidence remains local and cannot enter the globally readable remote memory store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clint-private-'));
  let remoteCalls = 0;
  try {
    const privateMessage = readSourceLine(JSON.stringify({ text: 'Private synthetic matter.', isBot: false,
      senderJid: 'owner', chatJid: 'owner@s.whatsapp.net' }), 'dm.jsonl', 1);
    const privateCandidate = groundCandidate({ message_id: privateMessage.id, category: 'project' }, [privateMessage]);
    const deps = { overnightDir: dir, mode: 'promoted', promotedSinkDeps: { storeMemory: async () => { remoteCalls++; return { stored: true }; } } };
    await selectStoreClient(deps, '2026-09-13').storeValidated(privateCandidate);
    assert.equal(remoteCalls, 0);
    const archive = await readFile(join(dir, (await readdir(dir))[0]), 'utf8');
    assert.ok(archive.includes(privateMessage.hash));
    await assert.rejects(new PromotedSink({ deps: deps.promotedSinkDeps }).storeValidated(privateCandidate), /private_or_unknown/);
    assert.equal(remoteCalls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('both modes archive full provenance, only promoted mode calls the remote store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clint-sink-'));
  try {
    let calls = 0;
    const deps = { overnightDir: dir, promotedSinkDeps: { storeMemory: async () => { calls++; return { stored: true }; } } };
    for (const mode of ['shadow', 'promoted']) {
      await selectStoreClient({ ...deps, mode }, '2026-09-13').storeValidated(candidate);
    }
    assert.equal(calls, 1);
    const files = await readdir(dir);
    const content = await readFile(join(dir, files.find(file => file.endsWith('.jsonl'))), 'utf8');
    assert.ok(content.includes(message.hash));
    assert.ok(content.includes(message.id));
    await selectStoreClient({ ...deps, mode: 'promoted', promotedSinkDeps: undefined }, '2026-09-14').storeValidated(candidate);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
