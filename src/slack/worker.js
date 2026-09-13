import { allowedChannel, replyPayload } from './policy.js';

export class SlackWorker {
  constructor({ store, config, web, generate, report = () => {} }) {
    Object.assign(this, { store, config, web, generate, report });
    this.running = null;
    this.stopped = false;
  }
  drain() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    for (let event; !this.stopped && (event = this.store.next());) {
      // Persisted work must be re-authorized against the CURRENT deployment policy.
      if (event.team !== this.config.teamId || event.channel !== this.config.channelId ||
          event.owner !== this.config.ownerId) {
        this.store.setState(event.id, 'blocked', 'scope_changed'); continue;
      }
      try {
        const info = await this.web.conversations.info({ channel: event.channel });
        if (!allowedChannel(info, this.config)) {
          this.store.setState(event.id, 'blocked', 'channel_not_private_local'); continue;
        }
      } catch {
        this.report('channel_check_failed'); return;
      }
      let answer = event.answer;
      if (event.state === 'queued') {
        this.store.generating(event.id);
        try {
          answer = await this.generate(event, this.store.history(event));
          replyPayload(event, answer); // Validate before persisting a sendable result.
          this.store.ready(event.id, answer);
        } catch {
          this.store.setState(event.id, event.attempts >= 2 ? 'failed' : 'queued', 'generation_failed');
          this.report('generation_failed'); return;
        }
      }
      // Recheck sharing immediately before outbound delivery, after potentially slow generation.
      try {
        if (!allowedChannel(await this.web.conversations.info({ channel: event.channel }), this.config)) {
          this.store.setState(event.id, 'blocked', 'channel_changed_before_send'); continue;
        }
      } catch { this.report('channel_check_failed'); return; }
      this.store.setState(event.id, 'sending');
      try {
        const result = await this.web.chat.postMessage(replyPayload(event, answer));
        if (!result.ok || result.channel !== event.channel || !/^\d{10}\.\d{6}$/.test(result.ts || '')) {
          throw new Error('slack_send_unconfirmed');
        }
        this.store.sent(event.id, result.ts);
        this.report('reply_sent');
      } catch {
        // SDK retries disabled: a lost response is not proof that Slack did not post.
        this.store.setState(event.id, 'uncertain', 'delivery_requires_reconciliation');
        this.report('delivery_uncertain');
      }
    }
  }
  async stop() { this.stopped = true; await this.running; }
}
