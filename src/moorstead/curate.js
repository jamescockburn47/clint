// src/moorstead/curate.js — pure classification + WhatsApp formatting.
// No I/O, no config: fully unit-testable.

const NOTABLE_TYPES = new Set(['join', 'leave', 'error', 'milestone']);

export function isNotable(evt) {
  if (NOTABLE_TYPES.has(evt.type)) return true;
  if (evt.type === 'edit' && evt.detail?.protected) return true; // repeated hits on protected fabric
  return false;
}

export function formatNotable(evt) {
  const who = evt.name || evt.pid || 'someone';
  const room = evt.room || 'the moor';
  switch (evt.type) {
    case 'join': return `*Moorstead:* ${who} joined ${room}.`;
    case 'leave': return `*Moorstead:* ${who} left ${room}.`;
    case 'milestone': return `*Moorstead:* ${who} reached "${evt.detail?.milestone || 'a milestone'}" in ${room}.`;
    case 'error': {
      const msg = evt.detail?.message || 'unknown error';
      const at = evt.detail?.lookingAt ? ` (looking at ${evt.detail.lookingAt})` : '';
      return `*Moorstead error* — ${who} in ${room}${at}\n${msg}`;
    }
    case 'edit': return `*Moorstead:* ${who} kept hitting protected ${evt.detail?.target || 'fabric'} in ${room}.`;
    default: return `*Moorstead:* ${evt.type} in ${room}.`;
  }
}

export function composeDigest(events) {
  if (!events.length) return null;
  const players = [...new Set(events.map((e) => e.name || e.pid).filter(Boolean))];
  const editsByRoom = {};
  for (const e of events) if (e.type === 'edit') editsByRoom[e.room] = (editsByRoom[e.room] || 0) + 1;
  const lines = ['*Moorstead — digest*'];
  lines.push(players.length ? `${players.length} active: ${players.join(', ')}` : 'No players today.');
  for (const [room, n] of Object.entries(editsByRoom)) lines.push(`${room}: ${n} blocks changed`);
  return lines.join('\n');
}

export function composeSessionDigest(room, events) {
  const roomEvents = events.filter((e) => e.room === room);
  const players = [...new Set(roomEvents.map((e) => e.name || e.pid).filter(Boolean))];
  const edits = roomEvents.filter((e) => e.type === 'edit').length;
  return `*Moorstead:* ${room} is now empty. ${players.length} played, ${edits} blocks changed.`;
}
