// Tool execution dispatcher — routes Claude tool calls to handlers
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarFindFreeTime } from './calendar.js';
import { gmailSearch, gmailRead, gmailDraft, gmailConfirmSend } from './gmail.js';
import { searchTrains, searchAccommodation } from './travel.js';
import { trainDepartures, trainFares } from './darwin.js';
import { hotelSearch } from './amadeus.js';
import { webSearch as _rawWebSearch, webFetch } from './search.js';
import { sovrenSiteAccess } from './sovren.js';
import { getWebPrefetch } from '../cortex.js';
import { soulRead, soulPropose, soulConfirm, soulLearn, soulForget } from './soul.js';
import { todoAdd, todoList, todoComplete, todoRemove, todoUpdate, getAllTodos } from './todo.js';
import { searchMemory, updateMemory, deleteMemory } from '../memory.js';
import { projectList, projectRead, projectPitch, projectUpdate, projectListFiles, projectFileRead } from './projects.js';
import { liveBriefing } from './briefing.js';
import { groupDecisions } from './group-decisions.js';
import { overnightStatus } from './overnight-status.js';
import * as lqcTools from './lqcouncil.js';
import { moorsteadStatus, moorsteadBroadcast, moorsteadKick, moorsteadBairnsStatus, moorsteadBairnsSet, moorsteadOps, moorsteadOpsConfirm } from './moorstead.js';
import { moorsteadCodeStage, moorsteadCodeConfirm } from './moorstead-code.js';
import { steadsStatus, steadsMint, steadsRevoke, steadsRevokeConfirm, steadsMute } from './steads.js';
import { spirePresence, spireFeedback, spireHealth } from './spire.js';
// Phase 5: overnight-report.js retired. The overnight_report tool now
// reads from the new morning-report.ts in src/overnight/.
// Phase 5: evolution.js retired. The evolution_task tool now writes
// a proposal-card file to data/overnight/proposals/ instead of queuing
// into the old evolution system. The IMPROVE stage and its deploy step
// surface proposals in the morning report.
import { setGroupConfig, findGroupByLabel, addBlockedTopics, getRegisteredGroups, getGroupMode, getGroupConfig } from '../group-registry.js';
import { broadcastSSE, getSSEClientCount } from '../sse.js';
import { logAudit } from '../audit.js';
import { getRoutingStats } from '../router-telemetry.js';
import { describeCapabilities, getForgeHistory } from '../skill-registry.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../logger.js';

// --- Prefetch-aware web search ---
async function webSearch(input) {
  const cached = getWebPrefetch(input.query);
  if (cached) { logger.info({ query: input.query }, 'web_search served from cortex prefetch'); return cached; }
  return _rawWebSearch(input);
}

// --- Inline tool handlers (too small for own files) ---

async function memorySearchHandler(input) {
  const results = await searchMemory(input.query, input.category, 8);
  if (results.length === 0) return 'No relevant memories found.';
  return results.map(r => {
    const m = r.memory;
    return `- ${m.fact} [${m.category}, ${m.sourceDate}, confidence: ${m.confidence}] (id: ${m.id})`;
  }).join('\n');
}

async function memoryUpdateHandler(input) {
  const result = await updateMemory(input.memory_id, { fact: input.fact, category: input.category, tags: input.tags });
  if (result.updated) return `Memory updated: "${result.memory.fact}"`;
  if (result.offline) return 'Memory service is offline — correction noted, will apply when back online.';
  return `Failed to update memory: ${result.error || 'not found'}`;
}

async function memoryDeleteHandler(input) {
  const result = await deleteMemory(input.memory_id);
  if (result.deleted) return 'Memory deleted.';
  if (result.offline) return 'Memory service is offline — will delete when back online.';
  return `Failed to delete memory: ${result.error || 'not found'}`;
}

async function systemStatusHandler() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  let evoStatus = 'unknown';
  try {
    const { checkLlamaHealth } = await import('../evo-client.js');
    evoStatus = await checkLlamaHealth() ? 'online (llama-server responding)' : 'offline';
  } catch { /* intentional: health check failure is not an error */ }

  const waConnected = globalThis._clawdWhatsAppConnected || false;
  let voiceStatus = 'no heartbeat received';
  if (_lastVoiceHeartbeat) {
    const ageSec = Math.round((Date.now() - _lastVoiceHeartbeat.receivedAt) / 1000);
    if (ageSec < 90) {
      const vH = Math.floor((_lastVoiceHeartbeat.uptime || 0) / 3600);
      const vM = Math.floor(((_lastVoiceHeartbeat.uptime || 0) % 3600) / 60);
      voiceStatus = `online (${vH}h ${vM}m), Whisper ${_lastVoiceHeartbeat.whisper_model || 'unknown'}, noise suppression ${_lastVoiceHeartbeat.noise_suppression ? 'on' : 'off'}`;
    } else {
      voiceStatus = `last heartbeat ${ageSec}s ago — possibly offline`;
    }
  }

  const routerStats = getRoutingStats();
  const routerLine = routerStats.total > 0
    ? `${routerStats.local} local, ${routerStats.cloud} cloud, ${routerStats.fallback} fallbacks (${routerStats.total} total today)`
    : 'no messages routed today';
  const forgeHistory = getForgeHistory();
  const skillsLine = forgeHistory.length > 0 ? forgeHistory.map(s => `${s.name} (v${s.version || '?'})`).join(', ') : 'none yet';
  const activeSkills = describeCapabilities();

  return [
    `**EVO X2 (clint runtime)**: Running ${hours}h ${mins}m, ${(mem.rss / 1048576).toFixed(0)}MB RSS`,
    `**WhatsApp**: ${waConnected ? 'Connected' : 'Disconnected'}`,
    `**EVO X2**: ${evoStatus}`,
    `**Voice listener**: ${voiceStatus}`,
    `**Dashboard**: ${getSSEClientCount()} SSE client(s) connected`,
    `**Models**: Claude ${config.claudeModel} (cloud), ${config.evoMainModelLabel}, ${config.evoClassifierLabel}`,
    `**Routing today**: ${routerLine}`,
    `**Learned skills**: ${skillsLine}`,
    activeSkills !== 'No forge-authored skills installed.' ? activeSkills : '',
  ].filter(Boolean).join('\n');
}

async function sendFileHandler(input) {
  if (!_sendDocument) return 'Document send function not available — WhatsApp not connected.';
  const safeFilename = (input.filename || '').replace(/[\/\\]/g, '');
  if (!safeFilename) return 'No filename provided.';
  const filePath = join('data', safeFilename);
  if (!existsSync(filePath)) return `File not found: data/${safeFilename}`;
  try {
    const buffer = readFileSync(filePath);
    const ext = safeFilename.split('.').pop().toLowerCase();
    const mimeMap = { pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    await _sendDocument(buffer, safeFilename, mimeMap[ext] || 'application/octet-stream', input.caption || '');
    return `Sent ${safeFilename} (${(buffer.length / 1024).toFixed(1)} KB)`;
  } catch (err) {
    logger.error({ err: err.message, file: safeFilename }, 'send_file failed');
    return `Failed to send file: ${err.message}`;
  }
}

// --- Tool registry (dispatch map) ---

const TOOL_MAP = new Map([
  ['calendar_list_events', calendarListEvents],
  ['calendar_create_event', calendarCreateEvent],
  ['calendar_update_event', calendarUpdateEvent],
  ['calendar_find_free_time', calendarFindFreeTime],
  ['gmail_search', gmailSearch],
  ['gmail_read', gmailRead],
  ['gmail_draft', gmailDraft],
  ['gmail_confirm_send', gmailConfirmSend],
  ['train_departures', trainDepartures],
  ['train_fares', trainFares],
  ['hotel_search', hotelSearch],
  ['search_trains', searchTrains],
  ['search_accommodation', searchAccommodation],
  ['web_search', webSearch],
  ['web_fetch', webFetch],
  ['soul_read', soulRead],
  ['soul_learn', soulLearn],
  ['soul_forget', soulForget],
  ['soul_propose', soulPropose],
  ['soul_confirm', soulConfirm],
  ['todo_add', todoAdd],
  ['todo_list', todoList],
  ['todo_complete', todoComplete],
  ['todo_remove', todoRemove],
  ['todo_update', todoUpdate],
  ['memory_search', memorySearchHandler],
  ['memory_update', memoryUpdateHandler],
  ['memory_delete', memoryDeleteHandler],
  ['live_briefing', liveBriefing],
  ['group_decisions', groupDecisions],
  ['overnight_status', overnightStatus],
  ['system_status', systemStatusHandler],
  ['project_list', projectList],
  ['project_read', projectRead],
  ['project_pitch', projectPitch],
  ['project_update', projectUpdate],
  ['project_list_files', projectListFiles],
  ['project_file_read', projectFileRead],
  ['sovren_site_access', sovrenSiteAccess],
  ['group_mode', async () => 'Done.'],
  ['group_block', async () => 'Done.'],
  ['group_status', async () => 'Done.'],
  ['group_project', async () => 'Done.'],
  ['overnight_report', async (input) => {
    if (!_sendWhatsApp) return 'WhatsApp send function not available — cannot deliver report.';
    try {
      const { buildAndRenderReport } = await import('../overnight/report.js');
      const { dirname, join, resolve } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(moduleDir, '..', '..');
      const overnightDir = join(repoRoot, 'data', 'overnight');
      const date = input.date || new Date().toISOString().slice(0, 10);
      const { text } = await buildAndRenderReport({ date, overnightDir });
      await _sendWhatsApp(text);
      return `Overnight report for ${date} generated and sent.`;
    } catch (err) {
      return `Failed to generate overnight report: ${err.message}`;
    }
  }],
  ['send_file', sendFileHandler],
  ['evolution_task', async () => 'Evolution tasks require DM confirmation. This should not have been called directly.'],

  // Moorstead admin — owner only (gated in claude.js OWNER_ONLY_TOOLS)
  ['moorstead_status', moorsteadStatus],
  ['moorstead_broadcast', moorsteadBroadcast],
  ['moorstead_kick', moorsteadKick],
  ['moorstead_bairns_status', moorsteadBairnsStatus],
  ['moorstead_bairns_set', moorsteadBairnsSet],
  ['moorstead_ops', moorsteadOps],
  ['moorstead_ops_confirm', moorsteadOpsConfirm],
  ['moorstead_code', moorsteadCodeStage],
  ['moorstead_code_confirm', moorsteadCodeConfirm],
  ['steads_status', steadsStatus],
  ['steads_mint', steadsMint],
  ['steads_revoke', steadsRevoke],
  ['steads_revoke_confirm', steadsRevokeConfirm],
  ['steads_mute', steadsMute],
  ['spire_presence', spirePresence],
  ['spire_feedback', spireFeedback],
  ['spire_health', spireHealth],

  // LQ Bot Council — read-only tools gated to LQC_DEV_GROUP_JID / owner DM
  // in group-tool-policy.js. Wiring live here so the dispatch table is
  // a single source of truth for all tools.
  ['lqc_status', lqcTools.lqcStatus],
  ['lqc_list_debates', lqcTools.lqcListDebates],
  ['lqc_debate_detail', lqcTools.lqcDebateDetail],
  ['lqc_list_bots', lqcTools.lqcListBots],
  ['lqc_bot_schema', lqcTools.lqcBotSchema],
  ['lqc_validate_bot', lqcTools.lqcValidateBot],
  ['lqc_bot_diagnose', lqcTools.lqcBotDiagnose],
  ['lqc_bot_author_guide', lqcTools.lqcBotAuthorGuide],
  ['lqc_onboarding_checklist', lqcTools.lqcOnboardingChecklist],
  ['lqc_self_describe', lqcTools.lqcSelfDescribe],
  ['lqc_knowledge', lqcTools.lqcKnowledge],
  ['lqc_dry_run_debate', lqcTools.lqcDryRunDebate],
  ['lqc_why_failed', lqcTools.lqcWhyFailed],
  ['lqc_recent_errors', lqcTools.lqcRecentErrors],
  ['lqc_start_debate', lqcTools.lqcStartDebate],
  ['lqc_confirm_debate', lqcTools.lqcConfirmDebate],
  ['lqc_live_llm', lqcTools.lqcLiveLlm],
  ['lqc_archive_debate', lqcTools.lqcArchiveDebate],
  ['lqc_delete_debate', lqcTools.lqcDeleteDebate],
  ['lqc_debate_summary', lqcTools.lqcDebateSummary],
  ['lqc_failing_bots', lqcTools.lqcFailingBots],
  ['lqc_full_smoke_test', lqcTools.lqcFullSmokeTest],
]);

const TODO_MUTATION_TOOLS = new Set(['todo_add', 'todo_complete', 'todo_remove', 'todo_update']);

// --- State (injected by index.js) ---

let _lastVoiceHeartbeat = null;
let _sendWhatsApp = null;
let _sendDocument = null;
let _sendOwnerDM = null;
const _pendingEvolution = new Map();

export function recordVoiceHeartbeat(data) { _lastVoiceHeartbeat = { ...data, receivedAt: Date.now() }; }
export function setSendWhatsApp(fn) { _sendWhatsApp = fn; }
export function setSendDocument(fn) { _sendDocument = fn; }
export function getSendDocument() { return _sendDocument; }
export function setSendOwnerDM(fn) { _sendOwnerDM = fn; }

export async function confirmEvolutionTask(confirmId) {
  const pending = _pendingEvolution.get(confirmId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) { _pendingEvolution.delete(confirmId); return null; }
  _pendingEvolution.delete(confirmId);

  // Phase 5: write a proposal card for the new IMPROVE stage to pick up
  // at its next scheduled run. No direct task queue anymore.
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { join, dirname, resolve } = await import('path');
    const { fileURLToPath } = await import('url');
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(moduleDir, '..', '..');
    const proposalsDir = join(repoRoot, 'data', 'overnight', 'proposals');
    await mkdir(proposalsDir, { recursive: true });
    const filename = `whatsapp-request-${Date.now()}.json`;
    const payload = {
      source: 'whatsapp',
      priority: pending.priority,
      instruction: pending.instruction,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(proposalsDir, filename), JSON.stringify(payload, null, 2), 'utf8');
    return { proposalFile: filename };
  } catch (err) {
    return { error: err.message };
  }
}

// --- Owner check ---

function isOwnerSender(senderJid) {
  if (!senderJid) return false;
  const ownerJids = new Set();
  if (config.ownerJid) ownerJids.add(config.ownerJid);
  if (config.ownerLid) ownerJids.add(config.ownerLid);
  return ownerJids.has(senderJid);
}

// --- Security gates (soul, evolution, groups) ---

function handleSoulGates(toolName, toolInput, isGroup, senderJid, handler) {
  if (toolName === 'soul_learn' && isGroup && _sendOwnerDM) {
    return async () => {
      const proposal = await soulPropose({ section: toolInput.section, content: toolInput.text, reason: 'learned from group conversation' });
      await _sendOwnerDM(`*Soul update proposed (from group):*\n\n${proposal}\n\nReply "confirm soul" to apply, or ignore to reject.`);
      return 'Proposal sent to James via DM for review. Soul changes require owner confirmation.';
    };
  }
  if (toolName === 'soul_forget' && isGroup && _sendOwnerDM) {
    return async () => {
      await _sendOwnerDM(`*Soul deletion requested (from group):*\n\nSection: ${toolInput.section}, Entry #${toolInput.index}\n\nReply "forget soul ${toolInput.section} ${toolInput.index}" in DM to confirm.`);
      return 'Deletion request sent to James via DM for review. Soul changes require owner confirmation.';
    };
  }
  if (toolName === 'soul_propose' && isGroup && _sendOwnerDM) {
    return async () => {
      const result = await handler(toolInput);
      await _sendOwnerDM(`*Soul update proposed (from group):*\n\n${result}\n\nReply "confirm soul" to apply, or ignore to reject.`);
      return 'Proposal sent to James via DM for review. Soul changes require owner confirmation.';
    };
  }
  if (toolName === 'soul_confirm' && isGroup) {
    return async () => 'Soul confirmations must happen in DM with James, not in group chats.';
  }
  return null;
}

async function handleEvolutionGate(toolInput, senderJid) {
  if (!isOwnerSender(senderJid)) {
    logger.warn({ senderJid, tool: 'evolution_task' }, 'evolution_task blocked: non-owner');
    return 'Evolution tasks can only be created by James. This request has been blocked.';
  }
  const { randomBytes: rb } = await import('crypto');
  const confirmId = rb(4).toString('hex');
  _pendingEvolution.set(confirmId, { instruction: toolInput.instruction, priority: toolInput.priority || 'normal', expiresAt: Date.now() + 10 * 60 * 1000 });
  if (_sendOwnerDM) {
    await _sendOwnerDM(`*EVOLUTION TASK — Confirm to queue*\n\nInstruction: ${toolInput.instruction}\nPriority: ${toolInput.priority || 'normal'}\n\nReply "confirm evolution ${confirmId}" to approve.\nExpires in 10 minutes. Ignoring = rejected.`);
  }
  logger.info({ confirmId, instruction: toolInput.instruction.slice(0, 100) }, 'evolution_task: awaiting DM confirmation');
  return 'Evolution task sent to James via DM for confirmation. It will only be queued after explicit approval.';
}

function handleGroupSecurityTools(toolName, toolInput, senderJid, chatJid, isGroup) {
  if (toolName === 'group_mode') {
    if (!isOwnerSender(senderJid)) return 'Only James can set group modes.';
    if (!isGroup) return 'This tool only works in group chats.';
    const mode = (toolInput.mode || '').toLowerCase();
    if (!['open', 'project', 'colleague'].includes(mode)) return 'Invalid mode. Use: open, project, or colleague.';
    setGroupConfig(chatJid, { mode, ...(toolInput.label ? { label: toolInput.label } : {}) });
    return 'Done.';
  }
  if (toolName === 'group_block') {
    if (!isOwnerSender(senderJid)) return 'Only James can manage group restrictions.';
    if (!toolInput.group_label || !toolInput.topics?.length) return 'Need a group label and at least one topic.';
    const match = findGroupByLabel(toolInput.group_label);
    if (!match) return `No registered group matching "${toolInput.group_label}".`;
    const added = addBlockedTopics(match.jid, toolInput.topics);
    return added.length === 0 ? 'Those topics are already blocked in that group.' : 'Done.';
  }
  if (toolName === 'group_status') {
    if (!isGroup) {
      const groups = getRegisteredGroups();
      if (groups.length === 0) return 'No groups registered. Unregistered groups default to colleague mode.';
      return groups.map((g) => {
        const blocked = g.blockedTopics.length > 0 ? `\n  Blocked: ${g.blockedTopics.join(', ')}` : '';
        const projects = g.allowedProjects.length > 0 ? `\n  Projects: ${g.allowedProjects.join(', ')} (${g.projectScopeMode || 'allow_list'})` : '';
        return `*${g.label || 'Unnamed'}* — ${g.mode} mode${blocked}${projects}`;
      }).join('\n\n') + '\n\nUnregistered groups default to colleague mode.';
    }
    return isOwnerSender(senderJid) ? `${getGroupMode(chatJid)} mode active.` : 'Security is active.';
  }
  if (toolName === 'group_project') {
    if (!isOwnerSender(senderJid)) return 'Only James can configure group project access.';
    if (!isGroup) return 'This tool only works in group chats.';
    const projectId = String(toolInput.project_id || '').trim().toLowerCase();
    if (!projectId) return 'project_id is required.';
    const scopeMode = toolInput.scope_mode || 'allow_list';
    if (!['allow_list', 'single_project_only'].includes(scopeMode)) {
      return 'Invalid scope_mode. Use allow_list or single_project_only.';
    }
    const offTopicPolicy = toolInput.offtopic_policy
      || (scopeMode === 'single_project_only' ? 'soft_redirect' : 'allow');
    if (!['allow', 'soft_redirect'].includes(offTopicPolicy)) {
      return 'Invalid offtopic_policy. Use allow or soft_redirect.';
    }
    const existingMode = getGroupConfig(chatJid)?.mode || 'colleague';
    const effectiveMode = existingMode === 'colleague' ? 'project' : existingMode;
    setGroupConfig(chatJid, {
      ...(toolInput.label ? { label: toolInput.label } : {}),
      mode: effectiveMode,
      allowedProjects: [projectId],
      projectScopeMode: scopeMode,
      offTopicPolicy: offTopicPolicy,
    });
    return 'Done.';
  }
  return null;
}

// --- Main entry point ---

export async function executeTool(toolName, toolInput, senderJid, chatJid) {
  const handler = TOOL_MAP.get(toolName);
  if (!handler) return `Unknown tool: ${toolName}`;

  const isGroup = chatJid && chatJid.endsWith('@g.us');

  // Evolution gate
  if (toolName === 'evolution_task') return handleEvolutionGate(toolInput, senderJid);

  // Soul gates
  const soulGate = handleSoulGates(toolName, toolInput, isGroup, senderJid, handler);
  if (soulGate) return soulGate();

  // Group security tools
  const groupResult = handleGroupSecurityTools(toolName, toolInput, senderJid, chatJid, isGroup);
  if (groupResult) return groupResult;

  try {
    const result = await handler(toolInput);
    logAudit({ tool: toolName, sender: senderJid || 'dashboard', input: JSON.stringify(toolInput).slice(0, 200), resultLength: result.length, success: true }).catch(() => { /* intentional: audit is best-effort */ });
    if (TODO_MUTATION_TOOLS.has(toolName)) broadcastSSE('todos', { todos: getAllTodos() });
    return result;
  } catch (err) {
    logAudit({ tool: toolName, sender: senderJid || 'dashboard', input: JSON.stringify(toolInput).slice(0, 200), error: err.message, success: false }).catch(() => { /* intentional: audit is best-effort */ });
    logger.error({ tool: toolName, err: err.message, sender: senderJid }, 'tool error');
    return `Tool error (${toolName}): ${err.message}`;
  }
}
