import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.MOORSTEAD_ENABLED = 'true';
// Clean slate so the task's persisted lastDigestDate doesn't make this flaky
// on a same-day re-run. Runs at file load, before the dynamic import below.
rmSync(join('data', 'moorstead-digest-state.json'), { force: true });

let checkMoorsteadDigest, store;
async function load() {
  ({ checkMoorsteadDigest } = await import('../src/tasks/moorstead-digest.js'));
  store = (await import('../src/moorstead/store.js')).default;
}

describe('moorstead-digest task', () => {
  beforeEach(async () => { if (!checkMoorsteadDigest) await load(); });

  it('sends a digest after the digest hour when events exist', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(today + 'T00:00:00Z').getTime();
    store.recordEvent({ type: 'join', name: 'Zara', room: 'moor', ts: startOfDay + 1000 });
    store.recordEvent({ type: 'edit', name: 'Zara', room: 'moor', ts: startOfDay + 2000 });
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), today, 20, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Moorstead — digest/);
    assert.match(sent[0], /Zara/);
  });

  it('does not send twice on the same day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), today, 20, 0);
    assert.equal(sent.length, 0);
  });

  it('does not send before the digest hour', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), tomorrow, 9, 0);
    assert.equal(sent.length, 0);
  });
});
