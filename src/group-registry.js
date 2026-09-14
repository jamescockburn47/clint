// src/group-registry.js — Per-group security modes and content restrictions
// Maps WhatsApp group JIDs to modes (open/project/colleague) and optional blocked topics.
// Data lives in data/group-registry.json, hot-reloaded every 5 minutes.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import logger from './logger.js';
import { runtimePath } from './overnight/paths.js';
import { currentPolicy } from './conversation-context.js';

// Resolves to data/runtime/group-registry.json, seeded from
// data/runtime-defaults/group-registry.json on fresh clones.
// Spec §6.1 P1.
const REGISTRY_FILE = runtimePath('group-registry.json');
const RELOAD_INTERVAL_MS = 300_000; // 5 minutes

let registry = { groups: {} };
let lastLoadedAt = 0;

// ── MODE DEFINITIONS ─────────────────────────────────────────────────────────
// Three modes. Simple. Each defines what's blocked at prompt level.
// The output filter provides a hard code-level safety net on top.

const MODES = {
  open: {
    description: 'No restrictions. Full access, like a DM.',
    restrictions: '',
  },
  project: {
    description: 'Block personal admin + personal life. Side projects allowed unless individually blocked.',
    restrictions:
      `Personal admin tools (calendar, email, todos, travel) are NOT available in this group. ` +
      `Do NOT mention James's personal life: family, children, partner, personal schedule, travel plans, home location, or domestic matters. ` +
      `If asked about personal matters, say those are private.`,
  },
  colleague: {
    description: 'Block personal admin + personal life + ALL side projects. Architecture/capabilities open.',
    restrictions:
      `Personal admin tools (calendar, email, todos, travel) are NOT available in this group. ` +
      `Do NOT mention James's personal life: family, children, partner, personal schedule, travel plans, home location, or domestic matters. ` +
      `Do NOT mention ANY of James's side projects, ventures, or business activities outside his role at Harcus Parker. ` +
      `This includes any project names, product names, startup names, or consultancy work. ` +
      `If asked, say you cannot discuss those topics here. Do not confirm or deny their existence. ` +
      `You CAN discuss your own architecture, capabilities, how you work, and AI/legal topics freely.`,
  },
};

// ── REGISTRY I/O ───────────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (!existsSync(REGISTRY_FILE)) return;
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    registry = data;
    lastLoadedAt = Date.now();
    const count = Object.keys(registry.groups || {}).length;
    if (count > 0) {
      logger.info({ count }, 'group-registry loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'group-registry: failed to load');
  }
}

function ensureLoaded() {
  if (Date.now() - lastLoadedAt > RELOAD_INTERVAL_MS) loadRegistry();
}

function saveRegistry() {
  try {
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    lastLoadedAt = Date.now();
  } catch (err) {
    logger.error({ err: err.message }, 'group-registry: failed to save');
    throw err;
  }
}

// Initial load
loadRegistry();

// ── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * Get the config for a specific group. Returns null if not registered.
 */
export function getGroupConfig(chatJid) {
  const scoped = currentPolicy(chatJid);
  if (scoped) return scoped;
  ensureLoaded();
  if (!chatJid || !registry.groups) return null;
  return registry.groups[chatJid] || null;
}

/**
 * Get the group label (human-readable name) or null.
 */
export function getGroupLabel(chatJid) {
  const config = getGroupConfig(chatJid);
  return config?.label || null;
}

/**
 * Get the mode for a group. Defaults to 'colleague' for unregistered groups.
 * Colleague is the safe default — blocks side projects and personal life.
 */
export function getGroupMode(chatJid) {
  const config = getGroupConfig(chatJid);
  return config?.mode || 'colleague';
}

/**
 * Get mode metadata.
 */
export function getModeInfo(mode) {
  return MODES[mode] || MODES.colleague;
}

/**
 * Build a restriction prompt fragment for a group based on its mode.
 * Returns empty string for open mode with no blocked topics.
 */
export function getGroupRestrictions(chatJid) {
  const config = getGroupConfig(chatJid);
  const mode = config?.mode || 'colleague';

  const parts = [];

  // Mode restrictions
  const modeDef = MODES[mode];
  if (modeDef && modeDef.restrictions) {
    parts.push(
      `## GROUP MODE: ${mode.toUpperCase()}\n` +
      modeDef.restrictions
    );
  }

  // Additional blocked topics (optional per-group extras on top of the mode)
  if (config?.blockedTopics && config.blockedTopics.length > 0) {
    const topicList = config.blockedTopics.map(t => `- ${t}`).join('\n');
    parts.push(
      `## ADDITIONAL BLOCKED TOPICS\n` +
      `The following topics are CONFIDENTIAL and must NOT be mentioned, referenced, or discussed in this group:\n` +
      `${topicList}\n` +
      `If asked about any of these, say you cannot discuss them. Do not confirm or deny their existence.`
    );
  }

  // Optional project scoping layer (thin overlay, does not replace mode rules)
  if (Array.isArray(config?.allowedProjects) && config.allowedProjects.length > 0) {
    const allowedList = config.allowedProjects.map((id) => `- ${id}`).join('\n');
    const scopeMode = config.projectScopeMode || 'allow_list';
    const offTopicPolicy = config.offTopicPolicy || 'allow';
    parts.push(
      `## PROJECT ACCESS\n` +
      `This group can discuss ONLY these project(s):\n${allowedList}\n` +
      `Project scope mode: ${scopeMode}\n` +
      `Off-topic policy: ${offTopicPolicy}\n` +
      (scopeMode === 'single_project_only'
        ? 'If asked about unrelated topics, give a brief redirect back to the allowed project.'
        : 'Prioritise allowed project knowledge over general memories when relevant.')
    );
  }

  if (parts.length === 0) return '';
  return '\n\n' + parts.join('\n\n');
}

/**
 * Get all registered group JIDs (for diagnostics).
 */
export function getRegisteredGroups() {
  ensureLoaded();
  return Object.entries(registry.groups || {}).map(([jid, config]) => ({
    jid,
    label: config.label,
    mode: config.mode || 'colleague',
    blockedTopics: config.blockedTopics || [],
    allowedProjects: config.allowedProjects || [],
    projectScopeMode: config.projectScopeMode || null,
    offTopicPolicy: config.offTopicPolicy || null,
  }));
}

/**
 * Find the first group bound to a specific project id via allowedProjects.
 * Returns the JID or null. Used by the LQC monitor to resolve alert
 * destinations without relying on a hardcoded env var.
 */
export function findGroupJidByProject(projectId) {
  ensureLoaded();
  if (!projectId || !registry.groups) return null;
  for (const [jid, cfg] of Object.entries(registry.groups)) {
    if (Array.isArray(cfg.allowedProjects) && cfg.allowedProjects.includes(projectId)) {
      return jid;
    }
  }
  return null;
}

/**
 * Find a group by label (case-insensitive partial match).
 * Returns { jid, config } or null.
 */
export function findGroupByLabel(label) {
  ensureLoaded();
  if (!label || !registry.groups) return null;
  const lower = label.toLowerCase();
  for (const [jid, config] of Object.entries(registry.groups)) {
    if (config.label && config.label.toLowerCase().includes(lower)) {
      return { jid, config };
    }
  }
  return null;
}

/**
 * Set or update config for a group. Persists immediately.
 */
export function setGroupConfig(chatJid, config) {
  ensureLoaded();
  if (!registry.groups) registry.groups = {};
  const existing = registry.groups[chatJid] || {};
  registry.groups[chatJid] = { ...existing, ...config };
  saveRegistry();
  logger.info({ chatJid, label: registry.groups[chatJid].label, mode: registry.groups[chatJid].mode }, 'group-registry: config updated');
}

/**
 * Add blocked topics to a group. Deduplicates.
 */
export function addBlockedTopics(chatJid, topics) {
  ensureLoaded();
  if (!registry.groups) registry.groups = {};
  const existing = registry.groups[chatJid] || {};
  const current = new Set((existing.blockedTopics || []).map(t => t.toLowerCase()));
  const added = [];
  for (const topic of topics) {
    if (!current.has(topic.toLowerCase())) {
      current.add(topic.toLowerCase());
      added.push(topic);
    }
  }
  existing.blockedTopics = [...(existing.blockedTopics || []), ...added];
  registry.groups[chatJid] = existing;
  saveRegistry();
  return added;
}

/**
 * Remove a group from the registry. Persists immediately.
 */
export function removeGroupConfig(chatJid) {
  ensureLoaded();
  if (!registry.groups || !registry.groups[chatJid]) return false;
  delete registry.groups[chatJid];
  saveRegistry();
  logger.info({ chatJid }, 'group-registry: group removed');
  return true;
}

/**
 * Force reload (used by tests or admin).
 */
export function reloadGroupRegistry() {
  loadRegistry();
}

/**
 * Get all mode definitions (for help display).
 */
export function getAllModes() {
  return Object.entries(MODES).map(([name, def]) => ({
    name,
    description: def.description,
  }));
}
