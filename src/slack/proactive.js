import { join } from 'node:path';
import { authorizeChannel } from './channel-access.js';
import { replyPayload } from './policy.js';
import { classifySendFailure } from './worker.js';
import { ProactiveStore } from './proactive-store.js';
import { backgroundChat } from './background-model.js';
import { researchAndReflect, morningBrief } from './proactive-research.js';
import { createConversationContext, withConversationContext } from '../conversation-context.js';
import { filterResponse } from '../output-filter.js';
import { outboundQuerySafe } from '../outbound-query.js';
import core from '../config.js';
import { RESEARCH_TIMEOUT_MS } from '../inference-policy.js';

export const proactiveScope = config => JSON.stringify([config.teamId, config.channelId, config.ownerId]);
export function localSchedule(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: +parts.hour * 60 + +parts.minute };
}

/** Independent of WhatsApp. Durable daily jobs; foreground input cancels background inference. */
export class ProactiveWorker {
  constructor({ config, web, inbox, interactive, report = () => {}, now = Date.now,
    store = new ProactiveStore(join(config.dataDir, 'data', 'proactive')),
    authorize = authorizeChannel, chat = backgroundChat, research = researchAndReflect, briefing = morningBrief }) {
    Object.assign(this, { config, web, inbox, interactive, report, now, store, authorize, chat, research, briefing });
    this.scopeKey = proactiveScope(config);
    this.lastInput = now(); this.running = null; this.controller = null; this.stopped = false;
    store.recover(now());
  }
  interrupt() { this.lastInput = this.now(); this.controller?.abort(new Error('foreground_priority')); }
  tick() {
    if (this.running || this.stopped || !this.config.proactiveEnabled || this.config.policy.mode !== 'open' ||
        this.interactive.running || this.inbox.next() || this.now() - this.lastInput < 15 * 60000) return Promise.resolve();
    this.running = this.run().catch(() => this.report('proactive_failed')).finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    const { date, minute } = localSchedule(this.now());
    if (minute < 225 || minute >= 1200) return;
    if (!await this.authorize(this.web, this.config)) return;
    if (this.interactive.running || this.inbox.next() || this.now() - this.lastInput < 15 * 60000) return;
    const kind = minute < 420 ? 'research' : 'briefing';
    const job = this.store.ensure(date, kind, this.scopeKey, this.now());
    if (job.scope !== this.scopeKey || !['pending', 'ready'].includes(job.state) || job.state === 'pending' && job.attempts >= 3 ||
        job.attempts && this.now() - job.updated < 15 * 60000) return;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(RESEARCH_TIMEOUT_MS)]);
    const conversationId = `slack:${this.config.teamId}:${this.config.channelId}`;
    const scope = createConversationContext({ transport: 'slack', conversationId,
      actorId: this.config.ownerId, ownerId: this.config.ownerId, audience: 'group',
      policy: this.config.policy, localOnly: true, readOnly: true });
    try {
      let result = job.report ? JSON.parse(job.report) : null;
      if (job.state !== 'ready') {
        this.store.update(job.id, 'running', this.now());
        const chat = this.chat(this.config, signal);
        const args = { date, chat, signal, owner: this.config.ownerId, conversationId };
        result = await withConversationContext(scope, async () => {
          if (kind === 'research') return this.research({ ...args,
            statements: this.inbox.recentStatements(this.config, this.now()),
            directory: join(this.config.dataDir, 'data', 'proactive', 'research') });
          const research = this.store.get(`${date}:research`);
          return this.briefing({ ...args, now: this.now(), research:
            research?.scope === this.scopeKey && research.state === 'complete' ? JSON.parse(research.report) : null });
        });
        signal.throwIfAborted();
        if (kind === 'briefing') replyPayload({ channel: this.config.channelId }, result.text);
        this.store.update(job.id, kind === 'research' ? 'complete' : 'ready', this.now(), { report: result });
        if (kind === 'research') { this.report('proactive_research_complete'); return; }
      }
      signal.throwIfAborted();
      if (!await this.authorize(this.web, this.config)) {
        this.store.update(job.id, 'blocked', this.now(), { error: 'channel_changed_before_send' }); return;
      }
      signal.throwIfAborted();
      if (!outboundQuerySafe(result.text, { ...core, ...this.config }) ||
          !withConversationContext(scope, () => filterResponse(result.text, conversationId)).safe) {
        this.store.update(job.id, 'blocked', this.now(), { error: 'output_restriction' }); return;
      }
      let payload;
      try { payload = replyPayload({ channel: this.config.channelId }, result.text); }
      catch {
        this.store.update(job.id, 'failed', this.now(), { error: 'invalid_cached_report' }); return;
      }
      payload.text = 'Clint’s morning briefing.';
      this.store.update(job.id, 'sending', this.now());
      try {
        const sent = await this.web.chat.postMessage(payload);
        if (!sent.ok || sent.channel !== this.config.channelId || !/^\d{10}\.\d{6}$/.test(sent.ts || '')) {
          throw new Error('slack_send_unconfirmed');
        }
        this.store.update(job.id, 'sent', this.now(), { replyTs: sent.ts });
        this.report('proactive_briefing_sent');
      } catch (error) {
        const failure = classifySendFailure(error);
        this.store.update(job.id, failure === 'rate_limited' ? 'ready' : failure === 'rejected' ? 'failed' : 'uncertain',
          this.now(), { error: `delivery_${failure}` });
      }
    } catch {
      const fresh = this.store.get(job.id);
      if (fresh.state === 'running') this.store.update(job.id, 'pending', this.now(),
        { error: this.controller.signal.aborted ? 'foreground_priority' : 'generation_incomplete' });
      if (fresh.state === 'running' && this.controller.signal.aborted) this.store.giveBackAttempt(job.id);
      this.report(this.controller.signal.aborted ? 'proactive_yielded' : 'proactive_generation_failed');
    } finally { this.controller = null; }
  }
  async stop() { this.stopped = true; this.controller?.abort(); await this.running; this.store.close(); }
}
