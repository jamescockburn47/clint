import { currentConversation } from '../conversation-context.js';
import { moorsteadStatus as statusWithNames } from './moorstead.js';

export { moorsteadBroadcast, moorsteadKick, moorsteadBairnsStatus, moorsteadBairnsSet,
  moorsteadOps, moorsteadOpsConfirm } from './moorstead.js';

/** The game's fixed rooms. A session with no room is playing alone. Anything else is counted as "other". */
const ROOMS = ['moor', 'dale', 'crag', 'tarn', 'bairns', 'solo'];
const OVERVIEW = 'http://127.0.0.1:8095/api/overview';

/**
 * moorstead_status. In Slack it returns how many sessions are live in each room and nothing else.
 * Names and places are chosen by players, and the model that reads this holds the owner's tools,
 * so no text a player chose is returned: not shortened, not filtered, not at all.
 * A scope that is positively some other transport keeps the original reply. No scope at all gets counts only.
 */
export async function moorsteadStatus(input) {
  const scope = currentConversation();
  if (scope && scope.transport !== 'slack') return statusWithNames(input);
  let data;
  try {
    const response = await fetch(OVERVIEW, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return 'Moorstead: the ledger answered with an error; presence unavailable.';
    data = await response.json();
  } catch { return 'Moorstead: the ledger could not be read; presence unavailable.'; }
  if (!Array.isArray(data?.live)) return 'Moorstead: the ledger gave no list of live sessions; presence unavailable.';
  const counts = new Map();
  for (const session of data.live) {
    const room = session?.room === undefined || session?.room === null || session?.room === '' ? 'solo'
      : ROOMS.includes(session.room) ? session.room : 'other';
    counts.set(room, (counts.get(room) || 0) + 1);
  }
  const total = data.live.length;
  if (!total) return '*Moorstead* — no live sessions now.';
  const rooms = [...ROOMS, 'other'].filter(room => counts.has(room)).map(room => `${room}: ${counts.get(room)}`);
  return `*Moorstead* — ${total} live session${total === 1 ? '' : 's'} now, counting every device including the owner's. `
    + `${rooms.join(', ')}. Players' names are not shown here; the Moorstead dashboard has them.`;
}
