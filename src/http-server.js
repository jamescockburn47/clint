// src/http-server.js — HTTP server and dashboard API endpoints
// Voice/chat handlers delegated to voice-handler.js.

import { createServer } from 'http';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './config.js';
import logger from './logger.js';
import { addSSEClient, broadcastSSE } from './sse.js';
import { getRecentMessages, getAllRecentMessages } from './buffer.js';
import { getUsageStats } from './claude.js';
import { checkLlamaHealth as checkEvoLlmHealth } from './evo-client.js';
import { getWidgetData, startWidgetRefresh, forceRefresh } from './widgets.js';
import { getSoulData, resetSoul } from './tools/soul.js';
import { getAllTodos, todoComplete } from './tools/todo.js';
import { getAuditLog } from './audit.js';
import { getEvoStatus, getMemoryStats, listMemories, searchMemory, storeNote, updateMemory, deleteMemory, getLastHealthData } from './memory.js';
import { getSystemHealth } from './scheduler.js';
import { getQualitySummary, getRecentFeedback } from './interaction-log.js';
import { getWorkingMemoryState } from './lquorum-rag.js';
import { getRecentQwenTelemetry } from './qwen-chat.js';
import { getRegisteredGroups } from './group-registry.js';
import { getParticipationProfile, mergeParticipationProfile } from './participation/policy-service.js';
import { getRecentParticipationDecisions } from './participation/log-store.js';
import {
  buildParticipationSummary,
  DEFAULT_PARTICIPATION_DECISIONS_PAGE_SIZE,
  PARTICIPATION_DECISIONS_RESPONSE_CAP,
  serializeParticipationDecisionsForApi,
} from './participation/http.js';
import { PARTICIPATION_DEFAULTS } from './participation/constants.js';
import { handleVoiceLocal, handleVoiceCommand, handleDashboardChat } from './voice-handler.js';
import { handleDebate } from './debate-handler.js';
import { triggerForgeNow } from './overnight/forge-now-http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function checkAuth(req) {
  if (!config.dashboardToken) return true;
  const url = new URL(req.url, 'http://localhost');
  const t = url.searchParams.get('token');
  const h = req.headers.authorization;
  return (t === config.dashboardToken) || (h?.startsWith('Bearer ') && h.slice(7) === config.dashboardToken);
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b)); });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function urlPath(req) { return new URL(req.url, 'http://localhost').pathname; }

export function startHttpServer(port, deps) {
  const { getActiveSock, sendProactiveMessage, getLastActivity } = deps;

  const server = createServer(async (req, res) => {
    const path = urlPath(req);

    // --- Failover health probe (Pi-side failover-check.sh hits this).
    // No auth: it has to work when the bot is otherwise unreachable, and
    // it returns nothing sensitive. ---
    if (path === '/health') {
      return json(res, 200, { status: 'ok' });
    }

    // --- Bot Council debate endpoint (no dashboard-token auth — council sends
    // its own bearer token; verification of that belongs in a future phase
    // once LQC exposes a registration secret. For now the endpoint is
    // idempotent and side-effect-free beyond tool calls, which are themselves
    // read-only in this context). ---
    if (req.method === 'POST' && path === '/debate') {
      try {
        const body = JSON.parse(await readBody(req));
        const result = await handleDebate(body);
        return json(res, 200, result);
      } catch (err) {
        logger.error({ err: err.message }, 'debate endpoint error');
        return json(res, 500, { response: 'Internal error processing debate request.', confidence: 50 });
      }
    }

    if (req.method === 'POST' && path === '/api/send') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { jid, message } = JSON.parse(await readBody(req));
        if (!jid || !message) return json(res, 400, { error: 'jid and message required' });
        await sendProactiveMessage(jid, message);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    // --- Steads notifications — the game ledgers POST events here (HMAC via
    // STEADS_WEBHOOK_SECRET); notable ones DM James, all feed the daily digest.
    if (req.method === 'POST' && path === '/api/steads-event') {
      const { handleSteadsEvent } = await import('./steads/webhook.js');
      const rawBody = await readBody(req);
      const sig = req.headers['x-steads-signature'];
      const out = await handleSteadsEvent({
        rawBody,
        signature: typeof sig === 'string' ? sig : String(sig || ''),
        sendProactiveMessage,
      });
      return json(res, out.status, out.body);
    }

    if (req.method === 'POST' && path === '/api/moorstead-event') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      if (!config.moorsteadEnabled) return json(res, 200, { ok: true, disabled: true });
      try {
        const evt = JSON.parse(await readBody(req));
        const { ingestMoorsteadEvent } = await import('./moorstead/ingest.js');
        const result = await ingestMoorsteadEvent(evt, {
          send: (text) => sendProactiveMessage(config.moorsteadJid || config.ownerJid, text),
        });
        return json(res, result.ok ? 200 : 400, result);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/status') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const s = getActiveSock();
      return json(res, 200, { connected: !!s, name: s?.user?.name || null, jid: s?.user?.id || null, lastActivity: getLastActivity(), uptime: Math.round(process.uptime()), memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
    }

    if (path === '/api/usage') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getUsageStats());
    }
    if (path === '/api/qwen-telemetry') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { requests: getRecentQwenTelemetry() });
    }
    if (path === '/api/working-memory') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getWorkingMemoryState());
    }

    if (path === '/dashboard') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const hp = join(__dirname, '..', 'public', 'dashboard.html');
      if (existsSync(hp)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(readFileSync(hp, 'utf-8')); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Dashboard not found');
    }

    if (path === '/api/system-health') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const h = getSystemHealth();
        try { const ms = await getMemoryStats(); h.memory = { total: ms.total || 0, categories: ms.categories || {} }; } catch { h.memory = { total: 0, categories: {} }; }
        h.uptime = Math.round(process.uptime());
        h.nodeHeapMB = Math.round(process.memoryUsage().heapUsed / 1048576);
        // EVO system resources (bot runs on EVO, not Pi)
        try {
          const { execSync } = await import('child_process');
          const vramBytes = parseInt(execSync('cat /sys/class/drm/card1/device/mem_info_vram_total 2>/dev/null || echo 0').toString().trim());
          const freeLine = execSync('free -m').toString().split('\n').find(l => l.startsWith('Mem:'));
          const totalRamMB = freeLine ? parseInt(freeLine.trim().split(/\s+/)[1]) : 0;
          const usedRamMB = freeLine ? parseInt(freeLine.trim().split(/\s+/)[2]) : 0;
          h.evoSystem = {
            vramGB: Math.round(vramBytes / 1073741824),
            totalRamMB,
            usedRamMB,
            cores: parseInt(execSync('nproc').toString().trim()) || 0,
          };
        } catch { /* intentional: system info is best-effort */ }
        // Legacy field kept for backward compat with old dashboard builds
        h.memoryMB = h.nodeHeapMB;
        return json(res, 200, h);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/widgets') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { json(res, 200, await getWidgetData()); } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === 'POST' && path === '/api/widgets/refresh') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { await forceRefresh(); json(res, 200, await getWidgetData()); } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    if (path === '/api/soul') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getSoulData());
    }
    if (req.method === 'POST' && path === '/api/soul/reset') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      await resetSoul(); return json(res, 200, { ok: true, message: 'Soul reset to defaults' });
    }
    if (req.method === 'POST' && path === '/api/soul/observe') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { addObservation } = await import('./tools/soul.js');
        const body = JSON.parse(await readBody(req));
        const obs = Array.isArray(body) ? body : [body];
        const results = []; for (const o of obs) results.push(await addObservation(o));
        return json(res, 200, { ok: true, results });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/todos') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { todos: getAllTodos() });
    }
    if (req.method === 'POST' && path === '/api/todos/complete') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { id } = JSON.parse(await readBody(req));
        if (!id) return json(res, 400, { error: 'id required' });
        const result = await todoComplete({ id });
        broadcastSSE('todos', { todos: getAllTodos() });
        return json(res, 200, { ok: true, message: result, todos: getAllTodos() });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    // --- Phase 5 retirement: old evolution/improvement routes ---
    // Evolution task queue replaced by IMPROVE stage + proposal cards in
    // data/overnight/proposals/. Manual improvement replaced by on-demand
    // forge via /api/forge-now (see below).
    if (
      (req.method === 'POST' && path === '/api/evolution/task') ||
      path === '/api/evolution/list' ||
      (req.method === 'POST' && path === '/api/evolution/approve') ||
      (req.method === 'POST' && path === '/api/evolution/reject') ||
      (req.method === 'POST' && path === '/api/improvement/run-now')
    ) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 410, {
        error: 'retired',
        message:
          'This endpoint was retired in Phase 5. See /api/morning-report/:date for the current report, ' +
          '/api/overnight-events/:date for the raw event log, and data/overnight/proposals/ for pending candidates.',
      });
    }

    // --- Knowledge-refresh webhook — called by bot-council's deploy
    // pipeline (ship.sh post-hook, GitHub Action, or ad-hoc curl) to
    // trigger an out-of-band drift check against
    // data/lqcouncil-knowledge.json. HMAC-SHA256 signed over the RAW
    // request body (not re-serialized JSON — that's the #1 Sentry
    // webhook pitfall per the SOTA survey), with
    // LQCOUNCIL_REFRESH_SECRET in the `x-clint-signature` header.
    // Fail-closed when secret unset.
    //
    // Idempotency: payload `{commit_sha, ...}` is deduped against the
    // last-processed SHA within LQC_REFRESH_DEDUPE_MS (default 10 min).
    // At-least-once delivery is the universal webhook guarantee
    // (LaunchDarkly, Algolia, Stripe, GitHub all explicitly document
    // this) — without dedupe, a retry on a transient network error
    // runs the drift check twice.
    if (req.method === 'POST' && path === '/api/lqcouncil-knowledge-refresh') {
      const { createHmac, timingSafeEqual } = await import('node:crypto');
      const secret = config.lqcouncilRefreshSecret || '';
      if (!secret) return json(res, 503, { error: 'refresh webhook disabled: LQCOUNCIL_REFRESH_SECRET unset' });
      const rawBody = await readBody(req);
      const sigHeader = req.headers['x-clint-signature'];
      const sig = typeof sigHeader === 'string' ? sigHeader : String(sigHeader || '');
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const expBuf = Buffer.from(expected, 'utf8');
      const actBuf = Buffer.from(sig, 'utf8');
      let ok = false;
      try {
        ok = expBuf.length === actBuf.length && timingSafeEqual(expBuf, actBuf);
      } catch {
        ok = false;
      }
      if (!ok) return json(res, 401, { error: 'invalid signature' });

      // Parse payload opportunistically — empty body is fine (back-compat
      // with any existing callers that send no body).
      let payload = {};
      if (rawBody && rawBody.length > 0) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          // Non-JSON body is allowed; treat as no commit SHA.
          payload = {};
        }
      }
      const commitSha = typeof payload.commit_sha === 'string' ? payload.commit_sha : null;
      const refreshReason = typeof payload.reason === 'string' ? payload.reason : 'webhook';

      // Idempotency check against last-processed SHA.
      const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
      const dedupeStatePath = 'data/runtime/lqc-refresh-dedupe.json';
      const dedupeWindowMs = parseInt(process.env.LQC_REFRESH_DEDUPE_MS || '600000', 10);
      let dedupeState = { sha: null, processedAt: null };
      if (existsSync(dedupeStatePath)) {
        try { dedupeState = JSON.parse(readFileSync(dedupeStatePath, 'utf8')); }
        catch { /* intentional: stale state file — just treat as empty */ }
      }
      if (commitSha && dedupeState.sha === commitSha && dedupeState.processedAt) {
        const ageMs = Date.now() - Date.parse(dedupeState.processedAt);
        if (Number.isFinite(ageMs) && ageMs < dedupeWindowMs) {
          return json(res, 200, {
            ok: true,
            skipped: true,
            reason: 'already-processed',
            commit_sha: commitSha,
            processed_at: dedupeState.processedAt,
            age_ms: ageMs,
          });
        }
      }

      try {
        const { runKnowledgeDriftCheck } = await import('./tasks/lqc-knowledge-drift.js');
        const result = await runKnowledgeDriftCheck({
          reason: commitSha ? `webhook:${commitSha.slice(0, 7)}` : refreshReason,
        });
        // Persist dedupe state only on successful run.
        if (commitSha) {
          try {
            mkdirSync('data/runtime', { recursive: true });
            writeFileSync(dedupeStatePath, JSON.stringify({ sha: commitSha, processedAt: new Date().toISOString() }, null, 2), 'utf8');
          } catch (err) {
            logger.warn({ err: err.message }, 'lqcouncil-knowledge-refresh: dedupe persist failed');
          }
        }
        return json(res, 202, {
          ok: true,
          reason: refreshReason,
          commit_sha: commitSha,
          actionable_changes: result.actionable.length,
          proposal: result.proposalPath,
          sourceAvailable: result.sourceAvailable,
        });
      } catch (err) {
        logger.error({ err: err.message }, 'lqcouncil-knowledge-refresh: run failed');
        return json(res, 500, { error: err.message });
      }
    }

    // --- Sentry webhook — inbound alerts from bot-council projects.
    // HMAC-signed by Sentry with sentry-hook-signature header; no bearer
    // token needed. Routes to the LQcouncil-bound group so authors see
    // errors affecting their bots.
    if (req.method === 'POST' && path === '/api/sentry-webhook') {
      const { handleSentryWebhookRequest } = await import('./lqcouncil/sentry-webhook.js');
      const rawBody = await readBody(req);
      const signature = req.headers['sentry-hook-signature'] || '';
      const out = await handleSentryWebhookRequest({
        rawBody,
        signature: typeof signature === 'string' ? signature : String(signature),
        headers: req.headers,
        sendProactiveMessage,
      });
      return json(res, out.status, out.body);
    }

    // --- On-demand forge trigger (spec §4.4 emergency mode) ---
    if (req.method === 'POST' && path === '/api/forge-now') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { checkImprove } = await import('./overnight/improve-task.js');
        const result = await triggerForgeNow({ checkImprove, logger });
        return json(res, result.status, result.body);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (path === '/api/messages') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      // Return merged feed from ALL chat buffers (not just owner DM)
      return json(res, 200, { messages: getAllRecentMessages(200) });
    }
    if (path === '/api/audit') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { audit: await getAuditLog(50) });
    }
    // --- Task planner diagnostics ---
    if (path === '/api/plans') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { getRecentPlans } = await import('./task-planner.js');
      const plans = getRecentPlans(20);
      return json(res, 200, { plans, count: plans.length });
    }
    if (path.startsWith('/api/plans/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const planId = path.split('/api/plans/')[1];
      const { getPlanById } = await import('./task-planner.js');
      const plan = getPlanById(planId);
      if (!plan) return json(res, 404, { error: 'plan not found' });
      return json(res, 200, { plan });
    }
    // --- Phase 5 retirement: /api/overnight-report/:date replaced by
    // /api/morning-report/:date which reads from the event log (spec §4.3). ---
    if (path.startsWith('/api/overnight-report/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 410, {
        error: 'retired',
        message: 'Use /api/morning-report/:date instead (spec §4.3).',
      });
    }

    // --- Morning report JSON (Phase 3, structured + staleness-guarded) ---
    if (path.startsWith('/api/morning-report/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const dateStr = path.split('/api/morning-report/')[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      }
      try {
        const { buildAndRenderReport } = await import('./overnight/report.js');
        const overnightDir = join(__dirname, '..', 'data', 'overnight');
        const { report, text } = await buildAndRenderReport({
          date: dateStr,
          overnightDir,
        });
        return json(res, 200, { date: dateStr, report, text });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // --- Overnight events + shadow candidates (new event log, for clawd-console drill-down) ---
    if (path.startsWith('/api/overnight-events/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const dateStr = path.split('/api/overnight-events/')[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      }
      try {
        const { queryEvents } = await import('./overnight/events.js');
        const events = await queryEvents({ date: dateStr });
        const shadowFile = join(__dirname, '..', 'data', 'overnight', `shadow-candidates-${dateStr}.jsonl`);
        let shadowCandidates = [];
        if (existsSync(shadowFile)) {
          const raw = readFileSync(shadowFile, 'utf-8').trim().split('\n').filter(Boolean);
          for (const line of raw) {
            try {
              shadowCandidates.push(JSON.parse(line));
            } catch {
              // intentional: skip malformed lines, don't fail the whole request
            }
          }
        }
        return json(res, 200, { date: dateStr, events, shadowCandidates });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // --- Trace analysis diagnostics ---
    if (path === '/api/traces') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { getLatestAnalysis } = await import('./tasks/trace-analyser.js');
      const analysis = getLatestAnalysis();
      if (!analysis) return json(res, 200, { analysis: null, message: 'No trace analysis yet — runs nightly at 3 AM' });
      return json(res, 200, { analysis });
    }
    if (path === '/api/traces/live') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { analyseTraces } = await import('./tasks/trace-analyser.js');
      return json(res, 200, { analysis: analyseTraces(1) }); // last 24h, on-demand
    }
    if (path === '/api/stats/messages') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      // Count all messages in today's conversation logs (full volume, not just Clawd-processed)
      const today = new Date().toISOString().split('T')[0];
      const logDir = join(__dirname, '..', 'data', 'conversation-logs');
      let totalMessages = 0;
      let groupCount = 0;
      const groups = {};
      try {
        const files = readdirSync(logDir).filter(f => f.startsWith(today));
        for (const f of files) {
          const lines = readFileSync(join(logDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          const isGroup = f.includes('_g_us');
          if (isGroup) groupCount++;
          totalMessages += lines.length;
          const label = f.replace(`${today}_`, '').replace('.jsonl', '');
          groups[label] = lines.length;
        }
      } catch { /* intentional: log dir may not exist yet on fresh start */ }
      return json(res, 200, { date: today, totalMessages, groupCount, groups });
    }
    // --- Phase 5 retirement: weekly retrospective folded into IMPROVE. ---
    if (path === '/api/retrospective') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, {
        retrospective: null,
        message:
          'Weekly retrospective was retired in Phase 5. See /api/morning-report/:date (Saturday) ' +
          'for the IMPROVE stage output.',
      });
    }
    if (path === '/api/quality') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const days = parseInt(new URL(req.url, 'http://localhost').searchParams.get('days') || '7');
      return json(res, 200, { summary: getQualitySummary(days), recentFeedback: getRecentFeedback(20) });
    }
    if (path === '/api/participation/groups') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const registered = getRegisteredGroups();
        const groups = registered.map((g) => {
          const profile = getParticipationProfile({
            chatJid: g.jid,
            groupLabel: g.label || g.jid,
            groupMode: g.mode,
          });
          return buildParticipationSummary({
            chatJid: profile.chatJid,
            groupLabel: profile.groupLabel,
            groupMode: profile.groupMode,
            posture: profile.posture,
            researchEnabled: profile.researchEnabled,
            memoryRecallEnabled: profile.memoryRecallEnabled,
            maxUnsolicitedPerHour: profile.maxUnsolicitedPerHour,
            followUpWindowMs: profile.followUpWindowMs,
            cooldownMs: profile.cooldownMs,
          });
        });
        return json(res, 200, { groups });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (path === '/api/participation/decisions') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const rawLimit = parseInt(
          new URL(req.url, 'http://localhost').searchParams.get('limit') ||
            String(DEFAULT_PARTICIPATION_DECISIONS_PAGE_SIZE),
          10,
        );
        const safeLimit = Math.min(
          PARTICIPATION_DECISIONS_RESPONSE_CAP,
          Math.max(
            0,
            Number.isFinite(rawLimit)
              ? rawLimit
              : DEFAULT_PARTICIPATION_DECISIONS_PAGE_SIZE,
          ),
        );
        const raw = getRecentParticipationDecisions(safeLimit);
        return json(res, 200, serializeParticipationDecisionsForApi(raw));
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    // --- Participation config (combined read) ---
    if (path === '/api/participation/config') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const registered = getRegisteredGroups();
        const groups = registered.map((g) => {
          const profile = getParticipationProfile({ chatJid: g.jid, groupLabel: g.label || g.jid, groupMode: g.mode });
          return {
            chatJid: g.jid,
            label: g.label || g.jid,
            mode: g.mode,
            participation: {
              posture: profile.posture,
              researchEnabled: profile.researchEnabled,
              memoryRecallEnabled: profile.memoryRecallEnabled,
              maxUnsolicitedPerHour: profile.maxUnsolicitedPerHour,
              followUpWindowMs: profile.followUpWindowMs,
              cooldownMs: profile.cooldownMs,
            },
          };
        });
        return json(res, 200, { groups, defaults: { participation: PARTICIPATION_DEFAULTS } });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // --- PATCH participation profile for a group ---
    if (req.method === 'PATCH' && path.startsWith('/api/participation/groups/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const jid = decodeURIComponent(path.slice('/api/participation/groups/'.length));
        if (!jid) return json(res, 400, { error: 'Missing group JID' });
        const body = JSON.parse(await readBody(req));
        const VALID_FIELDS = new Set(['posture', 'researchEnabled', 'memoryRecallEnabled', 'maxUnsolicitedPerHour', 'followUpWindowMs', 'cooldownMs']);
        const VALID_POSTURES = new Set(['direct_only', 'rare_high_confidence', 'active_participant']);
        const patch = {};
        for (const [k, v] of Object.entries(body)) {
          if (!VALID_FIELDS.has(k)) return json(res, 400, { error: `Unknown field: ${k}` });
          if (k === 'posture' && !VALID_POSTURES.has(v)) return json(res, 400, { error: `Invalid posture: ${v}` });
          if (k === 'maxUnsolicitedPerHour' && (typeof v !== 'number' || v < 1 || v > 20)) return json(res, 400, { error: 'maxUnsolicitedPerHour must be 1-20' });
          if (k === 'followUpWindowMs' && (typeof v !== 'number' || v < 60000 || v > 600000)) return json(res, 400, { error: 'followUpWindowMs must be 60000-600000' });
          if (k === 'cooldownMs' && (typeof v !== 'number' || v < 30000 || v > 600000)) return json(res, 400, { error: 'cooldownMs must be 30000-600000' });
          if ((k === 'researchEnabled' || k === 'memoryRecallEnabled') && typeof v !== 'boolean') return json(res, 400, { error: `${k} must be boolean` });
          patch[k] = v;
        }
        mergeParticipationProfile(jid, patch);
        const registered = getRegisteredGroups().find((g) => g.jid === jid);
        const updated = getParticipationProfile({ chatJid: jid, groupLabel: registered?.label || jid, groupMode: registered?.mode || 'colleague' });
        return json(res, 200, { ok: true, profile: updated });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (path === '/api/evo' || path === '/api/ollama') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const evoOnline = await checkEvoLlmHealth();
      return json(res, 200, { available: evoOnline, online: evoOnline, url: config.evoLlmUrl, model: evoOnline ? config.evoMainModelLabel : null });
    }

    // --- Memory endpoints ---
    if (path === '/api/memory/status') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { evo: getEvoStatus(), stats: await getMemoryStats(), health: getLastHealthData() });
    }
    if (path === '/api/memory/list') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const m = await listMemories(); return json(res, 200, { memories: m, count: m.length });
    }
    if (req.method === 'POST' && path === '/api/memory/search') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const b = JSON.parse(await readBody(req));
        if (!b.query) return json(res, 400, { error: 'query required' });
        return json(res, 200, { results: await searchMemory(b.query, b.category, b.limit || 10) });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'POST' && path === '/api/memory/note') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { text } = JSON.parse(await readBody(req));
        if (!text) return json(res, 400, { error: 'text required' });
        return json(res, 200, await storeNote(text, 'dashboard_note'));
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'PUT' && path.startsWith('/api/memory/mem_')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { return json(res, 200, await updateMemory(path.split('/').pop(), JSON.parse(await readBody(req)))); }
      catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'DELETE' && path.startsWith('/api/memory/mem_')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { return json(res, 200, await deleteMemory(path.split('/').pop())); }
      catch (err) { return json(res, 500, { error: err.message }); }
    }

    // --- Voice / chat endpoints ---
    if (req.method === 'POST' && path === '/api/voice-local') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleVoiceLocal(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) {
        logger.error({ err: err.message }, 'voice-local error');
        broadcastSSE('voice', { event: 'toast', message: 'Voice command failed' });
        return json(res, 500, { error: err.message });
      }
    }
    if (req.method === 'POST' && path === '/api/voice-command') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleVoiceCommand(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) {
        broadcastSSE('voice', { event: 'error', message: err.message });
        return json(res, 500, { error: err.message });
      }
    }
    if (req.method === 'POST' && path === '/api/voice-status') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const body = JSON.parse(await readBody(req));
        if (body.event === 'heartbeat') { const { recordVoiceHeartbeat } = await import('./tools/handler.js'); recordVoiceHeartbeat(body); }
        broadcastSSE('voice', body); return json(res, 200, { ok: true });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'POST' && path === '/api/desktop-mode') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        logger.info('desktop mode requested — killing kiosk Chromium');
        exec('touch /tmp/clawd-desktop-mode && pkill chromium', (err) => { if (err) logger.warn({ err: err.message }, 'chromium kill non-zero'); });
        json(res, 200, { ok: true, message: 'Kiosk hidden. Use Clint Desktop shortcut to return.' });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === 'POST' && path === '/api/chat') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleDashboardChat(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    // --- SSE ---
    if (path === '/api/events') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
      addSSEClient(res); return;
    }

    // Default page — auth-gated. Previously this catch-all leaked
    // DASHBOARD_TOKEN in the dashboard link href to ANY unauthenticated
    // GET, which combined with the public Cloudflare Tunnel ingress
    // (since removed) was a full token compromise vector. (Diag
    // 2026-05-06.)
    if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });
    const sock = getActiveSock();
    if (sock?.user?.id) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Connected as ${sock.user.name || 'Clint'}</h2><p>Dashboard: <a href="/dashboard?token=${config.dashboardToken}">/dashboard</a></p></body></html>`);
    } else if (existsSync('/tmp/qr.png')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const img = readFileSync('/tmp/qr.png').toString('base64');
      res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Scan QR to link WhatsApp</h2><img src="data:image/png;base64,${img}" style="width:400px"/><p style="color:#888">Auto-refreshing every 5s</p></body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Waiting for QR...</h2><p style="color:#888">Auto-refreshing</p></body></html>');
    }
  });

  // Bot Council smoke-tests and debate rounds send up to five back-to-back
  // POSTs to /debate with a single pooled HTTP client. Node's default
  // keepAliveTimeout (5s) is far shorter than a tool-heavy debate response
  // (which can run 20-45s), so the pooled connection is stale by the next
  // round and the caller's first attempt fails with "error sending request"
  // before retrying. Extending the server-side idle window keeps the
  // connection usable across the full 5-round gauntlet. headersTimeout
  // must exceed keepAliveTimeout (Node invariant).
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  server.listen(port, () => logger.info({ port }, 'HTTP server started'));

  startWidgetRefresh();

  return server;
}
