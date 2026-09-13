import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSlackConfig } from '../src/slack/config.js';
import { acceptMention, allowedChannel, replyPayload } from '../src/slack/policy.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { createQwenChatClient } from '../src/qwen-chat.js';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

const cfg = { teamId: 'T12345678', appId: 'A12345678', channelId: 'C12345678', ownerId: 'U12345678',
  modelUrl: 'http://127.0.0.1:11435', modelId: 'qwen3.8-27b' };
const bot = 'U87654321';
const body = () => ({ type: 'event_callback', team_id: cfg.teamId, api_app_id: cfg.appId,
  event_id: 'Ev123', is_ext_shared_channel: false,
  event: { type: 'app_mention', user: cfg.ownerId, channel: cfg.channelId,
    text: `<@${bot}> hello`, ts: '1789328000.000001' } });
const channel = () => ({ ok: true, channel: { id: cfg.channelId, is_private: true,
  is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clint-slack-'));
  const store = new SlackStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
test('only owner mentions for the exact app/team/channel enter the inbox', () => {
  assert.ok(acceptMention(body(), cfg, bot));
  for (const patch of [{ team_id: 'T99999999' }, { api_app_id: 'A99999999' },
    { is_ext_shared_channel: true }, { event_id: '../../evil' }, { type: 'message' }]) {
    assert.equal(acceptMention({ ...body(), ...patch }, cfg, bot), null);
  }
  for (const patch of [{ user: bot }, { user: 'U99999999' }, { channel: 'C99999999' },
    { team: 'T99999999' }, { bot_id: 'B1' }, { subtype: 'message_changed' },
    { thread_ts: '../bad' }, { ts: null }, { text: 'hello' }, { text: 'x'.repeat(12001) }]) {
    const v = body(); Object.assign(v.event, patch);
    assert.equal(acceptMention(v, cfg, bot), null);
  }
});
test('channel metadata must prove private, joined, unshared and unarchived', () => {
  assert.equal(allowedChannel(channel(), cfg), true);
  for (const name of ['is_private', 'is_member', 'is_archived', 'is_shared', 'is_ext_shared', 'is_org_shared']) {
    const v = channel(); v.channel[name] = !v.channel[name];
    assert.equal(allowedChannel(v, cfg), false);
    delete v.channel[name]; assert.equal(allowedChannel(v, cfg), false);
  }
});
test('configuration rejects external models and redacts supplied secret values', () => {
  const input = { SLACK_APP_TOKEN: 'xapp-test', SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_APP_ID: cfg.appId, SLACK_TEAM_ID: cfg.teamId,
    SLACK_CHANNEL_ID: cfg.channelId, SLACK_OWNER_ID: cfg.ownerId, SLACK_DATA_DIR: tmpdir() };
  assert.equal(loadSlackConfig(input).modelId, cfg.modelId);
  for (const url of ['https://example.com', 'http://localhost:11435', 'http://127.0.0.1:11435/path']) {
    assert.throws(() => loadSlackConfig({ ...input, SLACK_MODEL_URL: url }), /SLACK_MODEL_URL/);
  }
  assert.throws(() => loadSlackConfig({ ...input, SLACK_APP_TOKEN: 'PRIVATE_SECRET' }),
    error => !error.message.includes('PRIVATE_SECRET'));
});
test('durable deduplication and recovery do not repeat uncertain outbound sends', t => {
  const store = fixture(t), event = acceptMention(body(), cfg, bot);
  assert.equal(store.enqueue(event, 1000), 'queued');
  assert.equal(store.enqueue(event, 1001), 'duplicate');
  assert.equal(store.enqueue({ ...event, id: 'EvDifferent' }, 1001), 'duplicate');
  store.generating(event.id); store.recover(); assert.equal(store.next().state, 'queued');
  store.ready(event.id, 'Answer'); store.setState(event.id, 'sending'); store.recover();
  assert.equal(store.next(), undefined);
  assert.deepEqual(store.counts().map(row => ({ ...row })), [{ state: 'uncertain', count: 1 }]);
});
test('retries and simultaneous drains generate and deliver exactly once, in the original thread', async t => {
  const store = fixture(t), event = acceptMention(body(), cfg, bot);
  store.enqueue(event, 1000);
  let generated = 0, sent = 0;
  const web = { conversations: { info: async () => channel() }, chat: { postMessage: async payload => {
    sent++; assert.equal(payload.thread_ts, event.ts); assert.equal(payload.channel, cfg.channelId);
    return { ok: true, channel: cfg.channelId, ts: '1789328010.000001' };
  } } };
  const worker = new SlackWorker({ store, config: cfg, web, generate: async () => { generated++; return 'Hello'; } });
  await Promise.all([worker.drain(), worker.drain()]);
  store.enqueue(event, 1001); await worker.drain();
  assert.equal(generated, 1); assert.equal(sent, 1);
  assert.equal(store.history({ ...event, ts: '1789328020.000001' }).length, 1);
  for (const patch of [{ thread: '1789000000.000001' }, { owner: 'U99999999' },
    { channel: 'C99999999' }, { team: 'T99999999' }]) {
    assert.equal(store.history({ ...event, ts: '1789328020.000001', ...patch }).length, 0);
  }
});
test('sharing changes during generation block delivery; scope changes block execution', async t => {
  const store = fixture(t), event = acceptMention(body(), cfg, bot);
  store.enqueue(event, 1000);
  let checks = 0;
  const worker = new SlackWorker({ store, config: cfg, generate: async () => 'Hello',
    web: { conversations: { info: async () => { const v = channel(); if (++checks > 1) v.channel.is_shared = true; return v; } },
      chat: { postMessage: async () => assert.fail('must not send') } } });
  await worker.drain(); assert.equal(store.counts()[0].state, 'blocked');
  store.setState(event.id, 'queued');
  worker.config = { ...cfg, ownerId: 'U99999999' }; await worker.drain();
  assert.equal(checks, 2);
});
test('unknown delivery outcome is retained and never automatically retried', async t => {
  const store = fixture(t); store.enqueue(acceptMention(body(), cfg, bot), 1000);
  let calls = 0;
  const worker = new SlackWorker({ store, config: cfg, generate: async () => 'Hello',
    web: { conversations: { info: async () => channel() }, chat: { postMessage: async () => { calls++; throw Error('network'); } } } });
  await worker.drain(); store.recover(); await worker.drain();
  assert.equal(calls, 1); assert.equal(store.counts()[0].state, 'uncertain');
});
test('generation failures have three attempts and never send invented fallback replies', async t => {
  const store = fixture(t); store.enqueue(acceptMention(body(), cfg, bot), 1000);
  let calls = 0;
  const worker = new SlackWorker({ store, config: cfg, generate: async () => { calls++; throw Error('failed'); },
    web: { conversations: { info: async () => channel() }, chat: { postMessage: async () => assert.fail('must not send') } } });
  for (let i = 0; i < 5; i++) await worker.drain();
  assert.equal(calls, 3); assert.equal(store.counts()[0].state, 'failed');
});
test('adapter calls shared core with authenticated audience, local inference and thread history', async () => {
  let requests = 0;
  const generate = makeSlackGenerator(cfg, { getResponse: async (context, mode, sender, image, chat, options) => {
    requests++; assert.equal(sender, cfg.ownerId); assert.equal(mode, 'professional');
    assert.equal(chat, `slack:${cfg.teamId}:${cfg.channelId}`);
    assert.equal(options.conversation.localOnly, true); assert.equal(options.conversation.readOnly, true);
    assert.equal(options.conversation.policy.mode, 'colleague');
    assert.match(context, /Earlier/); assert.match(context, /Current question/);
    return { text: 'Grounded reply' };
  } });
  const event = { team: cfg.teamId, channel: cfg.channelId, owner: cfg.ownerId, text: 'Current question' };
  assert.equal(await generate(event, [{ text: 'Earlier', answer: 'Prior reply' }]), 'Grounded reply');
  await assert.rejects(generate({ ...event, owner: 'U99999999' }, []), /identity_mismatch/);
  assert.equal(requests, 1);
});
test('generated mention syntax is rendered as plain text without notifications/unfurls', () => {
  const payload = replyPayload(acceptMention(body(), cfg, bot), '<!channel> <@U12345678> https://example.com');
  assert.equal(payload.blocks[0].text.type, 'plain_text');
  assert.equal(payload.unfurl_links, false); assert.equal(payload.parse, 'none');
  assert.equal(payload.text, 'Clint replied in this thread.');
  assert.throws(() => replyPayload({}, 'x'.repeat(10001)));
});
test('release unit excludes home directories and uses a single durable process lock', () => {
  const unit = readFileSync(new URL('../evo-system/clint-slack.service', import.meta.url), 'utf8');
  for (const setting of ['DynamicUser=yes', 'ProtectHome=yes', 'ProtectSystem=strict',
    'StateDirectoryMode=0700', '/usr/bin/flock -n', 'NoNewPrivileges=yes']) assert.ok(unit.includes(setting));
});
test('installed SDKs expose the actual entry-point constructors', () => {
  assert.equal(typeof SocketModeClient, 'function');
  assert.equal(typeof WebClient, 'function');
});
test('adapter rejects missing and unavailable core results', async () => {
  const event = { team: cfg.teamId, channel: cfg.channelId, owner: cfg.ownerId, text: 'Question' };
  for (const result of [null, { text: '' }, { text: 'Unavailable', meta: { provider: 'unavailable' } }]) {
    const generate = makeSlackGenerator(cfg, { getResponse: async () => result });
    await assert.rejects(generate(event, []), /invalid_core_output/);
  }
});
test('model timeout remains active during body parsing, and errors cannot echo source text', async () => {
  let aborted = false;
  const client = createQwenChatClient({ baseUrl: cfg.modelUrl, timeoutMs: 20,
    fetchFn: async (_url, init) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(Error('PRIVATE_PROMPT')); }, { once: true });
    }) }) });
  await assert.rejects(client.messages.create({ messages: [] }), /qwen-chat request failed/);
  assert.equal(aborted, true);
  let readBody = false, cancelled = false;
  const bad = createQwenChatClient({ baseUrl: cfg.modelUrl, fetchFn: async () => ({
    ok: false, status: 502, body: { cancel: async () => { cancelled = true; } },
    text: async () => { readBody = true; return 'PRIVATE_PROMPT'; },
  }) });
  await assert.rejects(bad.messages.create({ messages: [] }), error => error.message === 'qwen-chat 502');
  assert.equal(readBody, false); assert.equal(cancelled, true);
});
