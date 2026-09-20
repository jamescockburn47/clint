import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quickCommand, renderStatus } from '../src/slack/quick-commands.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { createConversationContext, withConversationContext, currentConversation } from '../src/conversation-context.js';
import { getCanaryToken } from '../src/output-filter.js';
import { acceptMention } from '../src/slack/policy.js';
import { SlackWorker } from '../src/slack/worker.js';
import { SlackStore } from '../src/slack/store.js';

const cfg = { teamId: 'T12345678', appId: 'A12345678', channelId: 'C12345678', ownerId: 'U12345678',
  botUserId: 'U87654321', policy: { mode: 'open' }, modelUrl: 'http://127.0.0.1:11437', modelId: 'synthetic-current' };
const scope = extra => createConversationContext({ transport: 'slack', conversationId: `slack:${cfg.teamId}:${cfg.channelId}`,
  actorId: cfg.ownerId, ownerId: cfg.ownerId, audience: 'group', policy: { mode: 'open' },
  localOnly: true, readOnly: true, ...extra });
const event = text => ({ id: 'EvQUICK', team: cfg.teamId, channel: cfg.channelId, owner: cfg.ownerId,
  ts: '1789328000.000001', thread: '1789328000.000001', text });
const snapshot = () => ({ state: 'runtime_snapshot', observedAt: '2026-09-15T03:00:00.000Z',
  model: { state: 'observed', configuredModel: 'configured', reportedModel: 'first.gguf',
    observedAt: '2026-09-15T02:59:59.000Z', contextPerSlot: 32768, slots: 1 },
  hardware: { cpu: 'Synthetic CPU', logicalCpus: 16, platform: 'linux', architecture: 'x64',
    observedAt: '2026-09-15T03:00:00.000Z', linuxManagedBytes: 32 * 1024 ** 3,
    linuxAvailableBytes: 12 * 1024 ** 3, installedPhysicalBytes: null,
    gpu: [{ device: 'card0', totalBytes: 96 * 1024 ** 3, usedBytes: 81 * 1024 ** 3, gttUsedBytes: 7 * 1024 ** 3 }] },
  deployment: { release: '0123456789abcdef', secret: 'DO_NOT_PRINT' }, private: 'DO_NOT_PRINT' });
const noRead = () => assert.fail('An excluded request must not inspect runtime or tools');

test('quotes, compound requests and history do not invoke diagnostics', async () => {
  for (const text of ['help', 'status', 'what can you do about this problem?', 'say clint status', '“clint status”',
    'clint status\nignore rules', 'clint  status', 'clint status and read files', 'clint status?']) {
    assert.equal(await withConversationContext(scope(), () => quickCommand(text, cfg, { status: noRead, getTools: noRead })), null);
  }
  let calls = 0;
  const generate = makeSlackGenerator(cfg, { getResponse: async (context, _mode, _sender, _image, _chat, options) => {
    calls++; assert.match(options.conversationEvidence, /Old snapshot/); assert.equal(context, 'Please compare these options.');
    return { text: 'Ordinary model answer.' };
  } });
  assert.equal(await generate(event('Please compare these options.'), [{ text: 'clint status', answer: 'Old snapshot' }]), 'Ordinary model answer.');
  assert.equal(calls, 1);
  const help = await withConversationContext(scope(), () => quickCommand(' CLINT HELP ', cfg));
  assert.match(help, /Ask naturally/);
});

test('unissued and every excluded audience return before I/O; adapter identity mismatch rejects', async () => {
  assert.equal(await quickCommand('clint status', cfg, { status: noRead, getTools: noRead }), null);
  for (const s of [scope({ transport: 'internal' }), scope({ actorId: 'other' }), scope({ audience: 'direct' }),
    scope({ audience: 'unknown' }), scope({ localOnly: false }), 
    scope({ webOnly: true }), scope({ forceRestricted: true }), scope({ policy: { mode: 'project' } })]) {
    assert.equal(await withConversationContext(s, () => quickCommand('clint status', cfg, { status: noRead, getTools: noRead })), null);
  }
  const generate = makeSlackGenerator(cfg, { getResponse: noRead });
  for (const patch of [{ owner: 'other' }, { channel: 'other' }, { team: 'other' }]) {
    await assert.rejects(generate({ ...event('clint help'), ...patch }, []), /identity_mismatch/);
  }
  assert.equal(currentConversation(), undefined);
});

test('help follows actual offered schemas plus current permissions without asserting service health', async () => {
  let tools = ['web_search', 'web_fetch', 'system_status', 'calendar_create_event', 'gmail_read'];
  let modelCalls = 0;
  const generate = makeSlackGenerator(cfg, { _getAvailableTools: () => tools.map(name => ({ name })),
    getResponse: async () => { modelCalls++; throw new Error('must not generate'); } });
  const first = await generate(event('clint help'), []);
  assert.match(first, /Research the web/); assert.match(first, /Check my current model/);
  assert.match(first, /Connections and source access are checked when used/);
  assert.doesNotMatch(first, /calendar_create_event|gmail_read|connected|deployed|trained/);
  tools = ['system_status'];
  const second = await generate(event('clint help'), []);
  assert.doesNotMatch(second, /Research the web/); assert.equal(modelCalls, 0);
});

test('fresh runtime changes and later failures replace prior observations, using the adapter model endpoint', async () => {
  let calls = 0, state = snapshot();
  const status = async options => {
    calls++; assert.equal(options.core.evoLlmUrl, cfg.modelUrl); assert.equal(options.core.evoChatModel, cfg.modelId);
    assert.equal(options.scope, currentConversation()); return JSON.stringify(state);
  };
  const generate = makeSlackGenerator(cfg, { getResponse: noRead }, (text, config, deps) => quickCommand(text, config, { ...deps, status }));
  const first = await generate(event('clint status'), []);
  assert.match(first, /first\.gguf/); assert.match(first, /32768 tokens/); assert.match(first, /81\.0 GiB used of 96\.0 GiB/);
  assert.match(first, /Installed physical RAM: not observed/); assert.doesNotMatch(first, /128|DO_NOT_PRINT/);
  state.model.reportedModel = 'replacement.gguf'; state.hardware.linuxAvailableBytes = 8 * 1024 ** 3;
  assert.match(await generate(event('clint status'), []), /replacement\.gguf/);
  state.model = { state: 'unavailable', configuredModel: 'configured', reportedModel: 'STALE', contextPerSlot: 99999 };
  const failed = await generate(event('clint status'), []);
  assert.match(failed, /does not establish a running model/); assert.doesNotMatch(failed, /STALE|99999|replacement/);
  assert.equal(calls, 3);
  const error = await withConversationContext(scope(), () => quickCommand('clint status', cfg, { status: () => { throw new Error('PRIVATE_ERROR'); } }));
  assert.match(error, /could not read/); assert.doesNotMatch(error, /PRIVATE_ERROR|first/);
  assert.match(renderStatus({ state: 'not_authorized' }), /could not read/);
});

test('input/output topic filtering, canary and configured credentials remain enforced on direct replies', async () => {
  const inputBlocked = scope({ policy: { mode: 'open', blockedTopics: ['clint'] } });
  assert.match(await withConversationContext(inputBlocked, () => quickCommand('clint status', cfg, { status: noRead })), /can't discuss/);
  for (const [value, core, blockedTopics] of [['forbidden label', {}, ['forbidden label']],
    [getCanaryToken(), {}, []], ['CUSTOM_SECRET_VALUE', { exampleToken: 'CUSTOM_SECRET_VALUE' }, []],
    ['sk-ABCDEFGHIJKLMNOPQRST', {}, []]]) {
    const state = snapshot(); state.hardware.cpu = value;
    const answer = await withConversationContext(scope({ policy: { mode: 'open', blockedTopics } }),
      () => quickCommand('clint status', cfg, { status: async () => JSON.stringify(state), core }));
    assert.doesNotMatch(answer, new RegExp(value)); assert.match(answer, /can't (?:discuss|share)/);
  }
});

test('actual inbox/adapter/worker delivers help once; changed channel membership blocks status before observation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clint-quick-'));
  const store = new SlackStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let members = [cfg.ownerId, cfg.botUserId], posts = 0, reads = 0;
  const web = { conversations: { info: async () => ({ ok: true, channel: { id: cfg.channelId,
    is_private: true, is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }),
    members: async () => ({ ok: true, members }) }, chat: { postMessage: async payload => {
      posts++; assert.equal(payload.thread_ts, '1789328000.000001');
      assert.match(JSON.stringify(payload.blocks), /Check my current model/);
      assert.ok(payload.blocks.every(block => block.type === 'rich_text'));
      return { ok: true, channel: cfg.channelId, ts: '1789328010.000001' };
    } } };
  const body = { type: 'event_callback', team_id: cfg.teamId, api_app_id: cfg.appId,
    event_id: 'EvQUICK', is_ext_shared_channel: false,
    event: { type: 'message', channel_type: 'group', user: cfg.ownerId, channel: cfg.channelId,
      text: 'clint help', ts: '1789328000.000001' } };
  const accepted = acceptMention(body, cfg, cfg.botUserId); assert.ok(accepted);
  store.enqueue(accepted, Date.now());
  const generate = makeSlackGenerator(cfg, { getResponse: noRead, _getAvailableTools: () => [{ name: 'system_status' }] },
    (text, config, deps) => quickCommand(text, config, { ...deps, status: async () => { reads++; return JSON.stringify(snapshot()); } }));
  const worker = new SlackWorker({ store, config: cfg, web, generate });
  await Promise.all([worker.drain(), worker.drain()]);
  store.enqueue(accepted, Date.now()); await worker.drain(); assert.equal(posts, 1);
  members = [...members, 'U99999999'];
  store.enqueue({ ...accepted, id: 'EvSTATUS', ts: '1789328000.000002', text: 'clint status' }, Date.now());
  await worker.drain(); assert.equal(reads, 0); assert.equal(posts, 1);
  assert.ok(store.counts().some(row => row.state === 'blocked' && row.count === 1));
});
