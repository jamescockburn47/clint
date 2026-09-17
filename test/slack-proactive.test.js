import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProactiveWorker, localSchedule, proactiveScope } from '../src/slack/proactive.js';
import { ProactiveStore } from '../src/slack/proactive-store.js';
import { proactiveRead } from '../src/slack/proactive-tools.js';
import { createConversationContext, currentConversation, withConversationContext } from '../src/conversation-context.js';
import { backgroundChat } from '../src/slack/background-model.js';
import { sourceReadReceipt } from '../src/slack/proactive-research.js';

function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-proactive-'));
  let now = Date.parse('2026-09-15T06:01:00Z');
  const config = { dataDir: dir, proactiveEnabled: true, policy: { mode: 'open' },
    teamId: 'TTEST12345', channelId: 'CTEST12345', ownerId: 'UTEST12345', modelUrl: 'http://127.0.0.1:11437', modelId: 'synthetic' };
  const store = new ProactiveStore(join(dir, 'data', 'proactive'));
  const sent = [];
  const worker = new ProactiveWorker({ config, store, now: () => now, interactive: { running: null },
    inbox: { next: () => null, recentStatements: () => [] }, authorize: async () => true,
    web: { chat: { postMessage: async payload => { sent.push(payload); return { ok: true, channel: config.channelId, ts: '1789440000.000001' }; } } },
    chat: () => async () => 'unused', research: async () => ({ date: '2026-09-15', hypotheses: [] }),
    briefing: async () => { assert.equal(currentConversation().privateContext, true); return { text: 'Morning briefing. No researched findings today.' }; },
    ...overrides });
  t.after(async () => { await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  worker.lastInput = now - 16 * 60000;
  return { worker, store, config, sent, advance: ms => { now += ms; } };
}

test('London schedule uses DST and a durable briefing sends only once', async t => {
  assert.deepEqual(localSchedule(Date.parse('2026-09-15T06:00:00Z')), { date: '2026-09-15', minute: 420 });
  assert.deepEqual(localSchedule(Date.parse('2026-12-15T07:00:00Z')), { date: '2026-12-15', minute: 420 });
  const { worker, sent, store } = setup(t);
  await worker.tick(); await worker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].thread_ts, undefined);
  assert.equal(sent[0].blocks[0].type, 'rich_text');
  assert.equal(store.get('2026-09-15:briefing').state, 'sent');
});

test('foreground priority cancels inference and preserves retry capacity', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { worker, store, sent } = setup(t, { briefing: async ({ signal }) => {
    started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const run = worker.tick(); await ready; worker.interrupt(); await run;
  assert.equal(sent.length, 0);
  const job = store.get('2026-09-15:briefing');
  assert.equal(job.state, 'pending'); assert.equal(job.attempts, 0);
  assert.equal(job.error, 'foreground_priority');
});

test('changed channel membership after generation blocks delivery', async t => {
  let checks = 0;
  const { worker, sent, store } = setup(t, { authorize: async () => ++checks === 1 });
  await worker.tick();
  assert.equal(sent.length, 0); assert.equal(store.get('2026-09-15:briefing').state, 'blocked');
});

test('invalid generated control text retries generation instead of poisoning the saved ready report', async t => {
  let generations = 0;
  const { worker, store, sent, advance } = setup(t, { briefing: async () => ({ text:
    ++generations === 1 ? '<think>internal</think>Unusable output' : 'A usable morning briefing.' }) });
  await worker.tick();
  assert.equal(store.get('2026-09-15:briefing').state, 'pending');
  assert.equal(sent.length, 0);
  advance(16 * 60000); await worker.tick();
  assert.equal(generations, 2); assert.equal(sent.length, 1);
  assert.equal(store.get('2026-09-15:briefing').state, 'sent');
});

test('temporary authorisation lookup failure retains a valid ready report for later delivery', async t => {
  let checks = 0, generations = 0;
  const { worker, store, sent, advance } = setup(t, { authorize: async () => {
    if (++checks === 2) throw new Error('temporary network error'); return true;
  }, briefing: async () => { generations++; return { text: 'A valid briefing.' }; } });
  await worker.tick();
  assert.equal(store.get('2026-09-15:briefing').state, 'ready');
  advance(16 * 60000); await worker.tick();
  assert.equal(generations, 1); assert.equal(sent.length, 1);
});

test('research preserves failed and partial page reads with their source versions', () => {
  const failed = sourceReadReceipt('https://example.com/failed', 'Failed to fetch URL (HTTP 503).');
  assert.equal(failed.contentRead, false); assert.equal(failed.coverage, 'not_read');
  assert.equal(failed.observedAt, null); assert.equal(failed.sourceHash, null);
  const partial = sourceReadReceipt('https://example.com/partial', JSON.stringify({ state: 'ready', content: 'first page',
    offset: 0, nextOffset: 8000, totalCharacters: 9000, observedAt: '2026-09-15T06:00:00Z', sourceHash: 'a'.repeat(64),
    limitations: ['Images unread.'] }));
  assert.equal(partial.coverage, 'partial_extracted_text'); assert.equal(partial.nextOffset, 8000);
  assert.equal(partial.sourceHash, 'a'.repeat(64)); assert.equal(partial.observedAt, '2026-09-15T06:00:00Z');
  assert.deepEqual(partial.limitations, ['Images unread.']);
});

test('lost Slack response becomes uncertain and is never automatically resent after recovery', async t => {
  let sends = 0;
  const { worker, store, advance } = setup(t, { web: { chat: { postMessage: async () => { sends++; throw new Error('lost response'); } } } });
  await worker.tick(); store.recover(Date.now()); advance(16 * 60000); await worker.tick();
  assert.equal(sends, 1); assert.equal(store.get('2026-09-15:briefing').state, 'uncertain');
});

test('research stays private and reports never enter authentic inbox history', async t => {
  const { worker, sent, store } = setup(t, { now: () => Date.parse('2026-09-15T03:00:00Z') });
  worker.lastInput = 0;
  await worker.tick();
  assert.equal(sent.length, 0); assert.equal(store.get('2026-09-15:research').state, 'complete');
});

test('other audience policy, disabled scheduler and active conversation perform no work', async t => {
  const { worker, store } = setup(t);
  for (const change of [() => { worker.config.proactiveEnabled = false; },
    () => { worker.config.proactiveEnabled = true; worker.config.policy.mode = 'colleague'; },
    () => { worker.config.policy.mode = 'open'; worker.interactive.running = Promise.resolve(); }]) {
    change(); await worker.tick(); assert.equal(store.get('2026-09-15:briefing'), undefined);
  }
});

test('saved research reads enforce scope before I/O and filter by the exact owner/channel', async t => {
  const { worker, store, config } = setup(t);
  const key = proactiveScope(config);
  store.ensure('2026-09-15', 'research', key, Date.now());
  store.update('2026-09-15:research', 'complete', Date.now(), { report: { marker: 'private research' } });
  const path = join(config.dataDir, 'data', 'proactive', 'proactive.sqlite');
  assert.equal(JSON.parse(proactiveRead('proactive_report', {}, { path })).state, 'not_authorized');
  const scope = createConversationContext({ transport: 'slack', conversationId: `slack:${config.teamId}:${config.channelId}`,
    actorId: config.ownerId, ownerId: config.ownerId, audience: 'group', policy: config.policy, localOnly: true, readOnly: true });
  const report = withConversationContext(scope, () => JSON.parse(proactiveRead('proactive_report', {}, { path })));
  assert.equal(report.jobs[0].report.marker, 'private research');
  assert.equal(JSON.parse(proactiveRead('proactive_report', {}, { path, scope: { ...scope, actorId: 'UOTHER1234' } })).jobs.length, 0);
});

test('background model rejects truncated output, uses cancellation and serializes its requests', async () => {
  let active = 0, peak = 0;
  const controller = new AbortController();
  const chat = backgroundChat({ modelUrl: 'http://127.0.0.1:11437', modelId: 'synthetic' }, controller.signal,
    async (_url, options) => { active++; peak = Math.max(peak, active);
      assert.equal(JSON.parse(options.body).chat_template_kwargs.enable_thinking, true);
      assert.equal(JSON.parse(options.body).max_tokens, 32768);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Incomplete answer' } }] })); });
  const results = await Promise.allSettled([chat('system', 'one'), chat('system', 'two')]);
  assert.equal(peak, 1); assert.ok(results.every(r => r.status === 'rejected'));
  controller.abort(); await assert.rejects(chat('system', 'three'));
});
