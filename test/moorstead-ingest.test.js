import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/moorstead/store.js';
import { ingestMoorsteadEvent, validateEvent } from '../src/moorstead/ingest.js';

describe('moorstead/ingest', () => {
  let store, sent;
  const send = (t) => { sent.push(t); };
  beforeEach(() => {
    store = createStore({ dataDir: mkdtempSync(join(tmpdir(), 'moor-ingest-')) });
    sent = [];
  });

  it('rejects an event with a bad type', () => {
    assert.match(validateEvent({ type: 'nope', room: 'moor' }), /invalid type/);
  });

  it('rejects an event with no room', () => {
    assert.match(validateEvent({ type: 'join' }), /room required/);
  });

  it('sends an immediate ping for a notable join', async () => {
    const r = await ingestMoorsteadEvent({ type: 'join', name: 'Alice', room: 'moor', ts: 1 }, { send, store });
    assert.equal(r.ok, true);
    assert.equal(r.notified, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Alice joined moor/);
  });

  it('does not ping for a routine edit', async () => {
    const r = await ingestMoorsteadEvent({ type: 'edit', name: 'Alice', room: 'moor', ts: 1 }, { send, store });
    assert.equal(r.ok, true);
    assert.equal(r.notified, false);
    assert.equal(sent.length, 0);
  });

  it('sends a session digest when a leave empties the room', async () => {
    await ingestMoorsteadEvent({ type: 'join', name: 'Alice', room: 'moor', pid: 'a1', ts: 1 }, { send, store });
    sent.length = 0;
    await ingestMoorsteadEvent({ type: 'leave', name: 'Alice', room: 'moor', pid: 'a1', ts: 2 }, { send, store });
    assert.ok(sent.some((m) => /left moor/.test(m)), 'leave ping');
    assert.ok(sent.some((m) => /moor is now empty/.test(m)), 'session digest');
  });

  it('returns an error result for invalid events without throwing', async () => {
    const r = await ingestMoorsteadEvent({ type: 'bad', room: 'moor' }, { send, store });
    assert.equal(r.ok, false);
    assert.equal(sent.length, 0);
  });

  it('does not throw when send fails; the event is still stored', async () => {
    const boom = () => { throw new Error('whatsapp down'); };
    const r = await ingestMoorsteadEvent({ type: 'join', name: 'Alice', room: 'moor', pid: 'a1', ts: 1 }, { send: boom, store });
    assert.equal(r.ok, true);
    assert.equal(r.notified, false);
    assert.equal(store.roomCount('moor'), 1);
  });
});
