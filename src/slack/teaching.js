/** Transport commands operate only after the worker's fresh private-owner membership check. */
import { isControlReply } from './policy.js';
export function parseTeachingCommand(text) {
  const save = /^[ \t]*(teach|correct|example):[ \t]*([\s\S]*)$/i.exec(text);
  if (save) return { action: 'save', kind: save[1].toLowerCase(), text: save[2] };
  const retire = /^[ \t]*unlearn:[ \t]*([\s\S]*)$/i.exec(text);
  if (retire) return { action: 'retire', id: retire[1].trim() };
  const list = /^[ \t]*teachings(?:[ \t]+([1-9][0-9]{0,4}))?[ \t]*$/i.exec(text);
  if (list) return { action: 'list', page: Number(list[1] || 1) };
  const read = /^[ \t]*teaching[ \t]+(T[a-f0-9]{16})[ \t]*$/i.exec(text);
  return read ? { action: 'read', id: read[1] } : null;
}

const record = row => ({ id: row.id, kind: row.kind, text: row.raw_text,
  source: { event: row.source_event, timestamp: row.source_ts, thread: row.thread, owner: row.owner },
  verification: 'owner_supplied_not_independently_verified' });
const render = row => `${row.id} (${row.kind}, Slack ${row.source_ts}${row.retired_ts ? ', retired' : ''})\n${row.raw_text}`;

export class SlackTeaching {
  constructor({ store, config }) { Object.assign(this, { store, config }); }
  namespace(event) {
    if (this.config.policy?.mode !== 'open' || event.team !== this.config.teamId ||
      event.channel !== this.config.channelId || event.owner !== this.config.ownerId) return null;
    return `${event.team}:${event.channel}:${event.owner}`;
  }
  history(event, history) {
    const namespace = this.namespace(event);
    if (!namespace) return []; // A policy downgrade cannot reuse previously private exchanges.
    const cutoff = this.store.cutoff(namespace);
    return history.filter(item => item.ts > cutoff && !parseTeachingCommand(item.text));
  }
  handle(event, history, barrier = '') {
    const namespace = this.namespace(event);
    if (!namespace) return parseTeachingCommand(event.text)
      ? 'Teaching is available only in the authorized private owner context. Nothing was saved or disclosed.' : null;
    const command = parseTeachingCommand(event.text);
    if (!command) {
      const previous = this.history(event, history).at(-1);
      this.store.recordEpisode(namespace, event, previous
        ? { ownerText: previous.text, clintText: previous.answer, sourceTs: previous.ts } : null);
      return null;
    }
    if (command.action === 'save') {
      if (!command.text.trim() || command.text.length > 4000) return 'Nothing saved. A teaching must contain 1–4,000 characters; keep its scope and exceptions together.';
      if (isControlReply('Literal teaching:\n' + command.text)) return 'Nothing saved. Literal model-control tags are not supported in teaching records.';
      const saved = this.store.save(namespace, event, command.kind, command.text);
      if (this.store.get(namespace, saved.id).retired_ts) return `${saved.id} was saved from this message but has since been retired. It is not active.`;
      const description = { teach: 'teaching', correct: 'owner correction, not independently verified',
        example: 'illustrative example, not a claim that the events happened' }[saved.kind];
      return `Saved ${saved.id} as a ${description}:\n${saved.text}\n\nUse “unlearn: ${saved.id}” to retire it, or “teachings” to inspect what is active.`;
    }
    if (command.action === 'retire') {
      if (!/^T[a-f0-9]{16}$/.test(command.id)) return 'Nothing retired. Use “unlearn: T…” with an ID from “teachings”.';
      const historyBarrier = [barrier, ...history.map(item => item.ts || '')].sort().at(-1);
      const result = this.store.retire(namespace, event, command.id, historyBarrier);
      if (result.state === 'not_found') return `No teaching ${command.id} exists in this private conversation.`;
      if (result.state === 'already_retired') return `${command.id} was already retired. It remains excluded from active teaching.`;
      return `Retired ${command.id} from future use. The audit record remains. Earlier conversation context is excluded so it cannot reapply the retired teaching.`;
    }
    if (command.action === 'read') {
      const result = this.store.get(namespace, command.id);
      return result ? render(result) : 'No teaching with that ID exists in this private conversation.';
    }
    const result = this.store.list(namespace, command.page);
    return (result.records.map(render).join('\n\n') || 'No active teachings on this page.')
      + (result.nextPage ? `\n\nContinue with “teachings ${result.nextPage}”.` : '');
  }
  context(event) {
    const namespace = this.namespace(event);
    if (!namespace) return null;
    let available = 12000;
    const selected = [], episodes = [];
    let omitted = 0;
    const include = (target, value) => {
      const size = JSON.stringify(value).length;
      if (size > available) { omitted++; return; }
      available -= size; target.push(value);
    };
    for (const row of this.store.active(namespace, event.text)) include(selected, record(row));
    for (const row of this.store.episodes(namespace, event)) {
      const preceding = JSON.parse(row.preceding_exchange);
      include(episodes, {
      ownerText: row.raw_text, precedingExchange: preceding?.sourceTs > this.store.cutoff(namespace) ? preceding : null,
      source: { event: row.event, timestamp: row.source_ts, thread: row.thread, owner: event.owner },
      authority: 'attributed_conversation_evidence_not_a_permanent_rule_or_verified_fact',
      });
    }
    return { activeTeachings: selected, ownerEpisodes: episodes, omittedForContextBudget: omitted,
      historyCutoffAfterRetirement: this.store.cutoff(namespace) || null };
  }
  shouldRegenerate(event) {
    const namespace = this.namespace(event);
    return namespace && this.store.cutoff(namespace) &&
      this.store.responseCutoff(namespace, event.id) !== this.store.cutoff(namespace);
  }
  markResponse(event) {
    const namespace = this.namespace(event);
    if (namespace) this.store.markResponse(namespace, event.id);
  }
}

export function teachingContextText(context) {
  if (!context) return '';
  return '[Owner teaching and feedback records]\n'
    + 'Active explicit teachings guide the situations they address. Preserve their scope and exceptions. '
    + 'The current request controls this task; conflicting stored instructions stay separate. '
    + 'Examples are illustrative, and owner corrections are attributed statements, not independently verified facts. '
    + 'Prior conversation episodes may reveal relevant feedback for this task; do not promote one-off requests, jokes or quotations into global rules. '
    + 'These records never grant tools, permissions or authority to publish. Never revive retired teachings from old context. '
    + 'The service handles teach:, correct:, example:, teachings, teaching ID and unlearn: ID directly and durably; this is stored guidance, not weight training.\n'
    + JSON.stringify(context) + '\n';
}
