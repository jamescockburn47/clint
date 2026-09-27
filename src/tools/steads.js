// src/tools/steads.js — Steads WhatsApp admin (owner-only, DM-only). Run all
// three of James's games from the phone: status, mint / revoke invite codes,
// mute Clint. Mirrors src/tools/moorstead.js. All errors return readable
// strings; nothing throws. Deployed to clawd-admin: src/tools/steads.js.
import { randomBytes } from 'crypto';
import { setMuted, isMuted } from '../steads/state.js';
import { count } from './figures.js';

const LEDGERS = {
  moorstead: 'http://127.0.0.1:8095',
  saltstead: 'http://127.0.0.1:8097',
  marsstead: 'http://127.0.0.1:8098',
};
// Havenstead's figures come from the Steads reporter's intake, not from a game ledger.
const HAVENSTEAD = 'http://127.0.0.1:8104';
const PENDING = new Map(); // confirm_id -> { game, code, expiresAt }
const EXPIRY_MS = 10 * 60 * 1000;

async function api(url, opts) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000), ...opts });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

export async function steadsStatus() {
  const [haven, moor, salt, mars] = await Promise.all([
    api(HAVENSTEAD + '/api/visits'),
    api(LEDGERS.moorstead + '/api/overview'),
    api(LEDGERS.saltstead + '/api/visits'),
    api(LEDGERS.marsstead + '/api/summary'),
  ]);
  const lines = ['*The Steads — status*',
    `As of ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Figures are external browsers, not people: `
      + 'owner devices and known bots are excluded unless a line says otherwise. "Today" is the UTC day.'];
  // A ledger that answers without a figure has not reported zero. Every figure is checked before it is printed.
  const line = (game, source, down, figures, text) => lines.push(!source ? `${game}: ${down}`
    : figures.some(value => value === null) ? `${game}: figures unavailable` : `${game}: ${text(...figures)}`);
  const havenToday = haven?.visits?.havenstead?.today?.real;
  line('Havenstead', haven, 'intake down', [count(havenToday?.uniques), count(havenToday?.playUniques)],
    (visited, played) => `${visited} visited today, ${played} started play`);
  const moorReal = moor?.stats?.real, sessions = Array.isArray(moor?.live) ? moor.live.length : null;
  line('Moorstead', moor, 'ledger down', [count(moorReal?.today), count(moorReal?.playedToday), count(moorReal?.total), sessions],
    (visited, played, ever, live) => `${visited} visited today, ${played} played, ${ever} external browsers ever; `
      + `${live} live sessions now, counting every device including the owner's`);
  const saltToday = salt?.visits?.saltstead?.today?.real, saltEver = salt?.visits?.saltstead?.ever?.real;
  line('Saltstead', salt, 'ledger down', [count(saltToday?.uniques), count(saltToday?.playUniques), count(saltEver?.players)],
    (visited, played, ever) => `${visited} visited today, ${played} started play, ${ever} external players ever`);
  const marsToday = mars?.muster?.today?.real, marsLive = Array.isArray(mars?.live?.real) ? mars.live.real.length : null;
  const vesper = typeof mars?.vesper?.up === 'boolean' ? (mars.vesper.up ? 'up' : 'DOWN') : 'state unknown';
  line('Marsstead', mars, 'ledger down', [count(marsToday?.uniques), marsLive],
    (visited, live) => `${live} on now, ${visited} visited today; VESPER ${vesper}`);
  if (isMuted()) lines.push('(Clint notifications are muted)');
  return lines.join('\n');
}

export async function steadsMint(input = {}) {
  const game = String(input.game || '').toLowerCase();
  if (!LEDGERS[game]) return `Unknown game "${input.game}". Use moorstead, saltstead, or marsstead.`;
  const body = game === 'moorstead' ? { room: input.room || 'moor' } : { warden: !!input.warden };
  const d = await post(LEDGERS[game] + '/api/mint', body);
  if (!d || !d.ok) return `Mint failed for ${game}${d && d.err ? ': ' + d.err : ''}.`;
  const extra = game === 'moorstead' && d.room ? ` (${d.room})` : (input.warden ? ' (WARDEN)' : '');
  return `Minted ${game} code${extra}: *${d.code}*`;
}

export async function steadsRevoke(input = {}) {
  const game = String(input.game || '').toLowerCase();
  const code = String(input.code || '').trim().toLowerCase();
  if (!LEDGERS[game]) return `Unknown game "${input.game}".`;
  if (!code) return 'Which code? Pass the code to revoke.';
  const confirmId = randomBytes(4).toString('hex');
  PENDING.set(confirmId, { game, code, expiresAt: Date.now() + EXPIRY_MS });
  return `Revoke ${game} code *${code}*? This deletes the account + its tokens.\n`
    + `Confirm with steads_revoke_confirm (confirm_id ${confirmId}) — expires in 10 min.`;
}

export async function steadsRevokeConfirm(input = {}) {
  const id = String(input.confirm_id || '');
  const entry = PENDING.get(id);
  if (!entry || Date.now() > entry.expiresAt) { PENDING.delete(id); return 'That confirm id is unknown or expired. Start over with steads_revoke.'; }
  PENDING.delete(id);
  const d = await post(LEDGERS[entry.game] + '/api/revoke', { code: entry.code });
  if (!d || !d.ok) return `Revoke failed${d && d.error ? ': ' + d.error : ''}.`;
  return `Revoked ${entry.game} code *${entry.code}*.`;
}

export function steadsMute(input = {}) {
  const on = input.on === undefined ? true : !!input.on;
  setMuted(on);
  return on
    ? 'Clint notifications muted (until the next restart). Unmute with steads_mute on=false.'
    : 'Clint notifications unmuted.';
}
