import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { finishToolAttempt } from '../src/tool-attempt-notice.js';

test('terminal notices persist once and retain live audience, rate-limit and uncertain-send boundaries', async t => {
  const config = { teamId: 'TTEST', channelId: 'CTEST', ownerId: 'UOWNER', botUserId: 'UBOT',
    policy: { mode: 'open' } };
  for (const scenario of ['success', 'audience_changed', 'rate_limited', 'uncertain']) {
    const directory = mkdtempSync(join(tmpdir(), 'clint-tool-completion-'));
    const store = new SlackStore(directory);
    t.after(() => { store.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      rmSync(directory, { recursive: true }); });
    const event = { id: 'EvSYNTHETIC', team: config.teamId, channel: config.channelId,
      owner: config.ownerId, ts: '1789000000.000001', thread: '1789000000.000001', text: 'Synthetic checks.' };
    store.enqueue(event, 1789000000000);
    let generations = 0, sends = 0, shared = false;
    const payloads = [];
    const generate = makeSlackGenerator(config, { getResponse: async (_ctx, _mode, _owner, _image, _chat, options) => {
      generations++;
      if (scenario === 'audience_changed') shared = true;
      return finishToolAttempt({ response: null, provider: 'qwen', modelName: 'synthetic', toolRounds: 1 },
        { requestId: 'synthetic' }, options.conversation);
    } });
    const web = { conversations: {
      info: async () => ({ ok: true, channel: { id: config.channelId, is_private: true, is_member: true,
        is_archived: false, is_shared: shared, is_ext_shared: false, is_org_shared: false } }),
      members: async () => ({ ok: true, members: [config.ownerId, config.botUserId] }),
    }, chat: { postMessage: async payload => {
      sends++; payloads.push(payload);
      if (scenario === 'rate_limited' && sends === 1) throw Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error' });
      if (scenario === 'uncertain') throw new Error('unknown delivery outcome');
      return { ok: true, channel: config.channelId, ts: '1789000001.000001' };
    } } };
    const worker = new SlackWorker({ store, config, web, generate });
    await worker.drain();
    const state = () => store.db.prepare('SELECT * FROM events WHERE id=?').get(event.id);
    assert.equal(generations, 1);
    assert.ok(state().answer.includes('don’t have a completed answer'));
    if (scenario === 'rate_limited') assert.equal(state().state, 'ready');
    store.recover(); await worker.drain();
    assert.equal(generations, 1, 'notice must never trigger full regeneration');
    assert.equal(state().attempts, 1);
    assert.equal(state().state, scenario === 'audience_changed' ? 'blocked' : scenario === 'uncertain' ? 'uncertain' : 'sent');
    assert.equal(sends, scenario === 'audience_changed' ? 0 : scenario === 'rate_limited' ? 2 : 1);
    if (scenario === 'rate_limited') assert.deepEqual(payloads[0], payloads[1]);
  }
});
