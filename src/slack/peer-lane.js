import { acceptMention } from './policy.js';
import { authorizeActor } from './workspace-channels.js';
import { authorizeChannel } from './channel-access.js';

/** Accepted lane messages, all authors. One model request each, so the day limit is also the lane's call ceiling. */
export const LANE_LIMITS = Object.freeze({ thread: 6, hour: 8, day: 20 });
/** Admission attempts that may reach Slack's API per hour, accepted or not. Protects the bot token's rate limit. */
export const LANE_CHECKS_PER_HOUR = 24;
/** Europe/London minutes of day during which the lane is closed, leaving the overnight programme undisturbed. */
export const LANE_QUIET = Object.freeze({ from: 0, until: 7 * 60 + 30 });
export const LANE_ID_PREFIX = 'lane:';
const APP = /^A[A-Z0-9]{8,}$/;
const BOT = /^B[A-Z0-9]{8,}$/;
const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const refused = reason => ({ event: null, reason });
const checks = new Map();

export function laneQuiet(now) {
  const parts = Object.fromEntries(london.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= LANE_QUIET.from && minute < LANE_QUIET.until;
}

/**
 * Admission for the operator-configured peer lane only. An app-authored message is admitted when Slack's own
 * envelope names the configured peer app; the ordinary gate then applies to the remaining fields. The stored
 * id carries a durable lane marker, so a lane row can never be processed under another channel's definition.
 */
export function acceptLane(body, cfg, botUserId) {
  if (cfg?.peerLane !== true || !APP.test(cfg.peerAppId || '') || cfg.peerAppId === cfg.appId) {
    return refused('lane_not_configured');
  }
  const event = body?.event;
  if (!event || typeof event !== 'object' || body.is_ext_shared_channel === true ||
      (event.team != null && event.team !== cfg.teamId)) return refused('lane_admission_rejected');
  let candidate = body;
  if ('bot_id' in event || 'bot_profile' in event || 'app_id' in event) {
    const profile = event.bot_profile;
    if (event.app_id !== cfg.peerAppId || !BOT.test(event.bot_id || '') || (profile !== undefined &&
        (profile?.app_id !== cfg.peerAppId || profile.id !== event.bot_id))) return refused('peer_app_mismatch');
    const { bot_id: _bot, bot_profile: _profile, app_id: _app, ...plain } = event;
    candidate = { ...body, event: plain };
  }
  const accepted = acceptMention(candidate, cfg, botUserId);
  return accepted ? { event: { ...accepted, id: LANE_ID_PREFIX + accepted.id }, reason: null }
    : refused('lane_admission_rejected');
}

export function laneLimit(used, limits = LANE_LIMITS) {
  if (used.thread >= limits.thread) return 'lane_thread_limit';
  if (used.hour >= limits.hour) return 'lane_hour_limit';
  if (used.day >= limits.day) return 'lane_day_limit';
  return null;
}

/**
 * Pre-persistence lane decision. Local refusals come first and cost no Slack call; the binding quota decision is
 * repeated atomically with the insert by SlackStore.enqueueLane. Slack failures propagate: an unverified check never admits.
 */
export async function admitLane({ body, channel, botUserId, web, store, now }) {
  if (channel?.peerLane !== true) throw new Error('lane_pipeline_misuse');
  const admission = acceptLane(body, channel, botUserId);
  if (!admission.event) return admission;
  if (laneQuiet(now)) return refused('lane_quiet_hours');
  const limit = laneLimit(store.laneUsage(admission.event, now));
  if (limit) return refused(limit);
  const recent = (checks.get(channel.channelId) || []).filter(at => at > now - 3600000);
  if (recent.length >= LANE_CHECKS_PER_HOUR) { checks.set(channel.channelId, recent); return refused('lane_check_limit'); }
  checks.set(channel.channelId, [...recent, now]);
  if (!await authorizeActor(web, channel, admission.event)) return refused('lane_actor_denied');
  if (!await authorizeChannel(web, channel)) return refused('lane_channel_denied');
  return admission;
}

/** Test seam: the attempt window is process state. */
export const resetLaneChecks = () => checks.clear();
