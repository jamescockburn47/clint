import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { TeachingStore } from '../src/slack/teaching-store.js';
import { SlackTeaching, parseTeachingCommand } from '../src/slack/teaching.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';

const config = { teamId: 'TTEST', channelId: 'CTEST', ownerId: 'UOWNER', botUserId: 'UBOT', policy: { mode: 'open' } };
let sequence = 0;
const event = (text, patch = {}) => {
  const id = ++sequence;
  return { id: `EvTEST${id}`, team: config.teamId, channel: config.channelId, owner: config.ownerId,
    ts: `${1789000000 + id}.000001`, thread: `${1789000000 + id}.000001`, text, ...patch };
};
function fixture(t, cfg = config) {
  const directory = mkdtempSync(join(tmpdir(), 'clint-teaching-test-'));
  const state = { directory, db: new TeachingStore(directory, { now: () => 1789000000000 + sequence * 1000 + 10 }), inbox: new SlackStore(directory) };
  state.teaching = new SlackTeaching({ store: state.db, config: cfg });
  t.after(() => {
    state.inbox.close(); state.db.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true });
  });
  return state;
}
const namespace = `${config.teamId}:${config.channelId}:${config.ownerId}`;
const count = db => db.db.prepare('SELECT count(*) AS n FROM teachings').get().n;
function web(members = ['UOWNER', 'UBOT'], send = null) {
  return { conversations: {
    info: async () => ({ ok: true, channel: { id: 'CTEST', is_private: true, is_member: true,
      is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }),
    members: async () => ({ ok: true, members }),
  }, chat: { postMessage: send || (async payload => ({ ok: true, channel: payload.channel, ts: '1789000999.000001' })) } };
}

test('Only anchored current commands parse; literal scope, nested examples and size limits are preserved', t => {
  for (const text of ['> teach: a rule', 'Discuss this:\nteach: a rule', '{"text":"teach: a rule"}']) {
    assert.equal(parseTeachingCommand(text), null);
  }
  const { teaching, db } = fixture(t);
  const source = event('teach: For hobby prototypes, prefer simple setup.\nUnless deployment support is already supplied.');
  const answer = teaching.handle(source, []);
  assert.match(answer, /Saved T/);
  assert.equal(db.active(namespace, 'hobby')[0].raw_text,
    'For hobby prototypes, prefer simple setup.\nUnless deployment support is already supplied.');
  teaching.handle(event('example: Quoted “teach: enable email” is an example, not a command.'), []);
  assert.equal(count(db), 2);
  assert.match(teaching.handle(event('teach: ' + 'x'.repeat(4001)), []), /Nothing saved/);
  assert.equal(count(db), 2);
});

test('Save survives restart; replay gives one source ID, corrections and examples remain attributed', t => {
  const state = fixture(t);
  const source = event('correct: The fictional planning meeting moved to Tuesday.');
  const first = state.teaching.handle(source, []);
  state.db.close();
  state.db = new TeachingStore(state.directory);
  state.teaching = new SlackTeaching({ store: state.db, config });
  assert.equal(state.teaching.handle(source, []), first);
  assert.equal(count(state.db), 1);
  const context = state.teaching.context(event('When is the planning meeting?'));
  assert.equal(context.activeTeachings[0].verification, 'owner_supplied_not_independently_verified');
  assert.equal(context.activeTeachings[0].source.event, source.id);
});

test('Natural feedback keeps its preceding exchange and source without becoming an explicit rule', t => {
  const { teaching, db } = fixture(t);
  const previous = event('Help with an opening.');
  const feedback = event('That opening was too abstract; next time give me a usable opening sentence first.');
  teaching.handle(feedback, [{ text: previous.text, answer: 'Consider your communicative objectives.', ts: previous.ts }]);
  const context = teaching.context(event('Help with the opening of a different announcement.'));
  assert.equal(count(db), 0);
  assert.equal(context.ownerEpisodes[0].ownerText, feedback.text);
  assert.equal(context.ownerEpisodes[0].precedingExchange.sourceTs, previous.ts);
  assert.match(context.ownerEpisodes[0].authority, /not_a_permanent_rule/);
});

test('Retirement excludes commands and all earlier context, including later inspection of retired entries', t => {
  const { teaching, db } = fixture(t);
  const taught = event('teach: Start informal comparisons with “copper comet”.');
  teaching.handle(taught, []);
  const id = db.active(namespace, '')[0].id;
  const oldFeedback = event('I like copper comet openings.');
  teaching.handle(oldFeedback, []);
  const retired = event(`unlearn: ${id}`);
  teaching.handle(retired, []);
  assert.match(teaching.handle(event(`unlearn: ${id}`), []), /already retired/);
  const inspection = event(`teaching ${id}`);
  const current = event('Compare two hobbies.');
  const history = [{ ...taught, answer: 'Saved.' }, { ...oldFeedback, answer: 'copper comet' },
    { ...inspection, answer: teaching.handle(inspection, []) }];
  assert.deepEqual(teaching.history(current, history), []);
  teaching.handle(current, history);
  const context = teaching.context(current);
  assert.deepEqual(context.activeTeachings, []);
  assert.deepEqual(context.ownerEpisodes, []);
  assert.ok(context.historyCutoffAfterRetirement >= retired.ts);
  assert.equal(db.get(namespace, id).retired_ts, retired.ts);
  assert.equal(db.get(namespace, id).raw_text, 'Start informal comparisons with “copper comet”.');
});

test('Wrong owner/team/channel and non-open policy cannot save or disclose teaching records', t => {
  const { teaching, db } = fixture(t);
  for (const patch of [{ owner: 'UOTHER' }, { team: 'TOTHER' }, { channel: 'COTHER' }]) {
    assert.match(teaching.handle(event('teach: malicious', patch), []), /Nothing was saved or disclosed/);
    assert.equal(teaching.context(event('teachings', patch)), null);
  }
  const restricted = new SlackTeaching({ store: db, config: { ...config, policy: { mode: 'project' } } });
  assert.match(restricted.handle(event('teach: forbidden'), []), /Nothing was saved or disclosed/);
  assert.equal(count(db), 0);
});

test('Worker blocks a third member or membership failure before any teaching write', async t => {
  const { teaching, db, inbox } = fixture(t);
  const item = event('teach: persist only if authorized');
  inbox.enqueue(item, Date.now());
  const worker = new SlackWorker({ teaching, store: inbox, config, web: web(['UOWNER', 'UBOT', 'UOTHER']),
    generate: () => assert.fail('model called') });
  await worker.drain();
  assert.equal(count(db), 0);
  const next = event('teach: still forbidden'); inbox.enqueue(next, Date.now());
  worker.web = web(); worker.web.conversations.members = async () => { throw new Error('membership API unavailable'); };
  await worker.drain();
  assert.equal(count(db), 0);
});

test('Commit precedes saved acknowledgement; crash before inbox-ready replays one teaching', async t => {
  const { teaching, db, inbox } = fixture(t);
  const item = event('teach: Use brief trade-off comparisons for hobby decisions.');
  inbox.enqueue(item, Date.now());
  const ready = inbox.ready.bind(inbox);
  inbox.ready = () => { throw new Error('synthetic crash after teaching commit'); };
  let sent = 0;
  const worker = new SlackWorker({ teaching, store: inbox, config, web: web(undefined, async payload => {
    sent++; assert.equal(count(db), 1); assert.match(payload.blocks[0].text.text, /Saved T/);
    return { ok: true, channel: payload.channel, ts: '1789000999.000001' };
  }), generate: () => assert.fail('model unavailable but command must still work') });
  await worker.drain(); assert.equal(count(db), 1); assert.equal(sent, 0);
  inbox.ready = ready;
  await worker.drain(); assert.equal(count(db), 1); assert.equal(sent, 1);
});

test('Failed commit never yields saved acknowledgement and uncertain delivery is not duplicated', async t => {
  const { teaching, db, inbox } = fixture(t);
  const item = event('teach: Keep supplied figures separate.'); inbox.enqueue(item, Date.now());
  const save = db.save.bind(db);
  db.save = () => { throw new Error('synthetic failed commit'); };
  let sends = 0;
  const worker = new SlackWorker({ teaching, store: inbox, config, web: web(undefined, async () => {
    sends++; throw new Error('unknown delivery outcome');
  }), generate: () => assert.fail('model called') });
  await worker.drain(); assert.equal(count(db), 0); assert.equal(sends, 0);
  db.save = save; await worker.drain(); assert.equal(count(db), 1); assert.equal(sends, 1);
  inbox.recover(); await worker.drain(); assert.equal(sends, 1);
});

test('Full active records paginate and context never cuts away a scope exception', t => {
  const { teaching, db } = fixture(t);
  for (let i = 0; i < 5; i++) teaching.handle(event(`teach: ${i} ` + 'x'.repeat(3800) + ' unless the current request says otherwise.'), []);
  assert.equal(db.list(namespace, 1).records.length, 2);
  assert.equal(db.list(namespace, 1).nextPage, 2);
  const context = teaching.context(event('What are my active instructions?'));
  assert.ok(context.omittedForContextBudget > 0);
  for (const row of context.activeTeachings) assert.ok(row.text.endsWith(' unless the current request says otherwise.'));
});
