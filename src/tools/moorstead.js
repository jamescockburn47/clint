// Moorstead game relay — admin tool handlers
// Calls the relay's /admin/* HTTP API on behalf of the bot owner.
// All errors are caught and returned as readable strings; nothing throws.

import { exec as _nodeExec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import config from '../config.js';

// ── Destructive-ops confirm gate ─────────────────────────────────────────────
//
// Two-step flow identical in spirit to lqc_start_debate / lqc_confirm_debate:
//   1. `moorstead_ops`         — validates params, stores pending op, returns warning.
//   2. `moorstead_ops_confirm` — consumes the pending op by confirm_id, execs command.
//
// A module-level Map keeps state in-process (same lifetime as the bot).
// Pending ops expire after 10 minutes; confirm with wrong/expired id is refused.

const PENDING_OPS = new Map(); // confirm_id → { op, params, command, expiresAt }
const PENDING_EXPIRY_MS = 10 * 60 * 1000;

/** Exec wrapper — injectable for tests, defaults to child_process.exec */
let _execFn = promisify(_nodeExec);

/** For tests: replace the exec function used by the ops handlers */
export function _setExecFn(fn) {
  _execFn = fn;
}

// Allowlisted service names → systemd unit names
const SERVICE_ALLOWLIST = new Map([
  ['relay',    'moorstead-world'],
  ['brain',    'moorstead-brain'],
  ['dash',     'moorstead-dash'],
  ['body',     'clint-body'],
  ['clawdbot', 'clawdbot'],
]);

const ROOM_NAME_RE = /^[a-z]{2,16}$/;

function generateConfirmId() {
  return randomBytes(4).toString('hex');
}

function storeOp(op, params, command) {
  const confirmId = generateConfirmId();
  PENDING_OPS.set(confirmId, {
    op,
    params,
    command,
    expiresAt: Date.now() + PENDING_EXPIRY_MS,
  });
  return confirmId;
}

function consumeOp(confirmId) {
  const entry = PENDING_OPS.get(confirmId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PENDING_OPS.delete(confirmId);
    return null;
  }
  PENDING_OPS.delete(confirmId);
  return entry;
}

/**
 * moorstead_ops — stage a destructive op and return a confirm-gated warning.
 * input: { op: 'restart_service'|'reset_room', service?: string, room?: string }
 */
export async function moorsteadOps(input) {
  const op = (input.op || '').trim();

  if (op === 'restart_service') {
    const service = (input.service || '').trim().toLowerCase();
    if (!service) return 'service is required for restart_service.';
    const unit = SERVICE_ALLOWLIST.get(service);
    if (!unit) {
      return `Unknown service "${service}". Allowed: ${[...SERVICE_ALLOWLIST.keys()].join(', ')}.`;
    }
    const command = `sudo systemctl restart ${unit}`;
    const confirmId = storeOp('restart_service', { service, unit }, command);
    return (
      `⚠️ This will RESTART the *${unit}* service (alias: ${service}). ` +
      `All connected players will be disconnected. ` +
      `Reply with confirm_id \`${confirmId}\` via *moorstead_ops_confirm* to proceed. ` +
      `Expires in 10 minutes.`
    );
  }

  if (op === 'reset_room') {
    const roomRaw = (input.room || '').trim();
    if (!roomRaw) return 'room is required for reset_room.';
    // Validate BEFORE lowercasing — uppercase letters must be rejected explicitly
    if (!ROOM_NAME_RE.test(roomRaw)) {
      return `Invalid room name "${roomRaw}". Must match ^[a-z]{2,16}$ (lowercase letters only, 2–16 chars).`;
    }
    const room = roomRaw; // already lowercase per the regex
    // One-line shell command: backup then delete then kill world process to force reload
    const command = [
      `mkdir -p ~/moorstead/world/resets`,
      `&& cp ~/moorstead/world/${room}.json ~/moorstead/world/resets/${room}.$(date +%s).bak 2>/dev/null`,
      `; rm -f ~/moorstead/world/${room}.json`,
      `&& kill $(systemctl show -p MainPID --value moorstead-world.service)`,
    ].join(' ');
    const confirmId = storeOp('reset_room', { room }, command);
    return (
      `⚠️ This will RESET the *${room}* room (wipes all its edits; a backup is kept at ` +
      `~/moorstead/world/resets/${room}.<timestamp>.bak). The world process will be signalled to reload. ` +
      `Reply with confirm_id \`${confirmId}\` via *moorstead_ops_confirm* to proceed. ` +
      `Expires in 10 minutes.`
    );
  }

  return `Unknown op "${op}". Supported: restart_service, reset_room.`;
}

/**
 * moorstead_ops_confirm — execute a previously staged destructive op.
 * input: { confirm_id: string }
 */
export async function moorsteadOpsConfirm(input) {
  const confirmId = (input.confirm_id || '').trim();
  if (!confirmId) return 'confirm_id is required. Use moorstead_ops first to stage an operation.';

  const entry = consumeOp(confirmId);
  if (!entry) {
    return `No pending op with id \`${confirmId}\` (expired, already used, or never existed). ` +
      `Run moorstead_ops again if you still want to proceed.`;
  }

  try {
    const { stdout, stderr } = await _execFn(entry.command, { shell: '/bin/bash' });
    const out = (stdout || '').trim();
    const err = (stderr || '').trim();
    const lines = [];
    if (out) lines.push(`stdout: ${out}`);
    if (err) lines.push(`stderr: ${err}`);
    const detail = lines.length > 0 ? lines.join('\n') : '(no output)';
    return `✅ *${entry.op}* executed.\nCommand: \`${entry.command}\`\n${detail}`;
  } catch (err) {
    const msg = err.message || String(err);
    const stderr = (err.stderr || '').trim();
    return `❌ *${entry.op}* failed.\nCommand: \`${entry.command}\`\nError: ${msg}${stderr ? `\nstderr: ${stderr}` : ''}`;
  }
}

function relayHeaders() {
  return {
    'Authorization': `Bearer ${config.dashboardToken}`,
    'Content-Type': 'application/json',
  };
}

function baseUrl() {
  return (config.moorsteadRelayUrl || 'http://127.0.0.1:8096').replace(/\/$/, '');
}

/**
 * moorstead_status — who is playing, per room.
 * Returns e.g. "*Moorstead* — moor: Alice, Tom (2). dale: empty."
 */
export async function moorsteadStatus() {
  try {
    // the relay serves only /ws + /status; live presence lives on the dash
    const res = await fetch('http://127.0.0.1:8095/api/overview', {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return `Moorstead dash error ${res.status}`;
    const data = await res.json();
    const live = data.live || [];
    if (live.length === 0) return '*Moorstead* — nobody on the moor right now.';
    const byRoom = new Map();
    for (const x of live) {
      const room = x.room || 'solo';
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room).push(`${x.name || '(nameless)'} (${x.loc || '?'}, day ${x.day ?? '?'})`);
    }
    const parts = [...byRoom.entries()].map(([room, ps]) => `${room}: ${ps.join(', ')}`);
    return `*Moorstead* — ${live.length} on now. ${parts.join('. ')}.`;
  } catch (err) {
    return `Moorstead status failed: ${err.message}`;
  }
}

/**
 * moorstead_broadcast — send a system message to players.
 * input: { text: string, room?: string }
 */
export async function moorsteadBroadcast(input) {
  const text = (input.text || '').trim();
  if (!text) return 'No message text provided.';
  const body = { text };
  if (input.room) body.room = input.room;
  try {
    const res = await fetch(`${baseUrl()}/admin/broadcast`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const target = input.room ? ` to room *${input.room}*` : '';
    return `Broadcast sent${target} — ${data.sent ?? '?'} player(s) notified.`;
  } catch (err) {
    return `Moorstead broadcast failed: ${err.message}`;
  }
}

/**
 * moorstead_kick — disconnect a player by pid.
 * input: { pid: string }
 */
export async function moorsteadKick(input) {
  const pid = (input.pid || '').trim();
  if (!pid) return 'No pid provided.';
  try {
    const res = await fetch(`${baseUrl()}/admin/kick`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify({ pid }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const rooms = (data.kicked || []).join(', ') || 'none';
    return `Player *${pid}* kicked from room(s): ${rooms}.`;
  } catch (err) {
    return `Moorstead kick failed: ${err.message}`;
  }
}

/**
 * moorstead_bairns_status — bairns world controls + today's play time.
 * No params.
 */
export async function moorsteadBairnsStatus() {
  try {
    const res = await fetch(`${baseUrl()}/admin/bairns-controls`, {
      method: 'GET',
      headers: relayHeaders(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const controls = data.controls || {};
    const limitMin = controls.daily_limit_min ?? 0;
    const limitStr = limitMin === 0 ? 'no time limit' : `${limitMin} min/day`;
    const closed = controls.closed;
    const closedStr = closed ? `Closed ${closed.from}–${closed.to}.` : 'No closed window.';
    const openStr = data.closed_now ? 'Closed now.' : 'Open now.';
    const todaySec = data.today_seconds || {};
    const pids = Object.keys(todaySec);
    let todayStr;
    if (pids.length === 0) {
      todayStr = 'No play today.';
    } else {
      const maxMin = Math.round(Math.max(...Object.values(todaySec)) / 60);
      todayStr = `Today: ${pids.length} bairn${pids.length === 1 ? '' : 's'} played (max ${maxMin}m).`;
    }
    return `*Bairns world* — limit: ${limitStr}. ${closedStr} ${openStr} ${todayStr}`;
  } catch (err) {
    return `Moorstead bairns status failed: ${err.message}`;
  }
}

const HH_MM = /^\d{1,2}:\d{2}$/;

/**
 * moorstead_bairns_set — update bairns world controls.
 * input: { limitMinutes?, warnSeconds?, locked?, closeFrom?, closeTo?, clearClosed? }
 */
export async function moorsteadBairnsSet(input) {
  // Validate HH:MM fields before touching the network
  if (input.closeFrom !== undefined && !HH_MM.test(input.closeFrom)) {
    return `Invalid closeFrom "${input.closeFrom}" — expected HH:MM format.`;
  }
  if (input.closeTo !== undefined && !HH_MM.test(input.closeTo)) {
    return `Invalid closeTo "${input.closeTo}" — expected HH:MM format.`;
  }

  const body = {};
  if (input.limitMinutes !== undefined) body.daily_limit_min = input.limitMinutes;
  if (input.warnSeconds !== undefined) body.warn_sec = input.warnSeconds;
  if (input.locked !== undefined) body.locked = input.locked;
  if (input.clearClosed === true) {
    body.closed = null;
  } else if (input.closeFrom !== undefined || input.closeTo !== undefined) {
    body.closed = { from: input.closeFrom, to: input.closeTo };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin/bairns-controls`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const controls = data.controls || {};
    const limitMin = controls.daily_limit_min ?? 0;
    const limitStr = limitMin === 0 ? 'no time limit' : `${limitMin} min`;
    const closed = controls.closed;
    const closedStr = closed ? `, closed ${closed.from}–${closed.to}` : ', no closed window';
    const lockedStr = controls.locked ? ', world locked' : '';
    return `Bairns world updated — daily limit ${limitStr}${closedStr}${lockedStr}.`;
  } catch (err) {
    return `Moorstead bairns set failed: ${err.message}`;
  }
}
