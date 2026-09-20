import test from 'node:test';
import assert from 'node:assert/strict';
import { namesClint, acceptMention } from '../src/slack/policy.js';
import { SlackWorker } from '../src/slack/worker.js';
import { loadSlackConfig } from '../src/slack/config.js';

test('explicit name accepts punctuation/case/native mention and rejects missing names or substrings', () => {
  for (const text of ['Clint, hello', 'hello clint', 'CLINT?', '@Clint help', '<@UBOT> help', 'Clint’s view?']) {
    assert.equal(namesClint(text, 'UBOT'), true, text);
  }
  for (const text of ['Hello James', 'yes please', 'Clinton', 'mcclint', 'clint123', 'clint_test', '<@UOTHER>', 'éclint']) {
    assert.equal(namesClint(text, 'UBOT'), false, text);
  }
});

test('same explicit-name rule for owner/guest and public/private, root/thread; current text unchanged', () => {
  for (const shared of [true, false]) for (const threaded of [true, false]) {
    const cfg = { teamId: 'TLOCAL', appId: 'AAPP', ownerId: 'UOWNER', channelId: 'CCHAN', workspaceShared: shared };
    const body = { type: 'event_callback', team_id: 'TLOCAL', api_app_id: 'AAPP', event_id: 'EvTEST',
      event: { type: 'message', channel_type: shared ? 'channel' : 'group', channel: 'CCHAN',
        user: shared ? 'UGUEST' : 'UOWNER', ts: '1789882000.000001',
        ...(threaded ? { thread_ts: '1789881000.000001' } : {}), text: 'Clint, answer Jason' } };
    assert.equal(acceptMention(body, cfg, 'UBOT').text, body.event.text);
    body.event.text = 'Answer Jason';
    assert.equal(acceptMention(body, cfg, 'UBOT'), null);
  }
});

test('running configuration always enables the queue guard; old unaddressed queued/cached events stay silent', async () => {
  const cfg = loadSlackConfig({ SLACK_APP_TOKEN:'xapp-test', SLACK_BOT_TOKEN:'xoxb-test',
    SLACK_APP_ID:'A12345678', SLACK_TEAM_ID:'T12345678', SLACK_OWNER_ID:'U12345678',
    SLACK_CHANNEL_ID:'C12345678', SLACK_DATA_DIR:'/tmp/mention-tests' });
  assert.equal(cfg.requireExplicitMention, true);
  for (const state of ['queued', 'ready']) {
    let next = { id:'old', state, text:'yes please' }, blocked;
    const worker = new SlackWorker({ config:cfg,
      store: { next: () => { const value=next; next=null; return value; },
        setState: (...args) => { blocked=args; } },
      web: {}, generate: () => { throw Error('must not generate'); } });
    await worker.drain();
    assert.deepEqual(blocked, ['old','blocked','explicit_name_required']);
  }
});
