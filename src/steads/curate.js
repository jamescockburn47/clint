// src/steads/curate.js — pure classification + WhatsApp formatting for the
// Steads family notifications (Moorstead / Saltstead / Marsstead). No I/O, no
// config: fully unit-testable. Mirrors the moorstead/curate.js house style
// (WhatsApp *bold*, no emoji). Deployed to clawd-admin: src/steads/curate.js.
const GAME = { moorstead: 'Moorstead', saltstead: 'Saltstead', marsstead: 'Marsstead' };
const NOTABLE = new Set(['visit', 'play', 'bug', 'feedback', 'service', 'vesper-cap']);

export function isNotable(evt) {
  return !!evt && NOTABLE.has(evt.type);
}

function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

export function formatEvent(evt) {
  const game = GAME[evt.game] || evt.game || 'a stead';
  const who = evt.name ? evt.name : 'someone';
  const where = evt.loc ? ` (${evt.loc})` : '';
  switch (evt.type) {
    case 'visit': return `*${game}:* ${who} just visited${where}.`;
    case 'play': return `*${game}:* ${who} started playing${where}.`;
    case 'bug': return `*${game} — bug* from ${who}:\n${trunc(evt.message, 300)}`;
    case 'feedback': return `*${game} — feedback* from ${who}:\n${trunc(evt.message, 300)}`;
    case 'service': return `*${game} — down:* ${trunc(evt.message, 200)}`;
    case 'vesper-cap': return `*Marsstead / VESPER capped:* ${trunc(evt.message || 'MiniMax quota hit', 160)}`;
    default: return `*${game}:* ${evt.type}`;
  }
}

export function composeDigest(events) {
  if (!events.length) return null;
  const byGame = {};
  for (const e of events) {
    const g = GAME[e.game] || e.game || 'other';
    (byGame[g] || (byGame[g] = { visitors: new Set(), players: new Set(), bugs: 0 }));
    const id = e.name || e.uid || e.pid;
    if (e.type === 'visit' && id) byGame[g].visitors.add(id);
    if (e.type === 'play' && id) byGame[g].players.add(id);
    if (e.type === 'bug') byGame[g].bugs += 1;
  }
  const lines = ['*The Steads — today*'];
  for (const [g, s] of Object.entries(byGame)) {
    const bits = [];
    if (s.visitors.size) bits.push(`${s.visitors.size} visited`);
    if (s.players.size) bits.push(`${s.players.size} played`);
    if (s.bugs) bits.push(`${s.bugs} bug${s.bugs > 1 ? 's' : ''}`);
    lines.push(`${g}: ${bits.join(', ') || 'quiet'}`);
  }
  return lines.join('\n');
}
