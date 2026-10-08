// The Spire channel — Clint joins the members' 3D venue as a live orb, over the
// venue's OWN MCP endpoint (the same URL + bearer-key path every other agent
// uses). There is no bespoke wire protocol here: a generic MCP client drives the
// venue's await→act loop, and Clint's real brain writes the replies.
//
//   spire_await_event  →  getClawdResponseResult(...)  →  spire_say / spire_whisper / spire_reply
//
// The venue does all the heavy lifting behind /mcp — presence, owner-tether,
// public-address routing, rate limits, mute. This module is just the driver plus
// the bridge to Clint's brain and rolling memory.
//
// PRIVACY (deliberate): EVERYONE who talks to Clint's orb — passer-by or owner —
// is treated as a NON-OWNER, and the venue brain runs a web-only tool allowlist
// (spireSafe). So a Spire speaker can never reach James's owner-only tools
// (gmail / calendar / todos / soul) NOR his private stores (memory / soul reads).
// Owner tools over the venue would need a verified-owner identity the relay does
// not yet carry into the whisper, so that door stays shut. See think() below.
import config from './config.js';
import logger from './logger.js';
import { McpHttpClient } from './mcp-client.js';
import { getClawdResponseResult } from './claude.js';
import { pushMessage, buildContext } from './buffer.js';

const FLOOR_CHAT = 'spire:floor'; // rolling-context bucket for the public floor
const OWNER_DM = 'spire:owner';   // and for the owner's private whispers
const FLOOR_CHAR_CAP = 240;       // floor chat bubbles are short
const WHISPER_CHAR_CAP = 1500;
const AWAIT_SECONDS = 45;         // the venue caps a long-poll at 45s (its AWAIT_CAP_S)
// The client abort must outlast the server's worst case: waitConnected (~8s) +
// the await budget (AWAIT_SECONDS). Keep clear margin, else a benign long-poll
// aborts and forces a needless reconnect. If AWAIT_SECONDS rises, raise this too.
const AWAIT_CLIENT_TIMEOUT_MS = (AWAIT_SECONDS + 8 + 20) * 1000; // 73s: cap + connect + 20s slack

let stopped = false;
let client = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trim to a clean word boundary, never mid-word.
function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(' ', n - 1);
  return (cut > n * 0.6 ? s.slice(0, cut) : s.slice(0, n - 1)).trimEnd() + '…';
}

function mcpUrlWithName(baseUrl, name) {
  try {
    const u = new URL(baseUrl);
    if (name) u.searchParams.set('name', name);
    return u.toString();
  } catch { return baseUrl; }
}

/** Start the Spire channel. Inert unless SPIRE_ENABLED and a key are set. */
export function initSpireChannel() {
  if (!config.spireEnabled) { logger.info('spire channel disabled (SPIRE_ENABLED=false)'); return; }
  if (!config.spireAgentKey) { logger.warn('spire channel: SPIRE_ENABLED but SPIRE_AGENT_KEY is empty — not joining'); return; }
  stopped = false;
  client = new McpHttpClient({
    url: mcpUrlWithName(config.spireMcpUrl, config.spireName),
    headers: { authorization: `Bearer ${config.spireAgentKey}` },
    clientName: 'clawd-spire',
    clientVersion: '1.0.0',
  });
  logger.info({ url: config.spireMcpUrl, name: config.spireName }, 'spire channel starting');
  runLoop().catch((err) => logger.error({ err: err.message }, 'spire channel loop crashed'));
}

export function stopSpireChannel() { stopped = true; }

async function runLoop() {
  while (!stopped) {
    try {
      await client.initialize();
      logger.info({ server: client.serverInfo?.name }, 'spire: MCP initialized');

      // The first tool call opens the presence session (the orb walks in). If the
      // owner isn't in the venue yet, the venue declines — back off and retry.
      const status = await ensureConnected();
      if (!status.connected) {
        logger.info({ note: status.note || status.error }, 'spire: not admitted (owner absent?), retrying in 15s');
        await sleep(15000);
        continue;
      }
      logger.info({ floor: status.floor }, 'spire: orb present in the venue');

      // The loop: wait for the next thing that happens, act on it, wait again.
      while (!stopped) {
        const { data, isError } = await client.callTool('spire_await_event', { maxWaitSeconds: AWAIT_SECONDS }, AWAIT_CLIENT_TIMEOUT_MS);
        if (isError) { logger.info({ note: data?.error }, 'spire: session dropped, reconnecting'); break; }
        if (data?.none) continue;
        await handleEvent(data);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'spire: loop error, reconnecting in 8s');
      await sleep(8000);
    }
  }
  logger.info('spire channel stopped');
}

/** spire_status opens the session and reports connected/denied; poll briefly. */
async function ensureConnected() {
  let status = {};
  for (let i = 0; i < 12 && !status.connected; i++) {
    const r = await client.callTool('spire_status', {}, 15000);
    status = r.data || {};
    if (r.isError) return { connected: false, error: status.error || 'status error' };
    if (!status.connected) await sleep(700);
  }
  return status;
}

async function handleEvent(ev) {
  try {
    if (ev.kind === 'message') {
      const from = ev.from || 'a member';
      pushMessage(FLOOR_CHAT, { senderName: from, text: ev.text || '', isBot: false });
      const reply = await think(buildContext(FLOOR_CHAT, ev.text || ''), from, FLOOR_CHAT);
      if (!reply) return;
      const r = await client.callTool('spire_say', { text: clip(reply, FLOOR_CHAR_CAP) }, 15000);
      if (r.isError) { logger.warn({ from, note: r.data?.error }, 'spire: floor reply not delivered'); return; }
      // Record as Clint's own line only once it was actually said (never poison
      // the rolling buffer with an undelivered reply).
      pushMessage(FLOOR_CHAT, { senderName: config.spireName, text: reply, isBot: true });
      logger.info({ from, chars: reply.length }, 'spire: answered on the floor');
    } else if (ev.kind === 'whisper') {
      const from = ev.from || 'owner';
      pushMessage(OWNER_DM, { senderName: from, text: ev.text || '', isBot: false });
      const reply = await think(buildContext(OWNER_DM, ev.text || ''), from, OWNER_DM);
      if (!reply) return;
      const r = await client.callTool('spire_whisper', { text: clip(reply, WHISPER_CHAR_CAP) }, 15000);
      if (r.isError) { logger.warn({ from, note: r.data?.error }, 'spire: whisper not delivered'); return; }
      pushMessage(OWNER_DM, { senderName: config.spireName, text: reply, isBot: true });
      logger.info({ from, chars: reply.length }, 'spire: whispered back to owner');
    } else if (ev.kind === 'debate') {
      if (!ev.rid) return;
      const reply = await think(String(ev.prompt || ''), 'LQ Council', 'spire:debate');
      if (!reply) return;
      const r = await client.callTool('spire_reply', { rid: ev.rid, text: reply }, 15000);
      if (r.isError) { logger.warn({ rid: ev.rid, note: r.data?.error }, 'spire: council reply not delivered'); return; }
      logger.info({ rid: ev.rid, chars: reply.length }, 'spire: answered a Council round');
    }
  } catch (err) {
    logger.error({ err: err.message, kind: ev?.kind }, 'spire: event handling failed');
  }
}

// Run the message through Clint's real brain. Every Spire speaker is a NON-OWNER:
// forceRestricted hard-locks owner-only tools closed (even if OWNER_JID is unset),
// and spireSafe trims the tool set to public-web only — so a passer-by can neither
// invoke James's tools nor read his private memory/soul on the public floor.
async function think(context, from, chatJid) {
  try {
    const result = await getClawdResponseResult(
      context, 'direct', `spire:${from}`, null, chatJid, { forceRestricted: true, spireSafe: true },
    );
    // Never broadcast a transient-outage fallback ("Hit the API rate limit…") as if
    // Clint said it. Those returns carry meta:null (or provider 'unavailable'); a real
    // reply always carries a real provider. Stay silent instead.
    if (!result?.meta || result.meta.provider === 'unavailable') return '';
    return String(result.text || '').trim();
  } catch (err) {
    logger.error({ err: err.message }, 'spire: brain call failed');
    return '';
  }
}
