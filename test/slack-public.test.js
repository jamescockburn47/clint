import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelConfigs, authorizeActor, matchesEvent } from '../src/slack/workspace-channels.js';
import { acceptMention, allowedChannel } from '../src/slack/policy.js';
import { authorizeChannel } from '../src/slack/channel-access.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { googleRead } from '../src/tools/google-read.js';
import { knowledgeTool } from '../src/knowledge/tools.js';
import { proactiveRead } from '../src/slack/proactive-tools.js';
import { ProactiveStore } from '../src/slack/proactive-store.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { makeSlackGenerator } from '../src/slack/model.js';

const base = { teamId: 'TTEAM12345', appId: 'AAPP12345', ownerId: 'UOWNER123', botUserId: 'UBOT12345',
  channelId: 'CPRIVATE12', publicChannelId: 'CPUBLIC123', policy: { mode: 'open' } };
const [privateConfig, shared] = channelConfigs(base);
const event = { id: 'EvTEST1234', team: base.teamId, channel: shared.channelId, owner: 'UMEMBER12',
  ts: '1789633206.000001', thread: '1789633206.000001', text: 'Hello' };
const channel = { id: shared.channelId, is_private: false, is_member: true, is_archived: false,
  is_shared: false, is_ext_shared: false, is_org_shared: false };
const user = { id: event.owner, team_id: base.teamId, deleted: false, is_bot: false, is_app_user: false };
const scopeFor = (actor = event.owner) => createConversationContext({ transport: 'slack',
  conversationId: `slack:${base.teamId}:${shared.channelId}`, actorId: actor, ownerId: base.ownerId,
  audience: 'group', policy: shared.policy, localOnly: true, readOnly: true });

test('workspace public event admission does not widen private channel or accept foreign/bot messages', async () => {
  const body = { type: 'event_callback', team_id: base.teamId, api_app_id: base.appId, event_id: event.id,
    event: { type: 'message', channel_type: 'channel', channel: shared.channelId, user: event.owner, ts: event.ts, text: 'Hello' } };
  assert.ok(acceptMention(body, shared, base.botUserId));
  assert.equal(acceptMention(body, privateConfig, base.botUserId), null);
  for (const change of [{ user: base.botUserId }, { bot_id: 'B123' }, { subtype: 'message_changed' },
    { channel: 'COTHER123' }, { team: 'TFOREIGN1' }]) {
    assert.equal(acceptMention({ ...body, event: { ...body.event, ...change } }, shared, base.botUserId), null);
  }
  assert.equal(acceptMention({ ...body, is_ext_shared_channel: true }, shared, base.botUserId), null);
  assert.equal(matchesEvent({ ...event, channel: privateConfig.channelId }, privateConfig), false);
  for (const change of [{}, { deleted: true }, { is_bot: true }, { is_stranger: true }, { team_id: 'TOTHER123' }]) {
    const allowed = await authorizeActor({ users: { info: async () => ({ ok: true, user: { ...user, ...change } }) } }, shared, event);
    assert.equal(allowed, Object.keys(change).length === 0);
  }
  assert.equal(await authorizeActor({ users: { info: async () => ({ ok: false }) } }, shared, event), false);
});

test('public channel must remain exact, joined and local; private open channel still requires only owner and bot', async () => {
  assert.equal(allowedChannel({ ok: true, channel }, shared), true);
  for (const change of [{ is_shared: true }, { is_ext_shared: true }, { is_org_shared: true },
    { is_archived: true }, { is_member: false }, { is_private: true }]) {
    assert.equal(allowedChannel({ ok: true, channel: { ...channel, ...change } }, shared), false);
  }
  const web = { conversations: { info: async () => ({ ok: true, channel }), members: async () => { throw new Error('not needed'); } } };
  assert.equal(await authorizeChannel(web, shared), true);
  web.conversations.info = async () => ({ ok: true, channel: { ...channel, id: privateConfig.channelId, is_private: true } });
  web.conversations.members = async () => ({ ok: true, members: [base.ownerId, base.botUserId, event.owner] });
  assert.equal(await authorizeChannel(web, privateConfig), false);
});

test('Google integrations are absent and denied before I/O for every public actor including James', async () => {
  for (const actor of [event.owner, base.ownerId]) await withConversationContext(scopeFor(actor), async () => {
    let calls = 0;
    for (const name of ['gmail_search','gmail_read','gmail_draft','calendar_list_events','calendar_read_events',
      'calendar_list_calendars','google_read_status','drive_search','drive_read']) {
      assert.equal(permitsTool(name, {}), false, name);
    }
    for (const name of ['google_read_status','calendar_read_events','drive_read']) {
      assert.equal(JSON.parse(await googleRead(name, {}, { allowed: () => true,
        request: async () => { calls++; return {}; } })).state, 'not_authorized');
    }
    assert.equal(calls, 0);
    assert.equal(permitsTool('knowledge_search', {}), true);
    assert.equal(permitsTool('repository_status', {}), true);
    assert.equal(permitsTool('system_status', {}), true);
    assert.equal(permitsTool('web_search', { query: 'public research' }), true);
    assert.equal(permitsTool('group_mode', {}), false);
    assert.equal(permitsTool('soul_confirm', {}), false);
    const result = JSON.parse(knowledgeTool('record', { id: 'source' }, { query: () => ({ records: ['shared archive'] }) }));
    assert.deepEqual(result.records, ['shared archive']);
  });
});

test('public generator keeps actual actor identity; it never promotes a member to owner', async () => {
  let actual;
  const generator = makeSlackGenerator(shared, { getResponse: async (...args) => {
    actual = args[5].conversation; return { text: 'Hello.' };
  } }, async () => null);
  await generator(event, []);
  assert.equal(actual.isOwner, false); assert.equal(actual.actorId, event.owner);
  assert.equal(actual.policy.workspaceShared, true);
  await assert.rejects(generator({ ...event, channel: privateConfig.channelId }, []), /identity_mismatch/);
});

test('public research reports cannot read saved calendar briefings or private conversation history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clint-public-test-'));
  const jobs = new ProactiveStore(directory), inbox = new SlackStore(directory);
  try {
    for (const [kind, report] of [['research', { finding: 'shared research' }], ['briefing', { calendar: 'PRIVATE CALENDAR' }]]) {
      const job = jobs.ensure('2026-09-17', kind, shared.policy.researchScope, 1);
      jobs.update(job.id, 'complete', 2, { report });
    }
    const read = JSON.parse(proactiveRead('proactive_report', {}, { scope: scopeFor(), path: join(directory, 'proactive.sqlite') }));
    assert.equal(read.jobs.length, 1); assert.equal(read.jobs[0].kind, 'research');
    assert.ok(!JSON.stringify(read).includes('PRIVATE CALENDAR'));
    for (const [i, item] of [
      { ...event, channel: privateConfig.channelId, owner: base.ownerId, text: 'private conversation' },
      { ...event, owner: base.ownerId, text: 'public owner conversation' },
      { ...event, owner: 'UOTHER123', text: 'public other member conversation' },
    ].entries()) {
      const row = { ...item, id: 'EvROW'+i, ts: '1789633205.00000'+i };
      inbox.enqueue(row, 1); inbox.ready(row.id, 'answer'); inbox.sent(row.id, '1789633205.10000'+i);
    }
    const history = inbox.history(event, true);
    assert.equal(history.length, 2);
    assert.ok(history.every(row => row.text.startsWith('public')));
  } finally { jobs.close(); inbox.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('membership revocation between generation and delivery prevents sending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clint-public-worker-')), store = new SlackStore(directory);
  let checks = 0, sent = 0;
  try {
    store.enqueue(event, 1);
    const web = { conversations: { info: async () => ({ ok: true, channel }) },
      users: { info: async () => ({ ok: true, user: { ...user, deleted: ++checks > 1 } }) },
      chat: { postMessage: async () => { sent++; return { ok: true }; } } };
    const worker = new SlackWorker({ store, config: base, web, resolveConfig: () => shared, generate: async () => 'Shared answer' });
    await worker.drain(); assert.equal(sent, 0);
    assert.equal(store.db.prepare('select state from events').get().state, 'blocked');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
