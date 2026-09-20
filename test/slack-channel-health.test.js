import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStartupChannels, PublicChannelHealth } from '../src/slack/channel-health.js';
import { channelConfigs, authorizeActor } from '../src/slack/workspace-channels.js';
const base = { teamId: 'TLOCAL', channelId: 'CPRIVATE', publicChannelId: 'CPUBLIC',
  ownerId: 'UOWNER', botUserId: 'UBOT', policy: { mode: 'open' } };
const channels = channelConfigs(base);
function fixture() {
  const state = { blocked: false, failure: false, privateExtra: false, messages: [], logs: [], members: ['UNEW1'], calls: 0 };
  const web = { conversations: {
    info: async ({ channel }) => {
      if (channel === 'CPUBLIC' && state.failure) throw new Error('private raw failure');
      return { ok: true, channel: { id: channel, is_private: channel === 'CPRIVATE', is_member: true,
        is_archived: channel === 'CPUBLIC' && state.blocked, is_shared: channel === 'CPUBLIC',
        is_ext_shared: channel === 'CPUBLIC', is_org_shared: false } };
    },
    members: async ({channel}) => ({ok:true, members:channel === 'CPRIVATE'
      ? ['UOWNER','UBOT', ...(state.privateExtra ? ['UOTHER'] : [])] : state.members}),
  }, users: { info: async ({user}) => ({ok:true,user:{id:user,team_id:'TFOREIGN',is_bot:false}}) },
  chat: { postMessage: async data => { state.calls++; state.messages.push(data); return {ok:true,channel:data.channel}; } } };
  return { state, web, report: value => state.logs.push(value) };
}
test('unavailable public route cannot prevent private startup; private failure still blocks', async () => {
  const f=fixture(); f.state.failure=true;
  await checkStartupChannels(f.web, channels, f.report);
  assert.deepEqual(f.state.logs, ['public_channel_unavailable']);
  f.state.privateExtra=true;
  await assert.rejects(checkStartupChannels(f.web, channels, f.report), /private_channel_not_ready/);
});
test('public access transitions notify only the verified private owner and recover automatically', async () => {
  const f=fixture(); const monitor=new PublicChannelHealth({...f,channels});
  await monitor.check(); assert.equal(f.state.calls,0);
  f.state.blocked=true; await monitor.check(); await monitor.check();
  assert.equal(f.state.calls,1); assert.equal(f.state.messages[0].channel,'CPRIVATE');
  f.state.blocked=false; await monitor.check(); assert.equal(f.state.calls,2);
  f.state.privateExtra=true; f.state.failure=true; await monitor.check();
  assert.equal(f.state.calls,2); assert.ok(f.state.logs.includes('public_health_notice_private_scope_denied'));
  assert.ok(!JSON.stringify(f.state.messages).includes('private raw failure'));
});
test('another invited external user is admitted without config changes; removed and unrelated users fail', async () => {
  const f=fixture(); const cfg=channels[1];
  const event = owner => ({team:base.teamId,channel:cfg.channelId,owner});
  assert.equal(await authorizeActor(f.web,cfg,event('UNEW1')),true);
  assert.equal(await authorizeActor(f.web,cfg,event('UNEW2')),false);
  f.state.members.push('UNEW2');
  assert.equal(await authorizeActor(f.web,cfg,event('UNEW2')),true);
  f.state.members=['UNEW2'];
  assert.equal(await authorizeActor(f.web,cfg,event('UNEW1')),false);
  assert.equal(await authorizeActor(f.web,cfg,event('UUNINVITED')),false);
});
test('unconfirmed owner notices are logged and not blindly duplicated', async () => {
  const f=fixture(); f.state.blocked=true;
  f.web.chat.postMessage=async()=>{f.state.calls++; throw new Error('timeout');};
  const monitor=new PublicChannelHealth({...f,channels});
  await Promise.all([monitor.check(),monitor.check()]); await monitor.check();
  assert.equal(f.state.calls,1); assert.ok(f.state.logs.includes('public_health_notice_unconfirmed'));
});
test('a restricted private policy does not become an owner-notification bypass', async () => {
  const f=fixture(); f.state.blocked=true;
  const restricted=[{...channels[0],policy:{mode:'restricted'}},channels[1]];
  await new PublicChannelHealth({...f,channels:restricted}).check();
  assert.equal(f.state.calls,0);
  assert.ok(f.state.logs.includes('public_health_notice_private_scope_denied'));
});
