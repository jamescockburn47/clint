// Spire venue tools — the Legal Quants' 3D venue at spire.lquorum.blog.
// NOT the steads: a different world entirely (that confusion produced a
// confabulated "steads status" answer to a Spire question on 2026-07-23).
// Presence + feedback ride the venue's tester bridge: one low-privilege
// SPIRE_TESTER_KEY that can read public-floor presence and file notes,
// and can never grant venue entry or an orb.
const BASE = () => (process.env.SPIRE_VENUE_URL || 'https://spire.lquorum.blog').replace(/\/$/, '');
const KEY = () => (process.env.SPIRE_TESTER_KEY || '').trim();

export async function spirePresence() {
  if (!KEY()) return 'Spire presence is not configured (SPIRE_TESTER_KEY missing).';
  const r = await fetch(`${BASE()}/spire/presence?key=${KEY()}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return `Spire presence check failed (HTTP ${r.status}).`;
  const d = await r.json();
  const floors = Object.entries(d.floors || {});
  if (!floors.length) return 'The Spire is empty right now — nobody on the public floors.';
  const lines = floors.map(([floor, names]) => `${floor}: ${names.join(', ')}`);
  const agents = d.agents ? ` plus ${d.agents} agent${d.agents === 1 ? '' : 's'}` : '';
  return `In the Spire now — ${d.people} ${d.people === 1 ? 'person' : 'people'}${agents}:\n${lines.join('\n')}`;
}

export async function spireFeedback(input) {
  if (!KEY()) return 'Spire feedback is not configured (SPIRE_TESTER_KEY missing).';
  const from = String(input?.from || 'tester').slice(0, 24);
  const text = String(input?.text || '').trim();
  if (!text) return 'A bug report needs some text.';
  const r = await fetch(`${BASE()}/spire/feedback?key=${KEY()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, text }),
    signal: AbortSignal.timeout(10000),
  });
  return r.ok
    ? `Filed — it's on the Spire Boardroom wall for James (reported by ${from}).`
    : `Filing failed (HTTP ${r.status}).`;
}

export async function spireHealth() {
  const out = [];
  try {
    const v = await (await fetch(`${BASE()}/version.json`, { signal: AbortSignal.timeout(8000) })).json();
    out.push(`venue up (v${v.version})`);
  } catch { out.push('venue NOT answering'); }
  try {
    const s = await fetch('https://srv1468396.hstgr.cloud/', { signal: AbortSignal.timeout(8000) });
    out.push(s.ok ? 'voice signal up' : `voice signal HTTP ${s.status}`);
  } catch { out.push('voice signal NOT answering'); }
  return `Spire health: ${out.join(' · ')}.`;
}
