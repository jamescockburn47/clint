import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { currentConversation } from '../conversation-context.js';
import { REASONS, PLACES, SENDERS, PER_HOUR, isRecording } from './admission-log.js';

export const ADMISSION_NAMES = ['admission_log'];
export const ADMISSION_DEFINITIONS = [{ name: 'admission_log',
  description: 'Why a Slack message to you got no answer. Lists the messages the gate refused in the last hours, each with its '
    + 'time, channel, kind of sender and fixed reasons, and the accepted messages that failed or are still waiting. It holds no '
    + 'message text. Use whenever the owner asks why you did not respond to, ignored or missed a message. Match the message by '
    + 'its time. If no row matches, say the log has no record of that message; never guess a cause.',
  input_schema: { type: 'object', properties: { hours: { type: 'integer', minimum: 1, maximum: 336,
    description: 'How far back to look. Default 48. The log keeps 14 days.' } }, required: [], additionalProperties: false } }];

const ROWS = 30, WAITING = 15, ANSWERED = 10, REASONS_A_ROW = 8;
const STATES = new Set(['queued', 'generating', 'ready', 'sending', 'sent', 'failed', 'uncertain', 'blocked']);
// What is printed is a word from a fixed list or has the form of one. Anything else in the database is "unlisted".
const listed = (value, list) => typeof value === 'string' && list.includes(value) ? value : 'unlisted';
const channelId = value => typeof value === 'string' && /^[CG][A-Z0-9]{8,20}$/.test(value) ? value : value ? 'unlisted' : null;
const errorCode = value => typeof value === 'string' && /^(?:[a-z][a-z0-9_:]{1,79}|E[A-Z]{2,20}|[A-Z][A-Za-z]{0,30}Error)$/.test(value)
  ? value : value ? 'unlisted' : null;
const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const stamp = /^\d{10}\.\d{6}$/;
/** London date and time of a message, with GMT or BST, from its Slack timestamp where there is one. */
function when(ts, created) {
  const instant = typeof ts === 'string' && stamp.test(ts) ? Number(ts.slice(0, 10)) * 1000 : created;
  if (!Number.isSafeInteger(instant) || instant <= 0) return null;
  const at = Object.fromEntries(london.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${at.year}-${at.month}-${at.day} ${at.hour}:${at.minute}:${at.second} ${at.timeZoneName}`;
}

/** The owner, in the private channel, under the scope Slack issues for it. Anything missing is refused. */
const allowed = scope => scope?.transport === 'slack' && scope.audience === 'group' && scope.isOwner === true && scope.privateContext === true &&
  scope.localOnly === true && scope.webOnly === false && scope.readOnly === false && scope.policy?.mode === 'open' &&
  !scope.policy.workspaceShared && !scope.policy.peerLane && typeof scope.taskStorePath === 'string' && !!scope.taskStorePath &&
  typeof scope.conversationId === 'string' && /^slack:T[A-Z0-9]+:[CG][A-Z0-9]+$/.test(scope.conversationId);

export function admissionRead(input, { scope = currentConversation(), now = Date.now, path = null, recordingNow = isRecording } = {}) {
  if (!allowed(scope)) return JSON.stringify({ state: 'not_authorized' });
  const args = z.object({ hours: z.number().int().min(1).max(336).default(48) }).strict().safeParse(input ?? {});
  if (!args.success) return JSON.stringify({ state: 'invalid_input' });
  // The inbox sits beside the owner's task store, in the directory the Slack adapter was given.
  const file = path ?? join(dirname(scope.taskStorePath), 'slack.sqlite');
  if (!existsSync(file)) return JSON.stringify({ state: 'unavailable', error: 'no_inbox' });
  const observed = now(), since = observed - args.data.hours * 3600000;
  const [, team, here] = scope.conversationId.split(':');
  const place = channel => channel === here ? 'private' : 'elsewhere';
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refusals'").get()) {
      return JSON.stringify({ state: 'unavailable', error: 'log_not_started' });
    }
    // A message that was accepted through another event is not a refusal. The team is named so that the inbox's index is used.
    const unanswered = `FROM refusals r WHERE r.created>=? AND NOT EXISTS
      (SELECT 1 FROM events e WHERE e.team=? AND e.channel=r.channel AND e.ts=r.ts)`;
    const total = db.prepare(`SELECT count(*) AS n ${unanswered}`).get(since, team).n;
    const rows = db.prepare(`SELECT r.created,r.place,r.channel,r.ts,r.thread,r.sender,r.reasons ${unanswered}
      ORDER BY r.created DESC LIMIT ?`).all(since, team, ROWS);
    const oldest = db.prepare('SELECT min(created) AS at FROM refusals').get().at;
    const accepted = db.prepare(`SELECT channel,ts,thread,state,error,attempts,created FROM events
      WHERE created>=? AND state!='sent' ORDER BY created DESC LIMIT ?`).all(since, WAITING);
    const answered = db.prepare("SELECT count(*) AS n FROM events WHERE created>=? AND state='sent'").get(since).n;
    const latest = db.prepare(`SELECT channel,ts,reply_ts FROM events WHERE created>=? AND state='sent'
      ORDER BY created DESC LIMIT ?`).all(since, ANSWERED);
    const refused = rows.map(row => ({ at: when(row.ts, row.created), place: listed(row.place, PLACES), channel: channelId(row.channel),
      inThread: typeof row.thread === 'string' && !!row.thread && row.thread !== row.ts, sender: listed(row.sender, SENDERS),
      reasons: String(row.reasons).split(',', REASONS_A_ROW).map(reason => Object.hasOwn(REASONS, reason) ? reason : 'unclear') }));
    const used = [...new Set(refused.flatMap(row => row.reasons))];
    const recording = recordingNow() === true;
    return JSON.stringify({ state: 'recorded', observedAt: new Date(observed).toISOString(), timeZone: 'Europe/London',
      hours: args.data.hours, recording, oldestRecordKept: Number.isSafeInteger(oldest) ? when(null, oldest) : null,
      refused, refusedTotal: total, refusedNotShown: total - refused.length,
      legend: Object.fromEntries(used.map(reason => [reason, REASONS[reason]])),
      senders: { owner: 'typed by the owner', app_as_owner: 'posted by an app under the owner\'s name', app: 'posted by an app',
        person: 'typed by someone else', unknown: 'Slack named no sender' },
      acceptedNotAnswered: accepted.map(row => ({ at: when(row.ts, row.created), place: place(row.channel), channel: channelId(row.channel),
        state: typeof row.state === 'string' && STATES.has(row.state) ? row.state : 'unlisted', error: errorCode(row.error),
        attempts: Number.isSafeInteger(row.attempts) ? row.attempts : null })),
      answered: { count: answered, latest: latest.map(row => ({ at: when(row.ts, null), place: place(row.channel),
        repliedAt: when(row.reply_ts, null) })) },
      limits: (recording ? '' : 'THE LOG IS NOT RECORDING in this run of Clint: it could not be opened at startup. The rows here are from earlier runs. ')
        + 'A message sent more than 14 days ago, or before the oldest record kept, is not here. Absence from this log is not a reason. '
        + 'Messages that arrived while Clint was not running were never delivered to it and are not here. '
        + `At most ${PER_HOUR} refusals an hour are recorded for each of the private channel, the public channel and other channels; `
        + 'beyond that a refusal is not recorded. A refusal is also not recorded if Slack could not be asked about the sender.' });
  } catch { return JSON.stringify({ state: 'unavailable', error: 'log_read_failed' }); }
  finally { db?.close(); }
}

export const ADMISSION_HANDLERS = [['admission_log', input => admissionRead(input)]];
