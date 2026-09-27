import { namesClint } from './policy.js';
import { safeErrorCode } from '../error-code.js';

/**
 * A record of messages the gate refused, so that "why did you not answer" has a true answer.
 * It decides nothing: the gate has already refused before anything here runs.
 * It holds no message text and no person's ID: a time, a channel, a kind of sender and fixed reason words.
 */
const stamp = /^\d{10}\.\d{6}$/;
export const KEEP_MS = 14 * 24 * 3600000;
export const MAX_ROWS = 1000;
export const PER_HOUR = 120;
export const PLACES = Object.freeze(['private', 'public', 'lane', 'other']);
export const SENDERS = Object.freeze(['owner', 'app_as_owner', 'app', 'person', 'unknown']);
export const REASONS = Object.freeze({
  envelope: 'Slack delivered it in a form Clint does not accept, or for another workspace or app.',
  channel_not_served: 'It was in a channel Clint does not answer in.',
  external_shared_channel: 'The private channel was reported as shared outside the workspace.',
  event_type: 'It was not an ordinary message in that kind of channel.',
  edited: 'It was an edit to an earlier message. Clint reads a message as first posted, not as edited.',
  deleted: 'It was the deletion of a message.',
  file_attached: 'It had a file attached. Clint does not accept a message with a file.',
  thread_reply_broadcast: 'It was a thread reply also sent to the channel. Clint does not accept a message sent that way.',
  me_message: 'It was sent as a /me message, which Clint does not accept.',
  other_subtype: 'Slack marked it as a special kind of message, such as a notice that someone joined. Clint does not accept these.',
  sent_by_app: 'It was posted through an app or integration, not typed by a person. Clint does not act on these, '
    + 'including a message an app posts under the owner\'s name.',
  sender_not_identified: 'Slack named no person as the sender.',
  not_owner: 'In the private channel Clint answers the owner only.',
  own_message: 'It was a message Clint itself posted.',
  other_workspace: 'It came from another workspace.',
  malformed_timestamp: 'Its timestamp was not in Slack\'s form.',
  empty_or_too_long: 'It had no text, or more than 12,000 characters.',
  not_addressed: 'It did not contain the word Clint or a mention of Clint.',
  sender_not_authorised: 'Slack did not confirm the sender as a current member entitled to ask.',
  channel_not_authorised: 'Slack did not confirm the channel as the one Clint is configured for.',
  daily_limit: 'Clint had already accepted 100 messages in the preceding 24 hours.',
  lane_refused: 'The peer lane refused it.',
  unclear: 'The gate refused it and none of the listed reasons was identified.',
});
// What Slack calls the kind, and the reason recorded for it. Any other kind is "other_subtype".
const SUBTYPES = Object.freeze({ message_changed: 'edited', message_deleted: 'deleted', file_share: 'file_attached',
  thread_broadcast: 'thread_reply_broadcast', me_message: 'me_message', bot_message: 'sent_by_app' });
// An edit or a deletion is about another message: nothing else can be read from it. The rest are messages in their own right.
const ALONE = new Set(['edited', 'deleted', 'other_subtype']);

/**
 * Every condition of acceptMention that fails, as fixed words. Empty means the gate accepts.
 * "envelope" and "event_type" are reported alone: what follows them cannot be read from such an event.
 */
export function refusalReasons(body, cfg, botUserId) {
  const event = body?.event;
  if (body?.type !== 'event_callback' || body.team_id !== cfg.teamId || body.api_app_id !== cfg.appId ||
      !/^Ev[A-Z0-9]+$/.test(body.event_id || '') || !event) return ['envelope'];
  const addressed = event.type === 'app_mention' && typeof event.text === 'string' && event.text.includes(`<@${botUserId}>`);
  const privateMessage = event.type === 'message' && event.channel_type === 'group' && !cfg.workspaceShared;
  const publicMessage = event.type === 'message' && event.channel_type === 'channel' && cfg.workspaceShared === true;
  if (!addressed && !privateMessage && !publicMessage) return ['event_type'];
  const reasons = [];
  if (event.subtype) {
    const kind = typeof event.subtype === 'string' && Object.hasOwn(SUBTYPES, event.subtype) ? SUBTYPES[event.subtype] : 'other_subtype';
    if (ALONE.has(kind)) return [kind];
    reasons.push(kind);
  }
  if (!cfg.workspaceShared && body.is_ext_shared_channel === true) reasons.push('external_shared_channel');
  if (('bot_id' in event || 'bot_profile' in event || 'app_id' in event) && !reasons.includes('sent_by_app')) reasons.push('sent_by_app');
  if (typeof event.user !== 'string' || !/^[UW][A-Z0-9]+$/.test(event.user)) reasons.push('sender_not_identified');
  else if (event.user === botUserId) reasons.push('own_message');
  else if (!cfg.workspaceShared && event.user !== cfg.ownerId) reasons.push('not_owner');
  if (event.channel !== cfg.channelId) reasons.push('channel_not_served');
  if (!cfg.workspaceShared && event.team && event.team !== cfg.teamId) reasons.push('other_workspace');
  if (!stamp.test(event.ts || '') || (event.thread_ts && !stamp.test(event.thread_ts))) reasons.push('malformed_timestamp');
  if (typeof event.text !== 'string' || !event.text.trim() || event.text.length > 12000) reasons.push('empty_or_too_long');
  else if (!namesClint(event.text, botUserId)) reasons.push('not_addressed');
  return reasons;
}

const DENIALS = { private_actor_denied: 'sender_not_authorised', public_actor_denied: 'sender_not_authorised',
  public_channel_denied: 'channel_not_authorised' };
const id = value => typeof value === 'string' && /^[ABUW][A-Z0-9]{5,20}$/.test(value);
// Whether this process is recording, for the tool to say. A log that failed to open leaves old rows and records no new ones.
let recording = false;
export const isRecording = () => recording;

export class AdmissionLog {
  /** The log, or null if it cannot be opened. Clint runs without it rather than not at all. */
  static open(db, options = {}) {
    try { return new AdmissionLog(db, options); }
    catch (err) { recording = false; (options.report ?? (() => {}))('admission_log_unavailable', safeErrorCode(err)); return null; }
  }

  constructor(db, { report = () => {}, ownerId, appId } = {}) {
    // Without these the log cannot tell Clint's own posts from anyone's, and would record nothing or everything.
    if (!id(ownerId) || !id(appId)) throw new TypeError('admission_log_needs_owner_and_app');
    Object.assign(this, { db, report, ownerId, appId, fullSince: new Map() });
    db.exec(`CREATE TABLE IF NOT EXISTS refusals (
      n INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, place TEXT NOT NULL, channel TEXT,
      ts TEXT, thread TEXT, sender TEXT NOT NULL, reasons TEXT NOT NULL, event_id TEXT UNIQUE,
      UNIQUE(channel,ts));`);
    recording = true;
  }

  /** Called after the gate has refused. Never throws and never changes the outcome. */
  refused({ body, channel, botUserId, outcome, denials = [], now }) {
    try {
      const event = body?.event;
      if (!['message', 'app_mention'].includes(event?.type) || outcome === 'duplicate' || outcome === 'lane_duplicate') return 'not_recorded';
      if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('admission_log_needs_a_time');
      const part = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
      const inner = part(event.message) ?? part(event.previous_message);
      // Clint's own posts come back as events. They are not messages to Clint.
      if ((id(botUserId) && [event.user, inner?.user].includes(botUserId)) || [event.app_id, inner?.app_id].includes(this.appId)) return 'not_recorded';
      // Slack reports an edit when it adds a link's preview. The text has not changed and the message is the one already seen.
      if (event.subtype === 'message_changed' && typeof part(event.message)?.text === 'string' &&
          part(event.message).text === part(event.previous_message)?.text) return 'not_recorded';
      const reasons = !channel ? ['channel_not_served']
        : channel.peerLane === true ? ['lane_refused']
          : outcome === 'rate_limited' ? ['daily_limit']
            : refusalReasons(body, channel, botUserId);
      for (const status of denials) if (Object.hasOwn(DENIALS, status) && !reasons.includes(DENIALS[status])) reasons.push(DENIALS[status]);
      if (!reasons.length) reasons.push('unclear');
      const app = 'bot_id' in event || 'bot_profile' in event || 'app_id' in event || event.subtype === 'bot_message' ||
        (!!inner && ('bot_id' in inner || 'app_id' in inner));
      const user = typeof event.user === 'string' ? event.user : inner?.user;
      const sender = app ? (user === this.ownerId ? 'app_as_owner' : 'app')
        : user === this.ownerId ? 'owner' : typeof user === 'string' && /^[UW][A-Z0-9]+$/.test(user) ? 'person' : 'unknown';
      const place = !channel ? 'other' : channel.peerLane === true ? 'lane' : channel.workspaceShared === true ? 'public' : 'private';
      // Each place has its own allowance, so a busy public channel cannot keep a private refusal out.
      if (this.db.prepare('SELECT count(*) AS n FROM refusals WHERE place=? AND created>=?').get(place, now - 3600000).n >= PER_HOUR) {
        if (now - (this.fullSince.get(place) ?? 0) >= 3600000) { this.fullSince.set(place, now); this.report('admission_log_full', place); }
        return 'not_recorded';
      }
      const valid = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;
      const ts = valid(event.ts, stamp);
      // A channel's ID, never a direct conversation's: that would name a person.
      const added = this.db.prepare(`INSERT OR IGNORE INTO refusals(created,place,channel,ts,thread,sender,reasons,event_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(now, place, valid(event.channel, /^[CG][A-Z0-9]{8,20}$/), ts,
        valid(event.thread_ts, stamp) ?? ts, sender, reasons.join(','), valid(body.event_id, /^Ev[A-Z0-9]{1,40}$/));
      this.db.prepare(`DELETE FROM refusals WHERE created<? OR (place=? AND n NOT IN
        (SELECT n FROM refusals WHERE place=? ORDER BY n DESC LIMIT ?))`).run(now - KEEP_MS, place, place, MAX_ROWS);
      return added.changes === 1 ? 'recorded' : 'not_recorded';
    } catch (err) {
      this.report('admission_log_failed', safeErrorCode(err));
      return 'failed';
    }
  }
}
