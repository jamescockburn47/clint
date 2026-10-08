// src/steads/store.js — Steads notification event store: in-memory recent ring
// + dated JSONL persistence. Mirrors moorstead/store.js but game-tagged and
// shared by the /api/steads-event route and the daily digest task.
// Deployed to clawd-admin: src/steads/store.js.
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// The ledgers stamp ts in seconds; Clawd works in ms. Normalise on ingest.
const toMs = (ts) => (typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.now());

export function createStore({ dataDir = join('data', 'steads'), maxRecent = 800 } = {}) {
  const recent = [];
  const dayFile = (ms) => join(dataDir, `events-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
  function recordEvent(evt) {
    const e = { ...evt, ts: toMs(evt.ts) };
    recent.push(e);
    if (recent.length > maxRecent) recent.shift();
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(dayFile(e.ts), JSON.stringify(e) + '\n');
    } catch { /* persistence is best-effort; never block ingest */ }
    return e;
  }
  function recentEvents({ sinceTs = 0 } = {}) {
    return recent.filter((e) => e.ts >= sinceTs);
  }
  return { recordEvent, recentEvents };
}

const store = createStore();
export default store;
