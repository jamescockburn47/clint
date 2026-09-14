import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSlackGenerator } from '../src/slack/model.js';
import { SlackWorker, errorCode } from '../src/slack/worker.js';
import { authorizeChannel } from '../src/slack/channel-access.js';
import { replyPayload } from '../src/slack/policy.js';

const config = { teamId: 'T12345678', channelId: 'C12345678', ownerId: 'U12345678' };
const event = { team: config.teamId, channel: config.channelId, owner: config.ownerId, text: 'Complete document' };

test('unfinished core text cannot become a delivered complete answer', async () => {
  const generate = makeSlackGenerator(config, { getResponse: async () => ({
    text: 'The complete answer begins with', meta: { truncated: true },
  }) });
  await assert.rejects(generate(event, []), /slack_incomplete_core_output/);
});

test('model thought delimiters seen in the live greeting are regenerated, never delivered', async () => {
  for (const text of ['Hi James.\n</think>\nHi James.', '<think>private reasoning</think>Hello',
    '<analysis>internal</analysis>Reply']) {
    assert.throws(() => replyPayload(event, text), /invalid_reply/);
    let calls = 0;
    const generate = makeSlackGenerator(config, { getResponse: async () => ({ text: ++calls === 1 ? text : 'Hi James.' }) });
    assert.equal(await generate(event, []), 'Hi James.');
    assert.equal(calls, 2);
  }
});

test('failure notices recheck scope after slow generation; unknown metadata fails closed', async () => {
  for (const channel of [{}, { ok: true, channel: { is_shared: true } }]) {
    let sends = 0;
    const worker = new SlackWorker({ config, web: {
      conversations: { info: async () => channel }, chat: { postMessage: async () => { sends++; } },
    } });
    await worker.notify(event, 'no valid reply');
    assert.equal(sends, 0);
  }
});

test('source-shaped error strings cannot be recorded in Slack diagnostics', () => {
  for (const secret of ['PRIVATE_CLIENT_NAME', 'xoxb-synthetic-private-token', 'legal.matter:private']) {
    assert.equal(errorCode(Object.assign(new Error(secret), { name: secret, code: secret })), 'Error');
  }
  assert.equal(errorCode(new Error('slack_core_unavailable')), 'slack_core_unavailable');
});

test('archive-capable channel rejects third members, missing/partial membership and wrong bot', async () => {
  const cfg = { ...config, policy: { mode: 'open' }, botUserId: 'UBOT' };
  const info = { ok: true, channel: { id: cfg.channelId, is_private: true, is_member: true,
    is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } };
  for (const members of [[cfg.ownerId, 'UBOT', 'UOTHER'], [cfg.ownerId, 'UOTHER'],
    [cfg.ownerId, cfg.ownerId], [], undefined]) {
    assert.equal(await authorizeChannel({ conversations: { info: async () => info,
      members: async () => ({ ok: true, members }) } }, cfg), false);
  }
  const good = { conversations: { info: async () => info,
    members: async () => ({ ok: true, members: [cfg.ownerId, 'UBOT'] }) } };
  assert.equal(await authorizeChannel(good, cfg), true);
  good.conversations.members = async () => ({ ok: true, members: [cfg.ownerId, 'UBOT'],
    response_metadata: { next_cursor: 'more' } });
  assert.equal(await authorizeChannel(good, cfg), false);
});
