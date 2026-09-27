import { authorizeChannel } from './channel-access.js';

/** Public channel availability must never decide whether the private service starts. */
export async function checkStartupChannels(web, channels, report) {
  for (const channel of channels) {
    if (!channel.workspaceShared) {
      if (!await authorizeChannel(web, channel)) throw new Error('slack_private_channel_not_ready');
    } else {
      const label = channel.peerLane === true ? 'lane' : 'public';
      try { report(await authorizeChannel(web, channel) ? `${label}_channel_ready` : `${label}_channel_blocked`); }
      catch { report(`${label}_channel_unavailable`); }
    }
  }
}

/** Source-free owner notices, on transitions only; never notify an unauthorized audience. */
export class PublicChannelHealth {
  constructor({ web, channels, report }) {
    Object.assign(this, { web, channels, report });
    this.previous = undefined;
    this.running = null;
  }
  check() {
    if (!this.running) this.running = this.inspect().finally(() => { this.running = null; });
    return this.running;
  }
  async inspect() {
    const publicConfig = this.channels.find(channel => channel.workspaceShared && channel.peerLane !== true);
    if (!publicConfig) return;
    let status;
    try { status = await authorizeChannel(this.web, publicConfig) ? 'ready' : 'blocked'; }
    catch { status = 'unavailable'; }
    if (status === this.previous) return;
    const initialHealthy = this.previous === undefined && status === 'ready';
    this.previous = status;
    this.report(`public_channel_${status}`);
    if (initialHealthy) return;
    const privateConfig = this.channels.find(channel => !channel.workspaceShared);
    try {
      if (!privateConfig || privateConfig.policy?.mode !== 'open' || !await authorizeChannel(this.web, privateConfig)) {
        this.report('public_health_notice_private_scope_denied'); return;
      }
      const text = status === 'ready' ? 'Clint’s public channel is available again.'
        : status === 'blocked' ? 'Clint cannot answer in the public channel because its channel access check failed. Private chat is still available. Check channel membership, archive or frozen status.'
        : 'Clint cannot currently verify public-channel access with Slack. Private chat remains separate; the channel check will retry automatically.';
      const sent = await this.web.chat.postMessage({ channel: privateConfig.channelId, text,
        unfurl_links: false, unfurl_media: false, parse: 'none' });
      if (sent?.ok !== true || sent.channel !== privateConfig.channelId) throw new Error('unconfirmed_notice');
      this.report('public_health_notice_sent');
    } catch {
      // An ambiguous send is not retried: the redacted journal records it for inspection.
      this.report('public_health_notice_unconfirmed');
    }
  }
}
