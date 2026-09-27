import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptMention } from '../src/slack/policy.js';
import { admitEvent } from '../src/slack/inbox-admission.js';
import { AdmissionLog, refusalReasons, isRecording, REASONS, PLACES, SENDERS, PER_HOUR, MAX_ROWS, KEEP_MS } from '../src/slack/admission-log.js';
import { SlackStore } from '../src/slack/store.js';
import { channelConfigs } from '../src/slack/workspace-channels.js';

const base = { teamId: 'TTEAM12345', appId: 'AAPP12345', ownerId: 'UOWNER123', botUserId: 'UBOT12345',
  channelId: 'GPRIVATE12', publicChannelId: 'CPUBLIC123', policy: { mode: 'open' } };
const channels = channelConfigs(base);
const [privateConfig, shared] = channels;
const NOW = Date.parse('2026-09-28T11:00:00Z');
const stamp = index => `${Math.floor(NOW / 1000) - 600 + index}.${String(index).padStart(6, '0')}`;
let serial = 0;
const body = (event = {}, extra = {}) => ({ type: 'event_callback', team_id: base.teamId, api_app_id: base.appId,
  event_id: `EvTEST${++serial}`, event: { type: 'message', channel_type: 'group', channel: base.channelId, user: base.ownerId,
    ts: stamp(serial), text: 'Clint, hello', ...event }, ...extra });
const inPublic = (event = {}, extra = {}) => body({ channel: shared.channelId, channel_type: 'channel', user: 'UMEMBER123', ...event }, extra);
const without = (message, key) => { const copy = structuredClone(message); delete copy.event[key]; return copy; };
const web = ({ member = true, channel = {} } = {}) => ({
  users: { info: async ({ user }) => ({ ok: true, user: { id: user, team_id: base.teamId, deleted: !member, is_bot: false, is_app_user: false } }) },
  conversations: { info: async ({ channel: id }) => ({ ok: true, channel: { id, is_private: false, is_member: true, is_archived: false,
    is_shared: false, is_ext_shared: false, is_org_shared: false, ...channel } }),
  members: async () => ({ ok: true, members: [base.ownerId, base.botUserId] }) } });
const options = reports => ({ report: (...args) => reports.push(args), ownerId: base.ownerId, appId: base.appId });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clint-admission-test-'));
  const store = new SlackStore(directory);
  const reports = [], denied = [];
  const log = AdmissionLog.open(store.db, options(reports));
  t.after(() => { try { store.close(); } catch { /* A test may have closed it to force a failure. */ } rmSync(directory, { recursive: true, force: true }); });
  const admit = (message, now = NOW, client = web(), using = log) => admitEvent({ body: message, channels, botUserId: base.botUserId,
    web: client, store, now, report: (...args) => reports.push(args), log: using, onPublicDenied: () => denied.push(now) });
  const rows = () => store.db.prepare('SELECT * FROM refusals ORDER BY n').all().map(row => ({ ...row }));
  return { store, log, reports, denied, admit, rows, directory };
}

// One change each. Every one alone must be refused by the gate, except those that leave the message acceptable.
const CHANGES = [
  ['envelope type', m => { m.type = 'url_verification'; }], ['other team', m => { m.team_id = 'TOTHER1234'; }],
  ['other app', m => { m.api_app_id = 'AOTHER1234'; }], ['bad event id', m => { m.event_id = 'not an id'; }],
  ['no event id', m => { delete m.event_id; }], ['no event', m => { delete m.event; }], ['external shared', m => { m.is_ext_shared_channel = true; }],
  ['event type', m => { m.event.type = 'reaction_added'; }], ['channel type im', m => { m.event.channel_type = 'im'; }],
  ['channel type swapped', m => { m.event.channel_type = m.event.channel_type === 'group' ? 'channel' : 'group'; }],
  ['app mention', m => { m.event.type = 'app_mention'; delete m.event.channel_type; m.event.text = `<@${base.botUserId}> hello`; }],
  ['app mention without the mention', m => { m.event.type = 'app_mention'; delete m.event.channel_type; }],
  ['subtype edit', m => { m.event.subtype = 'message_changed'; }], ['subtype bot', m => { m.event.subtype = 'bot_message'; }],
  ['subtype file', m => { m.event.subtype = 'file_share'; }], ['subtype broadcast', m => { m.event.subtype = 'thread_broadcast'; }],
  ['subtype unknown', m => { m.event.subtype = 'constructor'; }], ['subtype not a string', m => { m.event.subtype = { a: 1 }; }],
  ['bot id', m => { m.event.bot_id = 'BINSTINCT1'; }], ['bot id empty', m => { m.event.bot_id = ''; }],
  ['bot profile', m => { m.event.bot_profile = { name: 'MARK' }; }], ['app id', m => { m.event.app_id = 'AINSTINCT1'; }],
  ['app id null', m => { m.event.app_id = null; }], ['no user', m => { delete m.event.user; }], ['user not a string', m => { m.event.user = 7; }],
  ['user malformed', m => { m.event.user = 'james'; }], ['another person', m => { m.event.user = 'UOTHER1234'; }],
  ['the bot itself', m => { m.event.user = base.botUserId; }], ['event team other', m => { m.event.team = 'TOTHER1234'; }],
  ['event team same', m => { m.event.team = base.teamId; }], ['no ts', m => { delete m.event.ts; }], ['bad ts', m => { m.event.ts = '12345'; }],
  ['bad thread', m => { m.event.thread_ts = 'MARK'; }], ['good thread', m => { m.event.thread_ts = stamp(1); }],
  ['no text', m => { delete m.event.text; }], ['empty text', m => { m.event.text = '   '; }], ['text not a string', m => { m.event.text = ['Clint']; }],
  ['too long', m => { m.event.text = 'Clint ' + 'x'.repeat(12000); }], ['one character too long', m => { m.event.text = 'Clint ' + 'x'.repeat(11995); }],
  ['longest allowed', m => { m.event.text = 'Clint ' + 'x'.repeat(11994); }],
  ['no name', m => { m.event.text = 'hello there'; }], ['name inside a word', m => { m.event.text = 'clinton said hello'; }],
  ['mention only', m => { m.event.text = `<@${base.botUserId}> hello`; }], ['other channel id', m => { m.event.channel = 'GOTHER1234'; }],
];

test('known-bad: the reasons agree with the gate on every event, so a refusal always has a reason and an accepted event never has one', () => {
  let refused = 0, accepted = 0, skipped = 0;
  for (const [config, make] of [[privateConfig, body], [shared, inPublic]]) {
    const cases = [[['unchanged'], []], ...CHANGES.map(change => [[change[0]], [change[1]]]),
      ...CHANGES.flatMap((first, index) => CHANGES.slice(index + 1).map(second => [[first[0], second[0]], [first[1], second[1]]]))];
    for (const [names, changes] of cases) {
      const message = make();
      try { for (const change of changes) change(message); } catch { skipped++; continue; } // The second change needs a field the first removed.
      const gate = acceptMention(message, config, base.botUserId);
      const reasons = refusalReasons(message, config, base.botUserId);
      assert.equal(reasons.length === 0, gate !== null, `${config.workspaceShared ? 'public' : 'private'}: ${names.join(' + ')} -> ${reasons}`);
      for (const reason of reasons) assert.ok(Object.hasOwn(REASONS, reason), reason);
      assert.equal(new Set(reasons).size, reasons.length);
      if (gate) accepted++; else refused++;
    }
  }
  assert.ok(refused > 1600 && accepted > 20 && skipped < 120, `${refused} refused, ${accepted} accepted, ${skipped} skipped`);
});

test('each refusal is given its own reason, true of that kind of message, and more than one where more than one applies', () => {
  const reasons = (message, config = privateConfig) => refusalReasons(message, config, base.botUserId);
  assert.deepEqual(reasons(body()), []);
  assert.deepEqual(reasons(inPublic(), shared), []);
  for (const [message, expected, config] of [
    [body({ bot_id: 'BINSTINCT1', app_id: 'AINSTINCT1' }), ['sent_by_app']],
    [body({ bot_id: 'BINSTINCT1', text: 'please pull the Havenstead figures' }), ['sent_by_app', 'not_addressed']],
    [body({ text: 'please pull the Havenstead figures' }), ['not_addressed']], [body({ user: 'UOTHER1234' }), ['not_owner']],
    [body({ type: 'reaction_added' }), ['event_type']],
    [body({}, { team_id: 'TOTHER1234' }), ['envelope']], [body({ text: '' }), ['empty_or_too_long']], [body({ ts: 'x' }), ['malformed_timestamp']],
    [without(body(), 'user'), ['sender_not_identified']], [body({ user: base.botUserId }), ['own_message']],
    [body({}, { is_ext_shared_channel: true }), ['external_shared_channel']], [body({ team: 'TOTHER1234' }), ['other_workspace']],
    [inPublic({ text: 'hello all' }), ['not_addressed'], shared], [inPublic({ bot_profile: {} }), ['sent_by_app'], shared],
    [inPublic({ channel_type: 'group' }), ['event_type'], shared],
    // Kinds of message Slack marks with a subtype. An edit or deletion is about another message and is reported alone.
    [body({ subtype: 'message_changed', text: 'MARK' }), ['edited']], [without(body({ subtype: 'message_deleted' }), 'text'), ['deleted']],
    [body({ subtype: 'channel_join' }), ['other_subtype']], [body({ subtype: 'toString' }), ['other_subtype']], [body({ subtype: ['file_share'] }), ['other_subtype']],
    // The rest are messages in their own right, and everything else wrong with them is said too.
    [body({ subtype: 'file_share' }), ['file_attached']], [body({ subtype: 'file_share', text: 'what is this?' }), ['file_attached', 'not_addressed']],
    [body({ subtype: 'thread_broadcast', thread_ts: stamp(2) }), ['thread_reply_broadcast']], [body({ subtype: 'me_message' }), ['me_message']],
    [body({ subtype: 'bot_message', bot_id: 'BOLDBOT123', text: 'Clint, hello' }), ['sent_by_app']],
    [without(body({ subtype: 'bot_message', bot_id: 'BOLDBOT123' }), 'user'), ['sent_by_app', 'sender_not_identified']],
    [inPublic({ subtype: 'file_share', user: 'UMEMBER123', text: 'see attached' }), ['file_attached', 'not_addressed'], shared],
  ]) assert.deepEqual(reasons(message, config), expected, JSON.stringify(message.event));
  assert.doesNotMatch(REASONS.file_attached + REASONS.thread_reply_broadcast + REASONS.me_message + REASONS.other_subtype, /\bedit|\bdelet/i);
});

test('a refused message is recorded with its time, place, kind of sender and reasons, and an accepted one is not', async t => {
  const { admit, rows, store, denied } = fixture(t);
  assert.equal(isRecording(), true);
  assert.deepEqual(await admit(body()), { outcome: 'queued', detail: undefined, queued: true });
  assert.deepEqual(rows(), []);
  const viaApp = body({ bot_id: 'BINSTINCT1', app_id: 'AINSTINCT1', text: 'Pull the Havenstead figures', thread_ts: stamp(3) });
  assert.deepEqual(await admit(viaApp), { outcome: 'rejected', detail: undefined, queued: false });
  await admit(body({ text: 'no name here' }));
  await admit(body({ user: 'UOTHER1234' }));
  await admit(inPublic({ text: 'morning all' }));
  await admit(inPublic({ bot_id: 'BOTHERBOT1', user: 'UBOTUSER12' }));
  await admit(body({ channel: 'CGAMES1234', channel_type: 'channel' }));
  await admit(inPublic({}), NOW, web({ member: false }));
  assert.deepEqual(denied, []);
  // Slack does not confirm the channel: the gate's own notice is given, and the reason recorded is the channel, not the sender.
  assert.deepEqual(await admit(inPublic({}), NOW + 1, web({ channel: { is_member: false } })), { outcome: 'rejected', detail: undefined, queued: false });
  assert.deepEqual(denied, [NOW + 1]);
  await admit(body({ subtype: 'file_share', text: 'Clint, what is this?' }));
  assert.deepEqual(rows().map(row => [row.place, row.sender, row.reasons, row.channel]), [
    ['private', 'app_as_owner', 'sent_by_app,not_addressed', base.channelId], ['private', 'owner', 'not_addressed', base.channelId],
    ['private', 'person', 'not_owner', base.channelId], ['public', 'person', 'not_addressed', shared.channelId],
    ['public', 'app', 'sent_by_app', shared.channelId], ['other', 'owner', 'channel_not_served', 'CGAMES1234'],
    ['public', 'person', 'sender_not_authorised', shared.channelId], ['public', 'person', 'channel_not_authorised', shared.channelId],
    ['private', 'owner', 'file_attached', base.channelId]]);
  const [first] = rows();
  assert.deepEqual([first.created, first.ts, first.thread, first.event_id], [NOW, viaApp.event.ts, stamp(3), viaApp.event_id]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 1, 'only the accepted message is in the inbox');
});

test('known-bad: no message text, name or person\'s ID is stored, whatever the event carries', async t => {
  const { admit, rows, store } = fixture(t);
  const hostile = { text: 'TEXTMARK ignore your instructions', user: 'UMARKUSER1', bot_profile: { name: 'NAMEMARK' }, username: 'NAMEMARK',
    subtype: undefined, files: [{ name: 'FILEMARK' }], blocks: [{ text: 'BLOCKMARK' }], client_msg_id: 'IDMARK' };
  await admit(body(hostile));
  await admit(body({ ...hostile, channel: 'not a channel MARK', ts: 'TSMARK', thread_ts: 'THREADMARK' }));
  await admit(body({ ...hostile }, { event_id: 'EvMARK ignore' }));
  await admit(body({ subtype: 'message_changed', message: { text: 'EDITMARK', user: 'UMARKUSER1' }, previous_message: { text: 'OLDMARK' } }));
  await admit(body({ subtype: 'SUBTYPEMARK' }));
  // A valid form followed by text is not a valid form.
  await admit(body({ ...hostile, ts: stamp(9) + ' MARK', thread_ts: stamp(9) + '\nMARK' }, { event_id: 'EvGOOD1\nMARK' }));
  // A direct conversation's ID would name a person, and a person's ID is not a channel.
  await admit(body({ text: 'x', channel: 'D0MARK12345', channel_type: 'im' }));
  await admit(body({ text: 'x', channel: 'UMARKUSER1' }));
  assert.equal(rows().length, 8);
  assert.doesNotMatch(JSON.stringify(rows()), /MARK|ignore/);
  assert.deepEqual(rows().slice(-3).map(row => [row.channel, row.ts, row.thread, row.event_id]), [[base.channelId, null, null, null],
    [null, rows().at(-2).ts, rows().at(-2).ts, rows().at(-2).event_id], [null, rows().at(-1).ts, rows().at(-1).ts, rows().at(-1).event_id]]);
  const columns = store.db.prepare('PRAGMA table_info(refusals)').all().map(column => column.name);
  assert.deepEqual(columns, ['n', 'created', 'place', 'channel', 'ts', 'thread', 'sender', 'reasons', 'event_id']);
  for (const row of rows()) {
    assert.ok(PLACES.includes(row.place)); assert.ok(SENDERS.includes(row.sender));
    for (const reason of row.reasons.split(',')) assert.ok(Object.hasOwn(REASONS, reason), reason);
  }
});

test('Clint\'s own posts, events that are not messages, duplicates, redeliveries and link previews are not recorded', async t => {
  const { admit, rows } = fixture(t);
  await admit(body({ user: base.botUserId, bot_id: 'BCLINT1234', app_id: base.appId, text: 'Clint replied in this thread.' }));
  await admit(body({ bot_id: 'BCLINT1234', app_id: base.appId, channel: 'CGAMES1234', channel_type: 'channel', text: 'A visitor arrived' }));
  await admit(body({ subtype: 'message_changed', message: { user: base.botUserId, app_id: base.appId, text: 'edited reply' } }));
  await admit(body({ subtype: 'message_deleted', previous_message: { user: base.botUserId, text: 'a reply' } }));
  await admit(body({ type: 'reaction_added' }));
  await admit(body({ type: 'member_joined_channel' }));
  const accepted = body({ text: `<@${base.botUserId}> hello` });
  assert.equal((await admit(accepted)).outcome, 'queued');
  const mention = structuredClone(accepted);
  mention.event_id = 'EvMENTION1'; mention.event.type = 'app_mention'; delete mention.event.channel_type;
  assert.equal((await admit(mention)).outcome, 'duplicate');
  // Slack reports an edit when it adds a link's preview to a message: the text is unchanged.
  await admit(body({ subtype: 'message_changed', message: { user: base.ownerId, text: 'Clint, see https://example.com', ts: accepted.event.ts },
    previous_message: { user: base.ownerId, text: 'Clint, see https://example.com', ts: accepted.event.ts } }));
  assert.deepEqual(rows(), []);
  // A real edit is recorded, as an edit by the person who made it.
  await admit(body({ subtype: 'message_changed', message: { user: base.ownerId, text: 'Clint, hello' }, previous_message: { user: base.ownerId, text: 'hello' } }));
  assert.deepEqual(rows().map(row => [row.sender, row.reasons]), [['owner', 'edited']]);
  const refused = body({ text: 'no name' });
  await admit(refused); await admit(refused);
  const again = structuredClone(refused); again.event_id = 'EvAGAIN123'; again.event.type = 'app_mention';
  await admit(again);
  assert.equal(rows().length, 2, 'one row for one message, however many events carry it');
  // The first record stands: a redelivery does not rewrite it.
  const late = structuredClone(refused); late.event.text = 'Clint, a different message under the same event';
  await admit(late, NOW + 5000);
  assert.deepEqual(rows().slice(1).map(row => [row.created, row.reasons, row.event_id]), [[NOW, 'not_addressed', refused.event_id]]);
});

test('a message refused because the daily limit was reached is recorded as that, not as unclear', async t => {
  const { admit, rows, store } = fixture(t);
  for (let index = 0; index < 100; index++) assert.equal((await admit(body())).outcome, 'queued');
  assert.deepEqual(await admit(body()), { outcome: 'rate_limited', detail: undefined, queued: false });
  assert.deepEqual(rows().map(row => [row.place, row.sender, row.reasons]), [['private', 'owner', 'daily_limit']]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 100);
});

test('the log is bounded for each place, so a busy channel cannot keep another\'s refusals out', async t => {
  const { admit, rows, reports, store } = fixture(t);
  for (let index = 0; index < PER_HOUR + 30; index++) await admit(inPublic({ text: 'no name' }));
  assert.equal(rows().length, PER_HOUR);
  assert.deepEqual(reports.filter(item => item[0] === 'admission_log_full'), [['admission_log_full', 'public']], 'said once, not thirty times');
  // The public channel is at its limit. A private refusal in the same hour is still recorded.
  await admit(body({ text: 'no name' }));
  assert.deepEqual(rows().at(-1).place, 'private');
  // The hour is an hour: not recorded one millisecond before it has passed, recorded one millisecond after.
  await admit(inPublic({ text: 'no name' }), NOW + 3599999);
  assert.equal(rows().filter(row => row.place === 'public').length, PER_HOUR);
  await admit(inPublic({ text: 'no name' }), NOW + 3600001);
  assert.equal(rows().filter(row => row.place === 'public').length, PER_HOUR + 1);
  await admit(body({ text: 'no name' }), NOW + KEEP_MS + 3600002);
  assert.deepEqual(rows().map(row => row.created), [NOW + KEEP_MS + 3600002], 'rows older than 14 days are removed');
  // The newest thousand of a place are kept, counted as rows, whatever numbers they carry.
  const insert = store.db.prepare("INSERT INTO refusals(n,created,place,sender,reasons) VALUES(?,?,'private','owner','not_addressed')");
  store.db.exec('BEGIN');
  for (let index = 0; index < MAX_ROWS + 50; index++) insert.run(5000 + index * 7, NOW + KEEP_MS + 2 * 3600000 + index);
  store.db.prepare("INSERT INTO refusals(created,place,sender,reasons) VALUES(?,'public','person','not_addressed')").run(NOW + KEEP_MS + 3 * 3600000);
  store.db.exec('COMMIT');
  await admit(body({ text: 'no name' }), NOW + KEEP_MS + 4 * 3600000);
  assert.deepEqual([rows().filter(row => row.place === 'private').length, rows().filter(row => row.place === 'public').length], [MAX_ROWS, 1]);
  assert.equal(rows().at(-1).created, NOW + KEEP_MS + 4 * 3600000);
});

test('known-bad: a failing log changes no decision and stops nothing', async t => {
  const { admit, reports, store, rows } = fixture(t);
  store.db.exec('DROP TABLE refusals');
  assert.deepEqual(await admit(body({ text: 'no name' })), { outcome: 'rejected', detail: undefined, queued: false });
  assert.deepEqual(await admit(body()), { outcome: 'queued', detail: undefined, queued: true });
  assert.deepEqual(reports.filter(item => item[0] === 'admission_log_failed'), [['admission_log_failed', 'Error']]);
  // No log at all is the v40 behaviour.
  assert.deepEqual(await admit(body({ text: 'no name' }), NOW, web(), null), { outcome: 'rejected', detail: undefined, queued: false });
  // A log that throws, which this one does not, still changes nothing; and nor does a journal that throws as well.
  const broken = { refused() { throw new Error('MARK from a log that does not catch'); } };
  reports.length = 0;
  assert.deepEqual(await admit(body({ text: 'no name' }), NOW, web(), broken), { outcome: 'rejected', detail: undefined, queued: false });
  assert.deepEqual(await admit(body(), NOW, web(), broken), { outcome: 'queued', detail: undefined, queued: true });
  assert.deepEqual(reports, [['admission_log_failed']]);
  const silent = await admitEvent({ body: body({ text: 'no name' }), channels, botUserId: base.botUserId, web: web(), store, now: NOW, log: broken,
    report: () => { throw new Error('journal failed'); } });
  assert.deepEqual(silent, { outcome: 'rejected', detail: undefined, queued: false });
  // A log that cannot be opened is reported, Clint starts without it, and the tool is told it is not recording.
  const said = [];
  assert.equal(AdmissionLog.open({ exec() { throw new Error('MARK disk detail'); } }, options(said)), null);
  assert.deepEqual([said, isRecording()], [[['admission_log_unavailable', 'Error']], false]);
  // Without the owner and the app it could not tell Clint's own posts from anyone's, so it does not open.
  for (const missing of [{ ownerId: undefined }, { appId: undefined }, { appId: '' }, { ownerId: 7 }, { ownerId: 'james' }]) {
    said.length = 0;
    assert.equal(AdmissionLog.open(store.db, { ...options(said), ...missing }), null, JSON.stringify(missing));
    assert.deepEqual(said, [['admission_log_unavailable', 'TypeError']]);
  }
  // Opened again, as at every restart, on a database that already holds the table and its rows.
  const reopened = AdmissionLog.open(store.db, options(said));
  assert.ok(reopened); assert.equal(isRecording(), true);
  assert.equal(reopened.refused({ body: body({ text: 'no name' }), channel: privateConfig, botUserId: base.botUserId, outcome: 'rejected', now: NOW }), 'recorded');
  assert.ok(AdmissionLog.open(store.db, options(said)));
  assert.equal(rows().length, 1);
  // A time that is not a time is a failure, reported; nothing is stored under it.
  said.length = 0;
  for (const now of ['MARK', NaN, undefined, null, Infinity, -1, 1.5]) {
    assert.equal(reopened.refused({ body: body({ text: 'no name' }), channel: privateConfig, botUserId: base.botUserId, outcome: 'rejected', now }), 'failed', String(now));
  }
  assert.deepEqual([said.length, said[0], rows().length], [7, ['admission_log_failed', 'TypeError'], 1]);
  for (const input of [{}, { body: null }, { body: { event: null }, now: NOW }, { body: { event: { type: 'message', message: 'MARK', previous_message: 7 } }, now: NOW }]) {
    assert.doesNotThrow(() => reopened.refused(input));
  }
  assert.doesNotMatch(JSON.stringify([said, rows()]), /MARK/);
});

test('the log is opened on the inbox and handed to the handler, with the owner, the app and the journal', () => {
  const source = readFileSync(new URL('../src/slack/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /\n {2}const log = AdmissionLog\.open\(store\.db, \{ report, ownerId: config\.ownerId, appId: config\.appId \}\);\n/);
  assert.match(source, /admitEvent\(\{ body, channels, botUserId: auth\.user_id, web, store, now: Date\.now\(\),\n {8}report, log, onPublicDenied: \(\) => void publicHealth\.check\(\) \}\);/);
  assert.match(source, /\nimport \{ AdmissionLog \} from '\.\/admission-log\.js';\n/);
});
