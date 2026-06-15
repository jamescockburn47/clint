import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.MOORSTEAD_ENABLED = 'true';
rmSync(join('data', 'moorstead-digest-state.json'), { force: true });

const DAY = '2026-06-15';                       // BST: London = UTC+1
const utcMidnight = Date.parse(DAY + 'T00:00:00Z');

let checkMoorsteadDigest, store;
async function load() {
  ({ checkMoorsteadDigest } = await import('../src/tasks/moorstead-digest.js'));
  store = (await import('../src/moorstead/store.js')).default;
}

describe('moorstead-digest task', () => {
  beforeEach(async () => { if (!checkMoorsteadDigest) await load(); });

  it('sends a digest after the digest hour, scoped to the London day', async () => {
    // 22:00 London on the PREVIOUS day -> must be excluded.
    store.recordEvent({ type: 'join', name: 'Ghost', room: 'moor', ts: utcMidnight - 2 * 3600000 });
    // 14:00 London on DAY -> included.
    store.recordEvent({ type: 'join', name: 'Zara', room: 'moor', ts: utcMidnight + 13 * 3600000 });
    store.recordEvent({ type: 'edit', name: 'Zara', room: 'moor', ts: utcMidnight + 13 * 3600000 + 1000 });
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), DAY, 20, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Moorstead — digest/);
    assert.match(sent[0], /Zara/);
    assert.doesNotMatch(sent[0], /Ghost/);
  });

  it('does not send twice on the same day', async () => {
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), DAY, 20, 0);
    assert.equal(sent.length, 0);
  });

  it('does not send before the digest hour', async () => {
    const sent = [];
    await checkMoorsteadDigest((t) => sent.push(t), '2026-06-16', 9, 0);
    assert.equal(sent.length, 0);
  });
});
