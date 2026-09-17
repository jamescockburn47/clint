import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSlackConfig } from '../src/slack/config.js';
import { acceptMention, allowedChannel, replyPayload } from '../src/slack/policy.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker, CORE_WAIT_LIMIT_MS } from '../src/slack/worker.js';
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

test('owner private-channel messages need no mention; wrong audiences and bot loops fail closed', t => {
  const plain = body(); Object.assign(plain.event, { type: 'message', channel_type: 'group', text: 'hello' });
  const accepted = acceptMention(plain, cfg, bot); assert.ok(accepted);
  for (const patch of [{ channel_type: 'im' }, { channel_type: 'channel' }, { channel_type: undefined },
    { user: 'U99999999' }, { user: bot }, { bot_id: 'B1' }, { subtype: 'message_changed' },
    { channel: 'C99999999' }, { text: ' ' }]) {
    const value = structuredClone(plain); Object.assign(value.event, patch);
    assert.equal(acceptMention(value, cfg, bot), null);
  }
  const store = fixture(t); store.enqueue(accepted, 1000);
  assert.equal(store.enqueue(acceptMention(body(), cfg, bot), 1001), 'duplicate');
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
  // A new top-level message recalls the channel's recent exchanges; a reply into another thread does not.
  assert.equal(store.history({ ...event, ts: '1789328020.000001', thread: '1789328020.000001' }).length, 1);
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
  let notices = 0;
  const worker = new SlackWorker({ store, config: cfg, generate: async () => { calls++; throw Error('failed'); },
    web: { conversations: { info: async () => channel() }, chat: { postMessage: async payload => {
      if (/^Clint could not answer/.test(payload.text) && !payload.blocks) { notices++; return { ok: true }; }
      assert.fail('must not send');
    } } } });
  for (let i = 0; i < 5; i++) await worker.drain();
  assert.equal(calls, 3); assert.equal(store.counts()[0].state, 'failed'); assert.equal(notices, 1);
});
test('an unavailable core never consumes attempts; it is retried until a wait limit, then reported', async t => {
  const store = fixture(t); store.enqueue(acceptMention(body(), cfg, bot), 1000);
  let calls = 0, sent = 0, notices = 0, available = false;
  const web = { conversations: { info: async () => channel() }, chat: { postMessage: async payload => {
    if (payload.blocks) { sent++; return { ok: true, channel: cfg.channelId, ts: '1789328010.000001' }; }
    notices++; return { ok: true };
  } } };
  const generate = async () => { calls++; if (!available) throw Error('slack_core_unavailable'); return 'Hello'; };
  const worker = new SlackWorker({ store, config: cfg, generate, web, now: () => 1001 });
  for (let i = 0; i < 5; i++) await worker.drain();
  assert.equal(calls, 5); assert.equal(store.counts()[0].state, 'queued'); assert.equal(store.next().attempts, 0);
  available = true; await worker.drain();
  assert.equal(sent, 1); assert.equal(notices, 0); assert.equal(store.counts()[0].state, 'sent');
  const stale = fixture(t); stale.enqueue(acceptMention(body(), cfg, bot), 1000);
  const expired = new SlackWorker({ store: stale, config: cfg, web, now: () => 1000 + CORE_WAIT_LIMIT_MS + 1,
    generate: async () => { throw Error('slack_core_unavailable'); } });
  await expired.drain();
  assert.equal(stale.counts()[0].state, 'failed'); assert.equal(notices, 1); assert.equal(sent, 1);
});
test('definitive Slack refusals fail with a notice; rate limits resend the same reply once', async t => {
  const store = fixture(t); store.enqueue(acceptMention(body(), cfg, bot), 1000);
  let generated = 0, posts = 0, notices = 0;
  const refusal = Object.assign(new Error('An API error occurred: invalid_blocks'),
    { code: 'slack_webapi_platform_error', data: { ok: false, error: 'invalid_blocks' } });
  const web = { conversations: { info: async () => channel() }, chat: { postMessage: async payload => {
    if (!payload.blocks) { notices++; return { ok: true }; }
    posts++; throw refusal;
  } } };
  const worker = new SlackWorker({ store, config: cfg, web, generate: async () => { generated++; return 'Hello'; } });
  await worker.drain(); await worker.drain();
  assert.equal(posts, 1); assert.equal(generated, 1); assert.equal(notices, 1);
  assert.deepEqual(store.counts().map(row => ({ ...row })), [{ state: 'failed', count: 1 }]);
  assert.match(store.db.prepare('SELECT error FROM events').get().error, /slack_rejected:invalid_blocks/);
  const limited = fixture(t); limited.enqueue(acceptMention(body(), cfg, bot), 1000);
  let attempts = 0, resent = 0;
  const later = new SlackWorker({ store: limited, config: cfg, generate: async () => { resent++; return 'Hello'; },
    web: { conversations: { info: async () => channel() }, chat: { postMessage: async () => {
      if (++attempts === 1) throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 1 });
      return { ok: true, channel: cfg.channelId, ts: '1789328011.000001' };
    } } } });
  await later.drain(); assert.equal(limited.counts()[0].state, 'ready');
  await later.drain(); assert.equal(limited.counts()[0].state, 'sent'); assert.equal(attempts, 2); assert.equal(resent, 1);
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
  assert.equal(payload.blocks[0].type, 'rich_text');
  assert.equal(payload.blocks[0].elements[0].elements[0].type, 'text');
  assert.equal(payload.unfurl_links, false); assert.equal(payload.parse, 'none');
  assert.equal(payload.text, 'Clint replied in this thread.');
  assert.throws(() => replyPayload({}, 'x'.repeat(32001)));
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
  for (const result of [null, { text: 'Unavailable', meta: { provider: 'unavailable' } }]) {
    const generate = makeSlackGenerator(cfg, { getResponse: async () => result });
    await assert.rejects(generate(event, []), /core_unavailable/);
  }
  await assert.rejects(makeSlackGenerator(cfg, { getResponse: async () => ({ text: '' }) })(event, []), /invalid_core_output/);
});

test('internal control replies are regenerated once and never delivered', async () => {
  const event = { team: cfg.teamId, channel: cfg.channelId, owner: cfg.ownerId, text: 'hello' };
  for (const marker of ['[INVALID]', '[SILENT]', '[APPROVED]']) {
    assert.throws(() => replyPayload(event, marker), /invalid_reply/);
    let calls = 0;
    const generate = makeSlackGenerator(cfg, { getResponse: async (_text, _mode, _owner, _image, _chat, options) => {
      assert.equal(options.conversation.readOnly, true);
      return { text: ++calls === 1 ? marker : 'Hi James.' };
    } });
    assert.equal(await generate(event, []), 'Hi James.'); assert.equal(calls, 2);
    const bad = makeSlackGenerator(cfg, { getResponse: async () => ({ text: marker }) });
    await assert.rejects(bad(event, []), /invalid_core_output/);
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
