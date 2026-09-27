import { acceptMention } from './policy.js';
import { authorizeActor } from './workspace-channels.js';
import { authorizeChannel } from './channel-access.js';
import { admitLane, LANE_LIMITS } from './peer-lane.js';

/**
 * The socket handler's whole decision, separate from the socket so it can be tested.
 * Durable persistence precedes the caller's ACK. Refused events are discarded without storing text.
 * The private and public path is the v36 sequence unchanged; only a configured lane channel reaches admitLane.
 */
export async function admitEvent({ body, channels, botUserId, web, store, now, report, onPublicDenied = () => {} }) {
  const channel = channels.find(candidate => candidate.channelId === body?.event?.channel);
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
