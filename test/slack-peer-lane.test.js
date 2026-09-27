import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSlackConfig } from '../src/slack/config.js';
import { channelConfigs, authorizeActor, matchesEvent } from '../src/slack/workspace-channels.js';
import { acceptMention, allowedChannel } from '../src/slack/policy.js';
import { acceptLane, admitLane, laneLimit, laneQuiet, resetLaneChecks,
  LANE_LIMITS, LANE_CHECKS_PER_HOUR } from '../src/slack/peer-lane.js';
import { admitEvent } from '../src/slack/inbox-admission.js';
import { checkStartupChannels, PublicChannelHealth } from '../src/slack/channel-health.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { makeSlackGenerator, LANE_CALL_RESERVE, LANE_ANSWER_TOKENS, LANE_TOOL_ROUNDS } from '../src/slack/model.js';
import { LLMService } from '../src/claude.js';
import { shouldCritique, runCritique } from '../src/quality-gate.js';
import { checkDailyLimit, incrementDailyCalls, getDailyCalls } from '../src/usage-tracker.js';
import { withConversationContext, filterScopedMemories } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { knowledgeTool } from '../src/knowledge/tools.js';
import { TOOL_DEFINITIONS } from '../src/tools/definitions.js';
import { capabilityPrompt } from '../src/runtime-status.js';
import { getSystemPrompt } from '../src/prompt.js';
import coreConfig from '../src/config.js';

const base = { teamId: 'TTEAM12345', appId: 'AAPP12345', ownerId: 'UOWNER123', botUserId: 'UBOT12345',
  channelId: 'GPRIVATE12', publicChannelId: 'CPUBLIC123', peerChannelId: 'CPEERLANE1', peerAppId: 'APEERAPP12',
  policy: { mode: 'open' } };
const channels = channelConfigs(base);
const [privateConfig, shared, lane] = channels;
const PEER_BOT_USER = 'UPEERBOT12', PEER_BOT = 'BPEERBOT12', PEER_USER_TOKEN_BOT = 'BPEERUSER1';
const NOON = Date.UTC(2026, 8, 27, 11, 0, 0); // 12:00 Europe/London (BST), outside lane quiet hours.
const HOUR = 3600000;
const stamp = index => `1790489543.${String(index).padStart(6, '0')}`;
const body = (event = {}, extra = {}) => ({ type: 'event_callback', team_id: base.teamId, api_app_id: base.appId,
  event_id: `EvLANE${String(event.ts || stamp(1)).slice(-6)}`, ...extra,
  event: { type: 'message', channel_type: 'channel', channel: lane.channelId,
    user: base.ownerId, ts: stamp(1), text: 'Clint, what is the capital of France?', ...event } });
const peer = (event = {}, extra = {}) => body({ bot_id: PEER_USER_TOKEN_BOT, app_id: base.peerAppId, ...event }, extra);
const inPrivate = event => ({ channel: privateConfig.channelId, channel_type: 'group', ...event });
const info = { [lane.channelId]: { id: lane.channelId, is_private: false }, [shared.channelId]: { id: shared.channelId, is_private: false },
  [privateConfig.channelId]: { id: privateConfig.channelId, is_private: true } };
const channelInfo = { ...info[lane.channelId], is_member: true, is_archived: false,
  is_shared: false, is_ext_shared: false, is_org_shared: false };
const human = { id: base.ownerId, team_id: base.teamId, deleted: false, is_bot: false, is_app_user: false };
const peerBot = { id: PEER_BOT_USER, team_id: base.teamId, deleted: false, is_bot: true, is_app_user: false,
  profile: { api_app_id: base.peerAppId, bot_id: PEER_BOT } };
function webFor(user = human) {
  const web = { calls: 0, posts: [],
    users: { info: async () => { web.calls++; return { ok: true, user }; } },
    conversations: { info: async ({ channel }) => { web.calls++; return { ok: true, channel: { ...channelInfo, ...info[channel] } }; },
      members: async () => { web.calls++; return { ok: true, members: [base.ownerId, base.botUserId] }; } },
    chat: { postMessage: async message => { web.posts.push(message); return { ok: true, channel: message.channel, ts: stamp(999999) }; } } };
  return web;
}
function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clint-lane-test-'));
  const store = new SlackStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const row = (index, thread = stamp(index), channel = lane.channelId) => ({
  id: `${channel === lane.channelId ? 'lane:' : ''}EvROW${index}`, team: base.teamId, channel,
  owner: base.ownerId, ts: stamp(index), thread, text: 'Clint, hello' });
const admit = (store, web, message, now = NOON, reports = []) => admitEvent({ body: message, channels,
  botUserId: base.botUserId, web, store, now, report: (...args) => reports.push(args) });
const rows = store => store.db.prepare('SELECT id,channel,state,attempts,error FROM events ORDER BY ts').all().map(item => ({ ...item }));
beforeEach(() => resetLaneChecks());

test('lane configuration is all-or-nothing and cannot alias another channel or Clint itself', () => {
  const input = { SLACK_APP_TOKEN: 'xapp-test', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_ID: base.appId,
    SLACK_TEAM_ID: base.teamId, SLACK_CHANNEL_ID: base.channelId, SLACK_OWNER_ID: base.ownerId,
    SLACK_PUBLIC_CHANNEL_ID: base.publicChannelId, SLACK_DATA_DIR: tmpdir() };
  const off = loadSlackConfig(input);
  assert.equal(off.peerChannelId, undefined); assert.equal(channelConfigs(off).length, 2);
  const on = loadSlackConfig({ ...input, SLACK_PEER_CHANNEL_ID: base.peerChannelId, SLACK_PEER_APP_ID: base.peerAppId });
  assert.equal(on.peerChannelId, base.peerChannelId); assert.equal(channelConfigs(on).length, 3);
  for (const change of [{ SLACK_PEER_CHANNEL_ID: base.peerChannelId }, { SLACK_PEER_APP_ID: base.peerAppId },
    { SLACK_PEER_CHANNEL_ID: base.peerChannelId, SLACK_PEER_APP_ID: base.appId },
    { SLACK_PEER_CHANNEL_ID: base.publicChannelId, SLACK_PEER_APP_ID: base.peerAppId },
    { SLACK_PEER_CHANNEL_ID: base.channelId, SLACK_PEER_APP_ID: base.peerAppId }]) {
    assert.throws(() => loadSlackConfig({ ...input, ...change }), /slack_(invalid_configuration|peer_lane_invalid)/);
  }
});

test('lane is a third channel; private and public channel definitions are unchanged by it', () => {
  const { peerChannelId, peerAppId, ...without } = base;
  const [plainPrivate, plainPublic] = channelConfigs(without);
  assert.equal(lane.channelId, base.peerChannelId);
  assert.equal(lane.peerLane, true); assert.equal(lane.workspaceShared, true);
  assert.equal(lane.proactiveEnabled, false); assert.equal(lane.policy.peerLane, true);
  assert.equal(lane.policy.researchScope, undefined);
  assert.equal(privateConfig.peerLane, undefined); assert.equal(shared.peerLane, undefined);
  assert.deepEqual(shared.policy, plainPublic.policy); assert.deepEqual(privateConfig.policy, plainPrivate.policy);
  assert.equal(channelConfigs({ ...without, peerChannelId }).length, 2);
});

test('lane admits the configured peer app and local members; every other app-authored message is refused', () => {
  const asOwner = acceptLane(peer(), lane, base.botUserId);
  assert.equal(asOwner.reason, null); assert.equal(asOwner.event.owner, base.ownerId);
  assert.equal(asOwner.event.channel, lane.channelId); assert.match(asOwner.event.id, /^lane:Ev/);
  const asBot = acceptLane(peer({ user: PEER_BOT_USER, bot_id: PEER_BOT,
    bot_profile: { id: PEER_BOT, app_id: base.peerAppId } }), lane, base.botUserId);
  assert.equal(asBot.event.owner, PEER_BOT_USER);
  assert.match(acceptLane(body(), lane, base.botUserId).event.id, /^lane:Ev/); // A person typing in the lane.
  const mention = acceptLane(peer({ type: 'app_mention', channel_type: undefined, text: `<@${base.botUserId}> hello` }), lane, base.botUserId);
  assert.equal(mention.reason, null);
  for (const [change, reason] of [
    [{ app_id: 'AOTHERAPP1' }, 'peer_app_mismatch'], [{ app_id: base.appId }, 'peer_app_mismatch'],
    [{ app_id: undefined }, 'peer_app_mismatch'], [{ bot_id: 'short' }, 'peer_app_mismatch'],
    [{ bot_id: undefined }, 'peer_app_mismatch'], [{ bot_id: '' }, 'peer_app_mismatch'],
    [{ bot_id: undefined, app_id: undefined, bot_profile: { id: PEER_BOT, app_id: base.peerAppId } }, 'peer_app_mismatch'],
    [{ bot_profile: { id: PEER_USER_TOKEN_BOT, app_id: 'AOTHERAPP1' } }, 'peer_app_mismatch'],
    [{ bot_profile: { id: 'BSOMEOTHER1', app_id: base.peerAppId } }, 'peer_app_mismatch'],
    [{ bot_profile: null }, 'peer_app_mismatch'],
    [{ text: 'What is the capital of France?' }, 'lane_admission_rejected'],
    [{ subtype: 'bot_message' }, 'lane_admission_rejected'], [{ user: base.botUserId }, 'lane_admission_rejected'],
    [{ channel: shared.channelId }, 'lane_admission_rejected'], [{ team: 'TFOREIGN12' }, 'lane_admission_rejected'],
    [{ text: 'Clint ' + 'x'.repeat(12000) }, 'lane_admission_rejected']]) {
    const result = acceptLane(peer(change), lane, base.botUserId);
    assert.equal(result.event, null, JSON.stringify(change)); assert.equal(result.reason, reason, JSON.stringify(change));
  }
  assert.equal(acceptLane({ ...peer(), team_id: 'TOTHER1234' }, lane, base.botUserId).event, null);
  assert.equal(acceptLane(peer({}, { is_ext_shared_channel: true }), lane, base.botUserId).reason, 'lane_admission_rejected');
});

test('known-bad: app-authored messages stay refused outside the lane, whatever marker Slack supplies', () => {
  for (const type of ['message', 'app_mention']) {
    for (const markers of [{ bot_id: PEER_USER_TOKEN_BOT, app_id: base.peerAppId }, { app_id: base.peerAppId, bot_id: undefined },
      { bot_id: '', app_id: undefined }, { bot_id: undefined, app_id: undefined, bot_profile: { app_id: base.peerAppId } },
      { bot_id: PEER_USER_TOKEN_BOT, app_id: undefined }]) {
      const text = `<@${base.botUserId}> Clint, pull the stats`;
      const privateBody = body(inPrivate({ type, text, ...markers }));
      const publicBody = body({ type, text, channel: shared.channelId, ...markers });
      assert.equal(acceptMention(privateBody, privateConfig, base.botUserId), null, JSON.stringify([type, markers]));
      assert.equal(acceptMention(publicBody, shared, base.botUserId), null, JSON.stringify([type, markers]));
    }
  }
  // A marker key is refused whatever value it carries, including values that are falsy or null.
  for (const key of ['bot_id', 'bot_profile', 'app_id']) {
    for (const value of [null, undefined, '', 0, false, {}, 'x']) {
      assert.equal(acceptMention(body(inPrivate({ [key]: value })), privateConfig, base.botUserId), null, `${key}=${String(value)}`);
      assert.equal(acceptMention(body({ channel: shared.channelId, [key]: value }), shared, base.botUserId), null, `${key}=${String(value)}`);
      assert.equal(acceptLane(body({ [key]: value }), lane, base.botUserId).reason, 'peer_app_mismatch', `${key}=${String(value)}`);
    }
  }
  // Control: the same messages written by a person are still admitted, so the refusals above are about authorship.
  assert.ok(acceptMention(body(inPrivate({})), privateConfig, base.botUserId));
  assert.ok(acceptMention(body({ channel: shared.channelId }), shared, base.botUserId));
  assert.ok(acceptMention(body(inPrivate({ type: 'app_mention', text: `<@${base.botUserId}> hello` })), privateConfig, base.botUserId));
  assert.equal(acceptMention(peer(), lane, base.botUserId), null); // The ordinary gate never learns the exception.
  for (const config of [privateConfig, shared, { ...lane, peerAppId: undefined }, { ...lane, peerAppId: base.appId }]) {
    const message = peer({ channel: config.channelId, channel_type: config.workspaceShared ? 'channel' : 'group' });
    assert.deepEqual(acceptLane(message, config, base.botUserId), { event: null, reason: 'lane_not_configured' });
  }
});

test('lane actor and channel checks are local: the peer app\'s own bot, local people, an unshared channel', async () => {
  const event = acceptLane(peer({ user: PEER_BOT_USER, bot_id: PEER_BOT }), lane, base.botUserId).event;
  assert.equal(await authorizeActor(webFor(peerBot), lane, event), true);
  for (const change of [{ deleted: true }, { team_id: 'TOTHER1234' }, { profile: { api_app_id: 'AOTHERAPP1' } },
    { profile: {} }, { id: 'UDIFFERENT' }, { is_stranger: true }]) {
    assert.equal(await authorizeActor(webFor({ ...peerBot, ...change }), lane, event), false, JSON.stringify(change));
  }
  assert.equal(await authorizeActor(webFor(peerBot), shared, { ...event, id: 'EvPUBLIC12', channel: shared.channelId }), false);
  assert.equal(await authorizeActor(webFor(peerBot), privateConfig, { ...event, id: 'EvPRIVATE1', channel: privateConfig.channelId }), false);
  const person = acceptLane(peer(), lane, base.botUserId).event;
  assert.equal(await authorizeActor(webFor(human), lane, person), true);
  const external = webFor({ ...human, team_id: 'TFOREIGN12' });
  external.conversations.members = async () => ({ ok: true, members: [base.ownerId] });
  assert.equal(await authorizeActor(external, lane, person), false);
  assert.equal(await authorizeActor(external, shared, { ...person, id: 'EvPUBLIC12', channel: shared.channelId }), true);
  assert.equal(allowedChannel({ ok: true, channel: channelInfo }, lane), true);
  for (const flag of ['is_shared', 'is_ext_shared', 'is_org_shared']) {
    assert.equal(allowedChannel({ ok: true, channel: { ...channelInfo, [flag]: true } }, lane), false, flag);
    assert.equal(allowedChannel({ ok: true, channel: { ...channelInfo, id: shared.channelId, [flag]: true } }, shared), true, flag);
  }
});

test('a stored lane row runs under the lane definition or not at all', async () => {
  const stored = acceptLane(peer(), lane, base.botUserId).event;
  assert.equal(matchesEvent(stored, lane), true);
  assert.equal(matchesEvent({ ...stored, id: 'EvNOTLANE1' }, lane), false);
  // Operator later reuses the lane channel as the public channel while the row is queued.
  const reused = channelConfigs({ ...base, publicChannelId: lane.channelId, peerChannelId: undefined, peerAppId: undefined })[1];
  assert.equal(reused.channelId, lane.channelId); assert.equal(matchesEvent(stored, reused), false);
  let calls = 0;
  const generator = makeSlackGenerator(reused, { getResponse: async () => { calls++; return { text: 'no' }; } }, async () => null);
  await assert.rejects(generator(stored, []), /identity_mismatch/); assert.equal(calls, 0);
  assert.equal(matchesEvent({ ...row(1, stamp(1), shared.channelId), id: 'lane:EvFORGED1' }, shared), false);
});

test('lane quota is decided with the insert, bounds a loop and leaves the owner at least 80 of 100 daily events', t => {
  const store = storeFixture(t);
  assert.deepEqual({ ...LANE_LIMITS }, { thread: 6, hour: 8, day: 20 });
  for (let i = 1; i <= LANE_LIMITS.thread; i++) assert.equal(store.enqueueLane(row(i, stamp(1)), NOON, LANE_LIMITS), 'queued');
  assert.equal(store.enqueueLane(row(50, stamp(1)), NOON, LANE_LIMITS), 'lane_thread_limit');
  assert.equal(store.enqueueLane(row(1, stamp(1)), NOON, LANE_LIMITS), 'duplicate'); // Double delivery is not a limit event.
  for (let i = 7; i <= LANE_LIMITS.hour; i++) assert.equal(store.enqueueLane(row(i), NOON, LANE_LIMITS), 'queued');
  assert.equal(store.enqueueLane(row(51), NOON, LANE_LIMITS), 'lane_hour_limit');
  for (let i = 9; i <= 16; i++) assert.equal(store.enqueueLane(row(i), NOON + HOUR + 1, LANE_LIMITS), 'queued');
  for (let i = 17; i <= LANE_LIMITS.day; i++) assert.equal(store.enqueueLane(row(i), NOON + 2 * HOUR + 2, LANE_LIMITS), 'queued');
  assert.equal(store.enqueueLane(row(52), NOON + 2 * HOUR + 3, LANE_LIMITS), 'lane_day_limit');
  assert.equal(laneLimit(store.laneUsage(row(52), NOON + 2 * HOUR + 3)), 'lane_day_limit');
  assert.equal(rows(store).length, LANE_LIMITS.day);
  let owner = 0;
  while (store.enqueue(row(1000 + owner, stamp(1000 + owner), privateConfig.channelId), NOON + 3 * HOUR) === 'queued') owner++;
  assert.equal(owner, 80);
  assert.equal(store.enqueueLane(row(53), NOON + 25 * HOUR, LANE_LIMITS), 'queued'); // The window moves on.
});

test('concurrent lane admissions cannot exceed a limit', async t => {
  const store = storeFixture(t), web = webFor(human);
  for (let i = 1; i < LANE_LIMITS.thread; i++) store.enqueueLane(row(i, stamp(1)), NOON, LANE_LIMITS);
  const results = await Promise.all([10, 11, 12, 13].map(i => admit(store, web, peer({ ts: stamp(i), thread_ts: stamp(1) }))));
  assert.deepEqual(results.map(result => result.outcome).sort(), ['lane_queued', 'lane_rejected', 'lane_rejected', 'lane_rejected']);
  assert.ok(results.filter(result => !result.queued).every(result => result.detail === 'lane_thread_limit'));
  assert.equal(store.laneUsage(row(99, stamp(1)), NOON).thread, LANE_LIMITS.thread);
});

test('handler: lane and ordinary channels take separate paths and a refusal is never stored', async t => {
  const store = storeFixture(t), reports = [];
  const posted = { text: `<@${base.botUserId}> Clint, what is the capital of France?` };
  const queued = await admit(store, webFor(human), peer(posted), NOON, reports);
  assert.deepEqual(queued, { outcome: 'lane_queued', detail: undefined, queued: true });
  // Slack delivers both a message and an app_mention event for one post.
  const twin = await admit(store, webFor(human), peer({ ...posted, type: 'app_mention', channel_type: undefined }, { event_id: 'EvTWIN12345' }));
  assert.deepEqual(twin, { outcome: 'lane_duplicate', detail: undefined, queued: false });
  for (const [message, web, detail] of [
    [peer({ ts: stamp(2), app_id: 'AOTHERAPP1' }), webFor(human), 'peer_app_mismatch'],
    [peer({ ts: stamp(3), text: 'no name here' }), webFor(human), 'lane_admission_rejected'],
    [peer({ ts: stamp(4), user: PEER_BOT_USER }), webFor({ ...peerBot, profile: { api_app_id: 'AOTHERAPP1' } }), 'lane_actor_denied'],
    [peer({ ts: stamp(5) }), Object.assign(webFor(human), { conversations: { info: async () => ({ ok: true,
      channel: { ...channelInfo, is_archived: true } }) } }), 'lane_channel_denied']]) {
    assert.deepEqual(await admit(store, web, message), { outcome: 'lane_rejected', detail, queued: false });
  }
  // The identical peer message aimed at the private or public channel is refused by the unchanged ordinary path.
  assert.deepEqual(await admit(store, webFor(human), peer(inPrivate({ ts: stamp(6) }))), { outcome: 'rejected', detail: undefined, queued: false });
  assert.deepEqual(await admit(store, webFor(human), peer({ ts: stamp(7), channel: shared.channelId })), { outcome: 'rejected', detail: undefined, queued: false });
  assert.deepEqual(await admit(store, webFor(human), body({ ts: stamp(8), channel: 'CUNKNOWN12' })), { outcome: 'rejected', detail: undefined, queued: false });
  const owner = await admit(store, webFor(human), body(inPrivate({ ts: stamp(9) })));
  assert.deepEqual(owner, { outcome: 'queued', detail: undefined, queued: true });
  const member = await admit(store, webFor({ ...human, id: 'UMEMBER123' }), body({ ts: stamp(10), channel: shared.channelId, user: 'UMEMBER123' }));
  assert.equal(member.outcome, 'queued');
  assert.deepEqual(rows(store).map(item => [item.id.startsWith('lane:'), item.channel]),
    [[true, lane.channelId], [false, privateConfig.channelId], [false, shared.channelId]]);
  const denied = [];
  await admit(store, webFor({ ...human, id: 'UMEMBER123', is_bot: true }), body({ ts: stamp(11), channel: shared.channelId, user: 'UMEMBER123' }), NOON, denied);
  assert.deepEqual(denied, [['public_actor_denied']]);
  await assert.rejects(admitLane({ body: peer(), channel: shared, botUserId: base.botUserId, web: webFor(human), store, now: NOON }), /lane_pipeline_misuse/);
  const failing = webFor(human); failing.users.info = async () => { throw new Error('slack_down'); };
  await assert.rejects(admit(store, failing, peer({ ts: stamp(12) })), /slack_down/);
  assert.equal(rows(store).length, 3);
});

test('lane refusals that need no Slack answer make no Slack call: quota, quiet hours and the hourly check limit', async t => {
  const store = storeFixture(t), web = webFor(human);
  for (let i = 1; i <= LANE_LIMITS.hour; i++) store.enqueueLane(row(i), NOON, LANE_LIMITS);
  assert.equal((await admit(store, web, peer({ ts: stamp(20) }))).detail, 'lane_hour_limit');
  for (const [time, quiet] of [[Date.UTC(2026, 8, 27, 2, 0), true], [Date.UTC(2026, 8, 27, 6, 29), true],
    [Date.UTC(2026, 8, 27, 6, 30), false], [Date.UTC(2026, 8, 26, 23, 0), true], [Date.UTC(2026, 8, 26, 22, 59), false],
    [Date.UTC(2026, 11, 1, 7, 29), true], [Date.UTC(2026, 11, 1, 7, 30), false]]) {
    assert.equal(laneQuiet(time), quiet, new Date(time).toISOString());
  }
  const night = Date.UTC(2026, 8, 28, 2, 0);
  assert.equal((await admit(store, web, peer({ ts: stamp(21) }), night)).detail, 'lane_quiet_hours');
  assert.equal(web.calls, 0);
  // Refused actors never reach the quota, so the check limit is what bounds their Slack calls.
  const day = NOON + 30 * HOUR, stranger = webFor({ ...human, deleted: true });
  for (let i = 0; i < LANE_CHECKS_PER_HOUR; i++) {
    assert.equal((await admit(store, stranger, peer({ ts: stamp(100 + i) }), day + i)).detail, 'lane_actor_denied');
  }
  const before = stranger.calls;
  assert.equal((await admit(store, stranger, peer({ ts: stamp(200) }), day + 100)).detail, 'lane_check_limit');
  assert.equal(stranger.calls, before); assert.equal(before, LANE_CHECKS_PER_HOUR);
  assert.equal((await admit(store, webFor(human), peer({ ts: stamp(201) }), day + HOUR + 100)).outcome, 'lane_queued');
});

test('owner channels are served before the lane, and a lane message gets exactly one attempt', async t => {
  const store = storeFixture(t), web = webFor(human), reports = [], generated = [];
  store.enqueueLane(row(1), NOON, LANE_LIMITS);
  store.enqueue(row(3, stamp(3), privateConfig.channelId), NOON);
  assert.equal(store.next().id, 'lane:EvROW1'); // Plain age order, which the worker no longer uses.
  assert.equal(store.next(lane.channelId).id, 'EvROW3');
  let failure = 'slack_invalid_core_output';
  const worker = new SlackWorker({ store, config: privateConfig, web, now: () => NOON + 1000,
    resolveConfig: event => channels.find(channel => channel.channelId === event.channel),
    generate: async event => { generated.push(event.id); if (event.channel === lane.channelId) throw new Error(failure); return 'Done.'; },
    report: (...args) => reports.push(args) });
  await worker.drain(); await worker.drain(); await worker.drain();
  assert.deepEqual(generated, ['EvROW3', 'lane:EvROW1']);
  store.enqueueLane(row(2), NOON, LANE_LIMITS);
  failure = 'slack_core_unavailable';
  await worker.drain(); await worker.drain();
  assert.deepEqual(generated, ['EvROW3', 'lane:EvROW1', 'lane:EvROW2']);
  assert.deepEqual(rows(store).map(item => [item.id, item.state, item.attempts, item.error]), [
    ['lane:EvROW1', 'failed', 1, 'slack_invalid_core_output'], ['lane:EvROW2', 'failed', 1, 'slack_core_unavailable'],
    ['EvROW3', 'sent', 1, null]]);
  assert.equal(web.posts.filter(post => /peer lane allows one attempt/.test(post.text)).length, 2);
  assert.ok(web.posts.every(post => post.channel !== lane.channelId || !/Done/.test(JSON.stringify(post))));
  // Control: the same failure in the private channel is still retried, so the single attempt is the lane's rule.
  store.enqueue(row(4, stamp(4), privateConfig.channelId), NOON);
  const retry = new SlackWorker({ store, config: privateConfig, web, now: () => NOON + 1000,
    resolveConfig: event => channels.find(channel => channel.channelId === event.channel),
    generate: async () => { throw new Error('slack_invalid_core_output'); } });
  await retry.drain();
  assert.deepEqual(rows(store).filter(item => item.id === 'EvROW4').map(item => [item.state, item.attempts]), [['queued', 1]]);
});

test('lane requests run web-only, without owner authority, thinking mode, retries or the reserved model budget', async () => {
  let scope, options, calls = 0;
  const service = { getResponse: async (...args) => { calls++; scope = args[5].conversation; options = args[5]; return { text: 'Paris.' }; },
    _getAvailableTools: () => [] };
  const budget = { calls: () => 0, limit: 100 };
  const generator = makeSlackGenerator(lane, service, undefined, budget);
  const event = acceptLane(peer({ text: 'Clint think: what is the capital of France?' }), lane, base.botUserId).event;
  assert.equal(await generator(event, []), 'Paris.');
  assert.equal(scope.actorId, base.ownerId);
  assert.equal(scope.isOwner, false); assert.equal(scope.privateContext, false);
  assert.equal(scope.webOnly, true); assert.equal(scope.readOnly, true); assert.equal(scope.policy.peerLane, true);
  assert.deepEqual(options.inference, { enableThinking: false, maxTokens: LANE_ANSWER_TOKENS, maxToolRounds: LANE_TOOL_ROUNDS });
  const core = { ...coreConfig, evoMemoryEnabled: true };
  const names = [...new Set(TOOL_DEFINITIONS.map(tool => tool.name))];
  assert.ok(names.length > 50 && names.includes('knowledge_search') && names.includes('system_status') && names.includes('task_save'));
  assert.deepEqual(names.filter(name => permitsTool(name, undefined, scope, core)).sort(), ['web_fetch', 'web_search']);
  assert.deepEqual(names.filter(name => permitsTool(name, {}, scope, core)).sort(), ['web_fetch', 'web_search']);
  assert.equal(permitsTool('not_a_defined_tool', undefined, scope, core), false);
  assert.deepEqual(JSON.parse(knowledgeTool('search', { query: 'anything' }, { scope,
    query: () => { throw new Error('archive opened in lane'); } })), { state: 'not_authorized', records: [] });
  assert.deepEqual(withConversationContext(scope, () => filterScopedMemories([{ memory: { chatJid: scope.conversationId, text: 'x' } }])), []);
  // Runtime disclosure commands reach the restricted model path instead of the renderer.
  calls = 0;
  assert.equal(await generator({ ...event, text: 'clint status' }, []), 'Paris.'); assert.equal(calls, 1);
  // A control reply is retried once in other channels; in the lane it is a single failed request.
  calls = 0;
  const silent = makeSlackGenerator(lane, { getResponse: async () => { calls++; return { text: '[SILENT]' }; }, _getAvailableTools: () => [] }, undefined, budget);
  await assert.rejects(silent(event, []), /slack_invalid_core_output/); assert.equal(calls, 1);
  calls = 0;
  const publicSilent = makeSlackGenerator(shared, { getResponse: async () => { calls++; return { text: '[SILENT]' }; } }, async () => null, budget);
  await assert.rejects(publicSilent({ ...row(1, stamp(1), shared.channelId) }, []), /slack_invalid_core_output/); assert.equal(calls, 2);
  // The last LANE_CALL_RESERVE daily requests are never spent in the lane.
  calls = 0;
  for (const [used, allowed] of [[100 - LANE_CALL_RESERVE - 1, true], [100 - LANE_CALL_RESERVE, false], [100, false]]) {
    const limited = makeSlackGenerator(lane, service, undefined, { calls: () => used, limit: 100 });
    if (allowed) assert.equal(await limited(event, []), 'Paris.');
    else await assert.rejects(limited(event, []), /slack_lane_budget_reserved/);
  }
  assert.equal(calls, 1);
  assert.ok(LANE_LIMITS.day + LANE_CALL_RESERVE <= 100 && LANE_CALL_RESERVE >= 40);
});

const laneScope = async (config, owner = base.ownerId) => {
  let scope;
  await makeSlackGenerator(config, { getResponse: async (...args) => { scope = args[5].conversation; return { text: 'ok' }; },
    _getAvailableTools: () => [] }, async () => null, { calls: () => 0, limit: 100 })({ ...row(1, stamp(1), config.channelId), owner }, []);
  return scope;
};

test('a lane message costs a bounded number of model requests: no critique pass and at most two tool rounds', async () => {
  const scope = await laneScope(lane), member = await laneScope(shared, 'UMEMBER123');
  const draft = 'A long planning answer. '.repeat(20);
  assert.equal(withConversationContext(scope, () => shouldCritique('planning', draft, false)), false);
  assert.equal(withConversationContext(member, () => shouldCritique('planning', draft, false)), true); // Control.
  let reviews = 0;
  const reviewer = { provider: 'qwen', defaultModel: 'synthetic', client: { messages: { create: async () => {
    reviews++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'REWRITTEN BY CRITIQUE' }], usage: {} }; } } } };
  assert.equal(await withConversationContext(scope, () => runCritique(draft, 'planning', null, reviewer)), draft);
  assert.equal(reviews, 0);
  const requests = async (conversation, inference) => {
    let count = 0;
    const client = { messages: { create: async () => { count++; return { stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: `call${count}`, name: 'web_search', input: { query: 'public subject' } }] }; } } };
    const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:9', qwenChatModel: 'qwen3.8-flash-next' });
    // No tools are offered to the loop, so every requested call is denied without any network use.
    const result = await withConversationContext(conversation, () => service._toolLoop(client, 'synthetic', { call: fn => fn() },
      [{ type: 'text', text: 'system' }], [{ role: 'user', content: 'question' }], [], true, 'professional',
      conversation.actorId, conversation.conversationId, 'synthetic-request', 'general', inference));
    return { count, rounds: result.toolRounds };
  };
  assert.deepEqual(await requests(scope, { enableThinking: false, maxTokens: LANE_ANSWER_TOKENS, maxToolRounds: LANE_TOOL_ROUNDS }),
    { count: 1 + LANE_TOOL_ROUNDS, rounds: LANE_TOOL_ROUNDS });
  assert.deepEqual(await requests(member, { enableThinking: false, maxTokens: 8192 }), { count: 6, rounds: 5 }); // Control: v36 bound.
  assert.equal(LANE_TOOL_ROUNDS, 2);
});

test('a lane row is closed at pick-up after a restart, in quiet hours, or when Slack cannot confirm the channel', async t => {
  const generated = [], reports = [];
  const make = (store, web, now) => new SlackWorker({ store, config: privateConfig, web, now: () => now,
    resolveConfig: event => channels.find(channel => channel.channelId === event.channel),
    generate: async event => { generated.push(event.id); return 'Done.'; }, report: (...args) => reports.push(args) });
  const restarted = storeFixture(t);
  restarted.enqueueLane(row(1), NOON, LANE_LIMITS); restarted.generating('lane:EvROW1'); restarted.recover();
  restarted.enqueue(row(2, stamp(2), privateConfig.channelId), NOON); restarted.generating('EvROW2'); restarted.recover();
  await make(restarted, webFor(human), NOON + 1000).drain();
  assert.deepEqual(rows(restarted).map(item => [item.id, item.state, item.attempts, item.error]),
    [['lane:EvROW1', 'failed', 1, 'lane_single_attempt'], ['EvROW2', 'sent', 2, null]]); // The owner row is retried as before.
  assert.deepEqual(generated, ['EvROW2']);
  const night = storeFixture(t);
  night.enqueueLane(row(3), Date.UTC(2026, 8, 27, 22, 59), LANE_LIMITS); // Admitted at 23:59 London.
  night.enqueue(row(4, stamp(4), privateConfig.channelId), Date.UTC(2026, 8, 27, 23, 5));
  await make(night, webFor(human), Date.UTC(2026, 8, 27, 23, 6)).drain(); // Picked up at 00:06 London.
  assert.deepEqual(rows(night).map(item => [item.id, item.state, item.attempts, item.error]),
    [['lane:EvROW3', 'failed', 0, 'lane_quiet_hours'], ['EvROW4', 'sent', 1, null]]);
  assert.deepEqual(generated, ['EvROW2', 'EvROW4']);
  const unreachable = storeFixture(t), web = webFor(human), lookup = web.conversations.info;
  web.conversations.info = async args => { if (args.channel === lane.channelId) throw new Error('channel_not_found'); return lookup(args); };
  unreachable.enqueueLane(row(5), NOON, LANE_LIMITS);
  unreachable.enqueue(row(6, stamp(6), privateConfig.channelId), NOON);
  await make(unreachable, web, NOON + 1000).drain();
  assert.deepEqual(rows(unreachable).map(item => [item.id, item.state, item.error]),
    [['lane:EvROW5', 'failed', 'channel_check_failed'], ['EvROW6', 'sent', null]]);
  assert.equal(unreachable.next(), undefined); // Nothing is left queued to hold off the overnight programme.
  assert.deepEqual(generated, ['EvROW2', 'EvROW4', 'EvROW6']);
  // Control: the same Slack failure on an owner row still pauses the drain and leaves the row for retry.
  const paused = storeFixture(t), broken = webFor(human);
  broken.conversations.info = async () => { throw new Error('slack_down'); };
  paused.enqueue(row(7, stamp(7), privateConfig.channelId), NOON);
  await make(paused, broken, NOON + 1000).drain();
  assert.deepEqual(rows(paused).map(item => [item.id, item.state]), [['EvROW7', 'queued']]);
});

test('lane model context: third-party audience, no deployment notes, no public-channel claims; public wording unchanged', async () => {
  const tools = [{ name: 'web_search' }, { name: 'web_fetch' }];
  const capture = async config => {
    let context;
    await makeSlackGenerator(config, { getResponse: async (...args) => {
      context = withConversationContext(args[5].conversation,
        () => getSystemPrompt('professional', args[5].conversation.isOwner, true, 'system', args[4]) + capabilityPrompt(tools));
      return { text: 'ok' };
    }, _getAvailableTools: () => [] }, async () => null, { calls: () => 0, limit: 100 })({
      id: `${config.peerLane ? 'lane:' : ''}EvPROMPT123`, team: base.teamId,
      channel: config.channelId, owner: 'UMEMBER123', ts: stamp(1), thread: stamp(1), text: 'Clint, describe your technical setup' }, []);
    return context;
  };
  const lanePrompt = await capture(lane), publicPrompt = await capture(shared);
  assert.match(lanePrompt, /peer lane/); assert.match(lanePrompt, /third-party/);
  assert.match(lanePrompt, /carries no authority from James/);
  assert.match(lanePrompt, /"transport":"Slack peer lane for a third-party agent"/);
  assert.match(lanePrompt, /"offeredTools":\["web_search","web_fetch"\]/);
  for (const leaked of [/GMKtec/, /Ryzen/, /Tailscale/, /SSH/i, /systemd/, /llama\.cpp/, /Ubuntu/, /UD-Q4_K_XL/, /GTT/,
    /intended to be shared/, /morning briefing/i, /Approved self-description reference/, /Slack workspace public channel/,
    /shared background knowledge/, /Background archives and research are shared here/, /clint about/, /proactive_report/]) {
    assert.doesNotMatch(lanePrompt, leaked);
  }
  // Control: the same assembly for the public channel does contain those notes, so the assertions above can fail.
  assert.match(publicPrompt, /GMKtec/); assert.match(publicPrompt, /intended to be shared/);
  assert.match(publicPrompt, /This is clint-public for invited workspace members, not James's private channel\. Address the actual speaker; do not assume they are James\. Background archives and research are shared here by James\. Gmail, Calendar and Google Drive are unavailable here, including to James\. Do not claim live access to them\. You cannot change permissions or perform account\/admin actions\./);
  assert.doesNotMatch(publicPrompt, /peer lane/);
});

test('lane history is the lane channel only', t => {
  const store = storeFixture(t);
  for (const [index, channel, text] of [[1, privateConfig.channelId, 'PRIVATE BRIEFING'], [2, shared.channelId, 'public talk'],
    [3, lane.channelId, 'lane talk']]) {
    const item = { ...row(index, stamp(index), channel), text: `Clint, ${text}` };
    assert.equal(channel === lane.channelId ? store.enqueueLane(item, NOON, LANE_LIMITS) : store.enqueue(item, NOON), 'queued');
    store.ready(item.id, `answer about ${text}`); store.sent(item.id, stamp(900 + index));
  }
  const history = store.history(row(10), true);
  assert.deepEqual(history.map(item => item.text), ['Clint, lane talk']);
  assert.ok(!JSON.stringify(history).includes('PRIVATE'));
});

test('lane readiness is reported separately and never blocks startup or triggers public-channel notices', async () => {
  const reports = [], web = webFor(human);
  web.conversations.info = async ({ channel }) => ({ ok: true, channel: { ...channelInfo, ...info[channel],
    is_member: channel !== lane.channelId } });
  await checkStartupChannels(web, channels, status => reports.push(status));
  assert.deepEqual(reports, ['public_channel_ready', 'lane_channel_blocked']);
  reports.length = 0;
  await new PublicChannelHealth({ web, channels: [privateConfig, lane], report: status => reports.push(status) }).check();
  assert.deepEqual(reports, []); assert.deepEqual(web.posts, []);
});

// Last in the file: it advances the process-wide daily request counter.
test('the default lane budget is the live daily counter and limit', async () => {
  assert.ok(coreConfig.dailyCallLimit > LANE_CALL_RESERVE + LANE_LIMITS.day);
  checkDailyLimit();
  let calls = 0;
  const generator = makeSlackGenerator(lane, { getResponse: async () => { calls++; return { text: 'Paris.' }; }, _getAvailableTools: () => [] });
  const event = acceptLane(peer(), lane, base.botUserId).event;
  while (getDailyCalls() < coreConfig.dailyCallLimit - LANE_CALL_RESERVE - 1) incrementDailyCalls();
  assert.equal(await generator(event, []), 'Paris.');
  incrementDailyCalls();
  await assert.rejects(generator(event, []), /slack_lane_budget_reserved/);
  assert.equal(calls, 1);
  assert.equal(checkDailyLimit(), true); // The owner still has the reserve.
});
