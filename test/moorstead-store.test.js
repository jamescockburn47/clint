import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/moorstead/store.js';

describe('moorstead/store', () => {
  let dir, store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'moor-store-')); store = createStore({ dataDir: dir }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records an event and returns it with its ts', () => {
    const e = store.recordEvent({ type: 'join', room: 'moor', pid: 'a1', name: 'Alice', ts: 1718000000000 });
    assert.equal(e.type, 'join');
    assert.equal(e.ts, 1718000000000);
  });

  it('defaults a missing ts to a number', () => {
    const e = store.recordEvent({ type: 'edit', room: 'moor', pid: 'a1' });
    assert.equal(typeof e.ts, 'number');
  });

  it('tracks room presence on join/leave', () => {
    store.recordEvent({ type: 'join', room: 'moor', pid: 'a1', ts: 1 });
    store.recordEvent({ type: 'join', room: 'moor', pid: 'a2', ts: 2 });
    assert.equal(store.roomCount('moor'), 2);
    store.recordEvent({ type: 'leave', room: 'moor', pid: 'a1', ts: 3 });
    assert.equal(store.roomCount('moor'), 1);
    assert.deepEqual(store.roomPresence('moor'), ['a2']);
  });

  it('filters recent events by room and sinceTs', () => {
    store.recordEvent({ type: 'edit', room: 'moor', pid: 'a1', ts: 10 });
    store.recordEvent({ type: 'edit', room: 'dale', pid: 'a2', ts: 20 });
    assert.equal(store.recentEvents({ room: 'moor' }).length, 1);
    assert.equal(store.recentEvents({ sinceTs: 15 }).length, 1);
  });

  it('persists events to a dated JSONL file', () => {
    store.recordEvent({ type: 'join', room: 'moor', pid: 'a1', ts: 1718000000000 });
    const day = new Date(1718000000000).toISOString().slice(0, 10);
    const f = join(dir, `events-${day}.jsonl`);
    assert.ok(existsSync(f));
    assert.match(readFileSync(f, 'utf8'), /"type":"join"/);
  });

  it('ignores presence for a join with no pid', () => {
    store.recordEvent({ type: 'join', room: 'moor', ts: 1 });
    assert.equal(store.roomCount('moor'), 0);
  });
});
