// src/moorstead/store.js — Moorstead event store: in-memory recent ring,
// room presence bookkeeping, and dated JSONL persistence. Factory so tests
// get isolated instances; a default singleton is shared by route + task.
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export function createStore({ dataDir = join('data', 'moorstead'), maxRecent = 500 } = {}) {
  const recent = [];
  const presence = new Map(); // room -> Set(pid)

  function dayFile(ts) {
    const day = new Date(ts).toISOString().slice(0, 10);
    return join(dataDir, `events-${day}.jsonl`);
  }

  function recordEvent(evt) {
    const e = { ...evt, ts: typeof evt.ts === 'number' ? evt.ts : Date.now() };
    recent.push(e);
    if (recent.length > maxRecent) recent.shift();

    if (e.type === 'join' && e.pid) {
      if (!presence.has(e.room)) presence.set(e.room, new Set());
      presence.get(e.room).add(e.pid);
    } else if (e.type === 'leave' && e.pid) {
      presence.get(e.room)?.delete(e.pid);
    }

    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(dayFile(e.ts), JSON.stringify(e) + '\n');
    } catch { /* persistence is best-effort; never block ingest */ }
    return e;
  }

  function recentEvents({ sinceTs = 0, room = null } = {}) {
    return recent.filter((e) => e.ts >= sinceTs && (!room || e.room === room));
  }

  function roomPresence(room) { return [...(presence.get(room) || [])]; }
  function roomCount(room) { return presence.get(room)?.size || 0; }

  return { recordEvent, recentEvents, roomPresence, roomCount };
}

const store = createStore();
export default store;
