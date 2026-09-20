import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeActor, channelConfigs } from '../src/slack/workspace-channels.js';
import { acceptMention, allowedChannel } from '../src/slack/policy.js';
const base = { teamId: 'TLOCAL', appId: 'AAPP', ownerId: 'UOWNER', botUserId: 'UBOT',
  channelId: 'CPRIVATE', publicChannelId: 'CPUBLIC', policy: { mode: 'open' } };
const [privateCfg, cfg] = channelConfigs(base);
const event = { team: 'TLOCAL', channel: 'CPUBLIC', owner: 'UEXTERNAL' };
const user = { id: event.owner, team_id: 'TEXTERNAL', is_bot: false };
const web = pages => ({ users: { info: async () => ({ ok: true, user }) },
  conversations: { members: async () => pages.shift() } });
test('external identity requires current exact-channel membership, including later pages', async () => {
  const api = web([{ ok: true, members: ['UOTHER'], response_metadata: { next_cursor: 'next' } },
    { ok: true, members: [event.owner] }]);
  assert.equal(await authorizeActor(api, cfg, event), true);
  api.conversations.members = async args => {
    assert.equal(args.channel, 'CPUBLIC'); return { ok: true, members: [] };
  };
  assert.equal(await authorizeActor(api, cfg, event), false);
  assert.equal(await authorizeActor(api, privateCfg, { ...event, channel: 'CPRIVATE' }), false);
});
test('incomplete, malformed, failed and looping membership results do not authorize', async () => {
  for (const result of [{ ok: false }, { ok: true }, { ok: true, members: [null] },
    { ok: true, members: [], response_metadata: { next_cursor: 42 } }]) {
    assert.equal(await authorizeActor(web([result]), cfg, event), false);
  }
  const loop = { ok: true, members: [], response_metadata: { next_cursor: 'same' } };
  assert.equal(await authorizeActor(web([loop, loop]), cfg, event), false);
  const api = web([]); api.conversations.members = async () => { throw new Error('offline'); };
  await assert.rejects(authorizeActor(api, cfg, event), /offline/);
});
test('sharing is allowed only for configured public scope; envelope installation stays local', () => {
  const channel = { id: 'CPUBLIC', is_private: false, is_member: true, is_archived: false,
    is_shared: true, is_ext_shared: true, is_org_shared: false };
  assert.equal(allowedChannel({ ok: true, channel }, cfg), true);
  for (const change of [{ is_frozen: true }, { is_mpim: true }]) {
    assert.equal(allowedChannel({ ok: true, channel: { ...channel, ...change } }, cfg), false);
  }
  assert.equal(allowedChannel({ ok: true, channel: { ...channel, id: 'CPRIVATE', is_private: true } }, privateCfg), false);
  const body = { type: 'event_callback', team_id: 'TLOCAL', api_app_id: 'AAPP', event_id: 'EvCONNECT',
    is_ext_shared_channel: true, event: { type: 'message', channel_type: 'channel', team: 'TEXTERNAL',
      channel: 'CPUBLIC', user: 'UEXTERNAL', ts: '1789633206.000001', text: 'Clint, hello' } };
  assert.equal(acceptMention(body, cfg, 'UBOT').owner, 'UEXTERNAL');
  assert.equal(acceptMention({ ...body, team_id: 'TOTHER' }, cfg, 'UBOT'), null);
  assert.equal(acceptMention({ ...body, api_app_id: 'AOTHER' }, cfg, 'UBOT'), null);
  assert.equal(acceptMention(body, privateCfg, 'UBOT'), null);
});
