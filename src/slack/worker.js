import { replyPayload } from './policy.js';
import { authorizeChannel } from './channel-access.js';
import { safeErrorCode } from '../error-code.js';

/** How long a message may wait for an unavailable core before it is given up and the owner told. */
export const CORE_WAIT_LIMIT_MS = 6 * 60 * 60 * 1000;
const NOTICE_PREFIX = 'Clint could not answer this message';

/** Short, source-free error code for journal lines. */
export function errorCode(err) {
  const known = new Set(['slack_core_unavailable', 'slack_incomplete_core_output',
    'slack_invalid_core_output', 'slack_invalid_reply', 'slack_send_unconfirmed']);
  return known.has(err?.message) ? err.message : safeErrorCode(err);
}

/** Slack's SDK distinguishes definitive platform refusals from unknown transport outcomes. */
export function classifySendFailure(err) {
  if (err?.code === 'slack_webapi_rate_limited_error') return 'rate_limited';
  if (err?.code === 'slack_webapi_platform_error' && typeof err.data?.error === 'string') return 'rejected';
  return 'uncertain';
}

export class SlackWorker {
  constructor({ store, config, web, generate, report = () => {}, now = Date.now }) {
    Object.assign(this, { store, config, web, generate, report, now });
    this.running = null;
    this.stopped = false;
  }
  drain() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  /** Best-effort thread notice so a dropped message is never silent. Never carries source or error text. */
  async notify(event, reason) {
    try {
      if (event.team !== this.config.teamId || event.channel !== this.config.channelId ||
          event.owner !== this.config.ownerId ||
          !await authorizeChannel(this.web, this.config)) {
        this.report('notice_scope_changed'); return;
      }
      await this.web.chat.postMessage({ channel: event.channel, thread_ts: event.thread,
        text: `${NOTICE_PREFIX} (${reason}). It will not be retried.`,
        unfurl_links: false, unfurl_media: false, parse: 'none' });
    } catch (err) { this.report('notice_failed', errorCode(err)); }
  }
  async run() {
    for (let event; !this.stopped && (event = this.store.next());) {
      // Persisted work must be re-authorized against the CURRENT deployment policy.
      if (event.team !== this.config.teamId || event.channel !== this.config.channelId ||
          event.owner !== this.config.ownerId) {
        this.store.setState(event.id, 'blocked', 'scope_changed'); continue;
      }
      try {
        if (!await authorizeChannel(this.web, this.config)) {
          this.store.setState(event.id, 'blocked', 'channel_not_private_local'); continue;
        }
      } catch (err) {
        this.report('channel_check_failed', errorCode(err)); return;
      }
      let answer = event.answer;
      if (event.state === 'queued') {
        this.store.generating(event.id);
        try {
          answer = await this.generate(event, this.store.history(event));
          replyPayload(event, answer); // Validate before persisting a sendable result.
          this.store.ready(event.id, answer);
        } catch (err) {
          const code = errorCode(err);
          const waiting = this.now() - event.created < CORE_WAIT_LIMIT_MS;
          if (code === 'slack_core_unavailable' && waiting) {
            // Transient: give the attempt back and retry on the next drain.
            this.store.requeue(event.id, code); this.report('core_unavailable'); return;
          }
          const terminal = event.attempts >= 2 || code === 'slack_core_unavailable';
          this.store.setState(event.id, terminal ? 'failed' : 'queued', code);
          this.report('generation_failed', code);
          if (terminal) await this.notify(event, waiting ? 'no valid reply after three attempts' : 'the local model stayed unavailable');
          return;
        }
      }
      // Recheck sharing immediately before outbound delivery, after potentially slow generation.
      try {
        if (!await authorizeChannel(this.web, this.config)) {
          this.store.setState(event.id, 'blocked', 'channel_changed_before_send'); continue;
        }
      } catch (err) { this.report('channel_check_failed', errorCode(err)); return; }
      this.store.setState(event.id, 'sending');
      try {
        const result = await this.web.chat.postMessage(replyPayload(event, answer));
        if (!result.ok || result.channel !== event.channel || !/^\d{10}\.\d{6}$/.test(result.ts || '')) {
          throw new Error('slack_send_unconfirmed');
        }
        this.store.sent(event.id, result.ts);
        this.report('reply_sent');
      } catch (err) {
        const outcome = classifySendFailure(err);
        if (outcome === 'rate_limited') {
          // Slack refused before processing: the reply is intact, resend on a later drain.
          this.store.setState(event.id, 'ready', 'rate_limited'); this.report('delivery_rate_limited'); return;
        }
        if (outcome === 'rejected') {
          const known = new Set(['invalid_blocks', 'msg_too_long', 'not_in_channel',
            'channel_not_found', 'is_archived', 'restricted_action', 'missing_scope', 'invalid_auth']);
          const reason = `slack_rejected:${known.has(err.data.error) ? err.data.error : 'platform_error'}`;
          this.store.setState(event.id, 'failed', reason); this.report('delivery_rejected', reason);
          await this.notify(event, 'Slack refused the reply'); continue;
        }
        // SDK retries disabled: a lost response is not proof that Slack did not post.
        this.store.setState(event.id, 'uncertain', 'delivery_requires_reconciliation');
        this.report('delivery_uncertain', errorCode(err));
      }
    }
  }
  async stop() { this.stopped = true; await this.running; }
}
