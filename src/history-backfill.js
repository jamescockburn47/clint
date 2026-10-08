// WhatsApp history backfill — capture messages Clint missed while offline and
// write them into the SAME per-day conversation logs the live path uses, so the
// existing dream → memory pipeline ingests them with no other changes.
//
// Two entry points feed this:
//   1. the `messaging-history.set` event (fires on (re)connect and on-demand) —
//      the durable catch-up: any downtime gap self-heals within WhatsApp's window.
//   2. a one-shot `fetchMessageHistory` request for a chat (paging further back).
//
// Unlike conversation-logger.logConversation (which stamps NOW and writes today's
// file), backfill routes each message to the daily file for its ORIGINAL date and
// dedups against what's already there, so re-syncs don't duplicate.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const CONV_LOG_DIR = join('data', 'conversation-logs');

// One-shot state (per process): the oldest message seen per chat, and a guard so
// the on-demand fetch fires only once.
const oldestByJid = new Map(); // jid -> { key, ts }
let oneShotFired = false;

function tsSeconds(m) {
  const t = m?.messageTimestamp;
  if (t == null) return 0;
  if (typeof t === 'number') return t;
  if (typeof t === 'object' && typeof t.toNumber === 'function') return t.toNumber();
  return Number(t) || 0;
}

function extractText(m) {
  const c = m?.message || {};
  return c.conversation
    || c.extendedTextMessage?.text
    || c.imageMessage?.caption
    || c.videoMessage?.caption
    || c.documentMessage?.caption
    || '';
}

function noteOldest(m) {
  const jid = m?.key?.remoteJid;
  const ts = tsSeconds(m);
  if (!jid || !ts) return;
  const cur = oldestByJid.get(jid);
  if (!cur || ts < cur.ts) oldestByJid.set(jid, { key: m.key, ts });
}

/**
 * Write a batch of Baileys WAMessages into the per-day group logs, routed by each
 * message's original date, deduped by (sender|text) within a day. Groups only —
 * matching the existing per-group conversation logs. Returns a summary.
 */
export function backfillHistory(rawMessages, { botName = 'Clint' } = {}) {
  const byFile = new Map(); // filepath -> entries[]
  let considered = 0;
  for (const m of rawMessages || []) {
    noteOldest(m);
    const jid = m?.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) continue; // group chats only
    const ts = tsSeconds(m);
    const text = extractText(m);
    if (!ts || !text) continue;
    considered++;
    const iso = new Date(ts * 1000).toISOString();
    const date = iso.split('T')[0];
    const file = join(CONV_LOG_DIR, `${date}_${jid.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`);
    const fromMe = !!m.key?.fromMe;
    const entry = {
      timestamp: iso,
      sender: fromMe ? botName : (m.pushName || m.key?.participant || 'Unknown'),
      text,
      isBot: fromMe,
      ...(m.key?.participant ? { senderJid: m.key.participant } : {}),
    };
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(entry);
  }

  let kept = 0;
  const days = new Set();
  for (const [file, entries] of byFile) {
    let existing = '';
    try { existing = existsSync(file) ? readFileSync(file, 'utf-8') : ''; } catch { /* treat as empty */ }
    const seen = new Set();
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); seen.add(`${e.sender}|${(e.text || '').slice(0, 120)}`); } catch { /* skip */ }
    }
    const fresh = [];
    for (const e of entries) {
      const sig = `${e.sender}|${e.text.slice(0, 120)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      fresh.push(e);
    }
    if (!fresh.length) continue;
    fresh.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    try {
      const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
      writeFileSync(file, prefix + fresh.map((x) => JSON.stringify(x)).join('\n') + '\n');
      kept += fresh.length;
      days.add(file.split(/[\\/]/).pop().slice(0, 10));
    } catch (err) {
      logger.error({ err: err.message, file }, 'history backfill: write failed');
    }
  }

  const summary = { considered, backfilled: kept, days: [...days].sort() };
  if (kept) logger.info(summary, 'history backfill: wrote missed messages to daily logs');
  return summary;
}

/**
 * One-shot: ask WhatsApp for older messages before the oldest we've seen in `jid`.
 * Results arrive asynchronously via `messaging-history.set` (syncType ON_DEMAND)
 * and are written by backfillHistory. Fires at most once per process. Best-effort:
 * WhatsApp may serve little or nothing for old gaps on a long-linked device.
 */
export async function fetchOlderOnce(sock, jid, count = 60) {
  if (oneShotFired) return;
  const anchor = jid ? oldestByJid.get(jid) : null;
  if (!anchor) { logger.warn({ jid }, 'history one-shot: no anchor message seen yet — nothing to page back from'); return; }
  oneShotFired = true;
  try {
    logger.info({ jid, before: new Date(anchor.ts * 1000).toISOString(), count }, 'history one-shot: requesting older messages');
    await sock.fetchMessageHistory(count, anchor.key, anchor.ts);
  } catch (err) {
    logger.error({ err: err.message }, 'history one-shot: fetchMessageHistory failed');
  }
}

// Seed an anchor from a LIVE message — so the on-demand page-back can target a
// chat even when no history-sync event ever fires on this connection (the usual
// case for an already-linked device).
export function noteMessage(m) { noteOldest(m); }

// Poll until an anchor for `jid` exists (from history sync OR live traffic), then
// fire the one-shot page-back exactly once. Gives up after maxTries.
export function armOnDemandFetch(sock, jid, { count = 80, everyMs = 30000, maxTries = 40 } = {}) {
  if (oneShotFired || !jid) return;
  let tries = 0;
  const timer = setInterval(() => {
    if (oneShotFired || tries++ >= maxTries) { clearInterval(timer); return; }
    if (oldestByJid.has(jid)) { clearInterval(timer); fetchOlderOnce(sock, jid, count); }
  }, everyMs);
  timer.unref?.();
}
