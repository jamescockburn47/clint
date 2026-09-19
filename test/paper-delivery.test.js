import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProactiveStore } from '../src/slack/proactive-store.js';
import { deliverPapers } from '../src/slack/paper-delivery.js';
import { paperDirectory, papersPending } from '../src/slack/nightly-papers.js';
import { createConversationContext } from '../src/conversation-context.js';
import { outboundArtifactSafe, outboundQuerySafe } from '../src/outbound-query.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'paper-delivery-'));
  const config = { dataDir, papersEnabled: true, channelId: 'CTEST12345', ownerId: 'UTEST12345',
    teamId: 'TTEST12345', policy: { mode: 'open', blockedTopics: [] } };
  const store = new ProactiveStore(join(dataDir, 'data', 'proactive'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const scopeKey = 'private-owner', date = '2026-09-20';
  const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:TTEST12345:CTEST12345',
    actorId: config.ownerId, ownerId: config.ownerId, audience: 'group', policy: config.policy, localOnly: true });
  mkdirSync(paperDirectory(config), { recursive: true });
  for (const kind of ['paper', 'self_review']) {
    const filename = `${date}-${kind}.html`;
    const html = '<html>' + 'Substantive technical discussion. '.repeat(1500) + '</html>';
    writeFileSync(join(paperDirectory(config), filename), html);
    store.ensure(date, kind, scopeKey, 1);
    store.update(`${date}:${kind}`, 'complete', 2, { report: { htmlFile: filename, title: 'Technical paper',
      htmlSha256: createHash('sha256').update(html).digest('hex') } });
  }
  store.ensure(date, 'briefing', scopeKey, 1);
  store.update(`${date}:briefing`, 'sent', 2, { replyTs: '1789440000.000001' });
  return { config, store, scopeKey, date, scope, now: () => 3, signal: new AbortController().signal,
    authorize: async () => true };
}

test('two private HTML papers attach once to the confirmed morning thread', async t => {
  const args = fixture(t), calls = [];
  const web = { files: { uploadV2: async input => {
    calls.push(input);
    assert.equal(args.store.get(`${args.date}:paper_delivery`).state, 'sending');
    return { ok: true, files: [{ ok: true, files: [{ id: 'FTEST1' }, { id: 'FTEST2' }] }] };
  } } };
  await deliverPapers({ ...args, web }); await deliverPapers({ ...args, web });
  assert.equal(calls.length, 1); assert.equal(calls[0].channel_id, args.config.channelId);
  assert.equal(calls[0].thread_ts, '1789440000.000001');
  assert.equal(calls[0].file_uploads.length, 2);
  assert.equal(args.store.get(`${args.date}:paper_delivery`).state, 'sent');
});

test('changed audience or substituted artifact blocks upload before network mutation', async t => {
  for (const attack of ['audience', 'filename', 'changed-bytes']) {
    const args = fixture(t); let uploads = 0;
    if (attack === 'filename') args.store.update(`${args.date}:paper`, 'complete', 2,
      { report: { htmlFile: '../../secret.html' } });
    else if (attack === 'changed-bytes') writeFileSync(join(paperDirectory(args.config), `${args.date}-paper.html`), 'substituted');
    else args.authorize = async () => false;
    await deliverPapers({ ...args, web: { files: { uploadV2: async () => { uploads++; } } } });
    assert.equal(uploads, 0);
    assert.equal(args.store.get(`${args.date}:paper_delivery`).state, 'blocked');
  }
});

test('uncertain upload is retained without blind retry or duplicate morning message', async t => {
  const args = fixture(t); let uploads = 0;
  const web = { files: { uploadV2: async () => { uploads++; throw Error('socket_closed_after_send'); } } };
  await deliverPapers({ ...args, web }); args.store.recover(4);
  await deliverPapers({ ...args, web });
  assert.equal(uploads, 1); assert.equal(args.store.get(`${args.date}:paper_delivery`).state, 'uncertain');
  assert.equal(args.store.get(`${args.date}:briefing`).state, 'sent');
});

test('briefing waits for a cooling-down paper but can report exhausted attempts', t => {
  const args = fixture(t), id = `${args.date}:paper`;
  args.store.update(id, 'running', 3); args.store.update(id, 'pending', 4);
  assert.equal(papersPending(args.store, args.date, args.scopeKey), true);
  for (let i = 0; i < 2; i++) { args.store.update(id, 'running', 5); args.store.update(id, 'pending', 6); }
  assert.equal(papersPending(args.store, args.date, args.scopeKey), false);
});

test('artifact scanning covers the entire file without expanding the public query limit', () => {
  const long = 'Technical discussion. '.repeat(1500);
  assert.equal(outboundArtifactSafe(long), true);
  assert.equal(outboundQuerySafe(long), false);
  assert.equal(outboundArtifactSafe('a'.repeat(15996) + ' xoxb-1234567890-secretvalue'), false);
  assert.equal(outboundArtifactSafe(long + 'api_key=&quot;configured-secret&quot;', { apiKey: 'configured-secret' }), false);
  assert.equal(outboundArtifactSafe('a'.repeat(2 * 1024 * 1024 + 1)), false);
});
