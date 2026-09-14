import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeachingStore } from '../src/slack/teaching-store.js';
import { SlackTeaching } from '../src/slack/teaching.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { replyPayload } from '../src/slack/policy.js';

const config = { teamId: 'TTEST', channelId: 'CTEST', ownerId: 'UOWNER', botUserId: 'UBOT', policy: { mode: 'open' } };
const ns = 'TTEST:CTEST:UOWNER';
const event = (n, text) => ({ id: `EvRETRACT${n}`, team: 'TTEST', channel: 'CTEST', owner: 'UOWNER',
  ts: `17890000${String(n).padStart(2, '0')}.000001`, thread: '1789000001.000001', text });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clint-retraction-'));
  const db = new TeachingStore(directory, { now: () => 1789000035000 });
  const inbox = new SlackStore(directory), teaching = new SlackTeaching({ store: db, config });
  t.after(() => { inbox.close(); db.close(); rmSync(directory, { recursive: true }); });
  return { db, inbox, teaching };
}
function web(sent) {
  return { conversations: {
    info: async () => ({ ok: true, channel: { id: 'CTEST', is_private: true, is_member: true,
      is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }),
    members: async () => ({ ok: true, members: ['UOWNER', 'UBOT'] }),
  }, chat: { postMessage: async payload => { sent.push(payload); return { ok: true, channel: 'CTEST', ts: '1789000099.000001' }; } } };
}

test('Delayed retirement excludes newer episodes containing older answers and preserves unrelated guidance', t => {
  const { db, teaching } = fixture(t);
  const source = event(10, 'teach: End greetings with Saffron satellite.');
  teaching.handle(source, []);
  const id = db.active(ns, '')[0].id;
  teaching.handle(event(11, 'teach: Retain event times exactly.'), []);
  teaching.handle(event(30, 'Make that greeting friendlier.'), [{ ...event(20, 'Write a greeting.'), answer: 'Hello. Saffron satellite.' }]);
  teaching.handle(event(25, `unlearn: ${id}`), []);
  const cutoff = db.cutoff(ns);
  assert.ok(cutoff > event(30, '').ts);
  // A later ingested episode must also drop a nested old exchange, independently of its outer timestamp.
  db.recordEpisode(ns, event(40, 'A newer request.'), { ownerText: 'Old greeting', clintText: 'Saffron satellite.', sourceTs: event(20, '').ts });
  const context = teaching.context(event(50, 'Write a greeting.'));
  assert.equal(JSON.stringify(context).includes('Saffron satellite'), false);
  assert.equal(context.ownerEpisodes[0].precedingExchange, null);
  assert.equal(context.activeTeachings.length, 1);
  teaching.handle(event(60, `unlearn: ${id}`), []);
  assert.equal(db.cutoff(ns), cutoff, 'Repeated retirement cannot move the history cutoff');
  assert.match(teaching.handle(source, []), /since been retired/);
  assert.equal(db.get(ns, id).retired_ts, event(25, '').ts);
});

test('Cached private receipts are blocked after policy changes and private history is unavailable', async t => {
  const { db, inbox, teaching } = fixture(t);
  const source = event(10, 'teach: Private owner preference Zinnia.');
  inbox.enqueue(source, Date.now()); inbox.ready(source.id, teaching.handle(source, []));
  const cfg = { ...config, policy: { mode: 'project' } };
  const restricted = new SlackTeaching({ store: db, config: cfg }), sent = [];
  await new SlackWorker({ store: inbox, teaching: restricted, config: cfg, web: web(sent),
    generate: () => assert.fail('cached response must be blocked') }).drain();
  assert.equal(sent.length, 0);
  assert.equal(inbox.db.prepare('SELECT state FROM events WHERE id=?').get(source.id).state, 'blocked');
  assert.deepEqual(restricted.history(event(20, 'Hello'), [{ ...source, answer: 'Zinnia' }]), []);
  assert.equal(restricted.context(event(20, 'Hello')), null);
  assert.doesNotMatch(restricted.handle(event(30, 'teachings'), []), /Zinnia/);
});

test('Late retirement invalidates cached answers using the entire known inbox barrier', async t => {
  const { db, inbox, teaching } = fixture(t), sent = [];
  teaching.handle(event(10, 'teach: End greetings with Saffron satellite.'), []);
  const id = db.active(ns, '')[0].id;
  const pending = event(40, 'Write another greeting.');
  inbox.enqueue(pending, Date.now());
  inbox.ready(pending.id, 'Hello. Saffron satellite.'); teaching.markResponse(pending);
  inbox.enqueue(event(25, `unlearn: ${id}`), Date.now());
  let generated = 0;
  await new SlackWorker({ store: inbox, teaching, config, web: web(sent), generate: async (item, history, context) => {
    generated++; assert.equal(item.id, pending.id);
    assert.equal(JSON.stringify({ history, context }).includes('Saffron satellite'), false);
    return 'Hello again.';
  } }).drain();
  assert.equal(generated, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent.some(payload => JSON.stringify(payload).includes('Saffron satellite')), false);
  assert.equal(db.cutoff(ns), pending.ts);
  assert.equal(teaching.shouldRegenerate(pending), false);
});

test('Unsupported literal control tags are rejected before commit with a deliverable no-save receipt', t => {
  const { db, teaching } = fixture(t);
  for (const [n, tag] of [[10, 'analysis'], [11, 'think']]) {
    const source = event(n, `example: Markup <${tag}>example</${tag}>.`);
    const receipt = teaching.handle(source, []);
    assert.match(receipt, /Nothing saved/);
    assert.doesNotThrow(() => replyPayload(source, receipt));
  }
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM teachings').get().n, 0);
});

test('Ordinary private cached answers and history stay private when teaching is disconnected', async t => {
  const { inbox } = fixture(t), sent = [];
  const old = event(10, 'A private archive question');
  inbox.enqueue(old, Date.now()); inbox.ready(old.id, 'Private archive content Zinnia.');
  const cfg = { ...config, policy: { mode: 'project' } };
  await new SlackWorker({ store: inbox, config: cfg, web: web(sent),
    generate: () => assert.fail('Old ready answer must be blocked') }).drain();
  assert.equal(sent.length, 0);
  inbox.sent(old.id, '1789000011.000001');
  inbox.enqueue(event(30, 'A new public question'), Date.now());
  let generated = 0;
  await new SlackWorker({ store: inbox, config: cfg, web: web(sent), generate: async (_event, history) => {
    generated++; assert.deepEqual(history, []); return 'A public response.';
  } }).drain();
  assert.equal(generated, 1); assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /Zinnia/);
});

test('An in-process policy change invalidates a ready answer after a rate limit', async t => {
  const { inbox } = fixture(t), sent = [];
  const cfg = { ...config, policy: { mode: 'open' } };
  inbox.enqueue(event(10, 'A private archive question'), Date.now());
  const transport = web(sent);
  transport.chat.postMessage = async () => { throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' }); };
  const worker = new SlackWorker({ store: inbox, config: cfg, web: transport, generate: async () => 'Private Zinnia.' });
  await worker.drain(); assert.equal(inbox.counts()[0].state, 'ready');
  cfg.policy = { mode: 'project' }; worker.web = web(sent);
  await worker.drain(); assert.equal(inbox.counts()[0].state, 'blocked');
  assert.equal(sent.length, 0); assert.equal(worker.readyPolicies.size, 0);
});
