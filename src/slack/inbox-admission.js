import { acceptMention } from './policy.js';
import { authorizeActor } from './workspace-channels.js';
import { authorizeChannel } from './channel-access.js';
import { admitLane, LANE_LIMITS } from './peer-lane.js';

/**
 * The socket handler's whole decision, separate from the socket so it can be tested.
 * Durable persistence precedes the caller's ACK. Refused events are discarded without storing text.
 * The private and public path is the v36 sequence unchanged; only a configured lane channel reaches admitLane.
 */
async function decide({ body, channel, botUserId, web, store, now, report, onPublicDenied }) {
  if (channel?.peerLane === true) {
    const lane = await admitLane({ body, channel, botUserId, web, store, now });
    if (!lane.event) return { outcome: 'lane_rejected', detail: lane.reason, queued: false };
    const stored = store.enqueueLane(lane.event, now, LANE_LIMITS);
    return stored === 'queued' || stored === 'duplicate'
      ? { outcome: `lane_${stored}`, detail: undefined, queued: stored === 'queued' }
      : { outcome: 'lane_rejected', detail: stored, queued: false };
  }
  let event = channel ? acceptMention(body, channel, botUserId) : null;
  if (event && !await authorizeActor(web, channel, event)) {
    report(channel.workspaceShared ? 'public_actor_denied' : 'private_actor_denied'); event = null;
  }
  if (event && channel.workspaceShared && !await authorizeChannel(web, channel)) {
    report('public_channel_denied'); event = null; onPublicDenied();
  }
  const outcome = event ? store.enqueue(event, now) : 'rejected';
  return { outcome, detail: undefined, queued: outcome === 'queued' };
}

/** The decision, then a record of a refusal. The record is made after the decision and cannot change it. */
export async function admitEvent({ body, channels, botUserId, web, store, now, report, onPublicDenied = () => {}, log = null }) {
  const channel = channels.find(candidate => candidate.channelId === body?.event?.channel);
  const denials = [];
  const result = await decide({ body, channel, botUserId, web, store, now, onPublicDenied,
    report: (...args) => { denials.push(args[0]); report(...args); } });
  if (!result.queued && log) {
    // The log catches its own failures. This is for a log that does not: the decision stands whatever it does.
    try { log.refused({ body, channel, botUserId, outcome: result.outcome, denials, now }); }
    catch { try { report('admission_log_failed'); } catch { /* The journal itself failed; there is nowhere left to say so. */ } }
  }
  return result;
}
