// src/moorstead/ingest.js — orchestrate one incoming event:
// validate -> store -> (maybe) notify. `send` and `store` are injected
// so this is testable without HTTP or config.
import defaultStore from './store.js';
import { isNotable, formatNotable, composeSessionDigest } from './curate.js';

const VALID_TYPES = new Set(['join', 'leave', 'edit', 'error', 'milestone']);

export function validateEvent(evt) {
  if (!evt || typeof evt !== 'object') return 'event must be an object';
  if (!VALID_TYPES.has(evt.type)) return `invalid type: ${evt.type}`;
  if (!evt.room || typeof evt.room !== 'string') return 'room required';
  return null;
}

export async function ingestMoorsteadEvent(evt, { send, store = defaultStore } = {}) {
  const err = validateEvent(evt);
  if (err) return { ok: false, error: err };

  const wasOccupied = store.roomCount(evt.room) > 0;
  const stored = store.recordEvent(evt);
  let notified = false;

  if (isNotable(stored) && typeof send === 'function') {
    await send(formatNotable(stored));
    notified = true;
  }

  // Session-end: a leave that drops the room to empty.
  if (stored.type === 'leave' && wasOccupied && store.roomCount(evt.room) === 0 && typeof send === 'function') {
    await send(composeSessionDigest(evt.room, store.recentEvents({ room: evt.room })));
    notified = true;
  }

  return { ok: true, stored, notified };
}
