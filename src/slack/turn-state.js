// Per-turn guard state, keyed by the conversation scope object (one per Slack message). Shared by flow-guard.js and
// mcp-tools.js without an import cycle.
const turns = new WeakMap();

/** The mutable state of this turn. private: true from the start — Slack history and memory are private context in every turn.
 *  cleanListingHosts: servers whose listing this turn matched a report the owner saw at "mcp add" (not counted as untrusted,
 *  but an approved acting tool on any OTHER server is refused while such a listing is in context). */
export function turnState(scope) {
  if (!turns.has(scope)) {
    turns.set(scope, { tainted: null, untrusted: false, private: true, fetchedAfterPrivate: 0, outbound: [], cleanListingHosts: new Set() });
  }
  return turns.get(scope);
}
