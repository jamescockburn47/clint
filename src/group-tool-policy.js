import { getGroupConfig, getGroupLabel } from './group-registry.js';
import { isGroupConversation } from './conversation-context.js';
import { permitsTool } from './conversation-tools.js';

// Dev-group JID is read lazily via `process.env` instead of the
// frozen `config` singleton. The existing group-tool-policy test boots
// without ANTHROPIC_API_KEY in the environment, which would reject the
// Zod config; reading env directly keeps the test's invariant.
function devGroupJid() {
  return (process.env.LQC_DEV_GROUP_JID || '').trim();
}

/**
 * A chat is "LQcouncil-bound" when either:
 *   - it matches the legacy dev-group JID env var, or
 *   - its group-registry entry has `allowedProjects` including `lqcouncil`.
 * Either gives full access to `lqc_*` tools.
 */
function isLqcouncilBoundChat(chatJid) {
  if (!chatJid) return false;
  if (!isGroupConversation(chatJid)) return false;
  const dev = devGroupJid();
  if (dev && chatJid === dev) return true;
  const cfg = getGroupConfig(chatJid);
  return (
    Array.isArray(cfg?.allowedProjects) &&
    cfg.allowedProjects.includes('lqcouncil')
  );
}

const SOVREN_LABELS = new Set(['sovren']);

const NON_PERSONAL_GROUP_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'live_briefing',
  'memory_search',
  'memory_update',
  'memory_delete',
  'system_status',
  'project_list',
  'project_read',
  'project_pitch',
  'project_update',
  'project_list_files',
  'project_file_read',
  'overnight_status',
  'overnight_report',
  'send_file',
  'group_decisions',
  'group_status',
  'group_project',
  'group_block',
  'group_mode',
  'evolution_task',
  'sovren_site_access',
]);

/** LQ Council tool names — every tool name that starts with `lqc_` is
 *  gated to the dev group JID and owner DMs. Kept as a predicate rather
 *  than a set so new tools added later are automatically covered. */
function isLqcTool(name) {
  return typeof name === 'string' && name.startsWith('lqc_');
}

/** Strip LQC tools when the chat is not LQcouncil-bound. A chat is
 *  LQcouncil-bound when it matches the legacy dev-group JID OR its
 *  group-registry entry has `allowedProjects` including `lqcouncil`.
 *  Caller wraps in the existing SOVREN filter; this runs first so the
 *  restrictions compose. */
function stripLqcToolsForOtherChats(chatJid, tools) {
  const isGroup = isGroupConversation(chatJid);
  if (isGroup && isLqcouncilBoundChat(chatJid)) return tools;
  // Not a group (owner DM) — always allowed. The message processor
  // already restricts DM visibility to registered users.
  if (!isGroup) return tools;
  return tools.filter((tool) => !isLqcTool(tool.name));
}

export function filterToolsForChat(chatJid, tools) {
  // Strip LQC tools first (applies to any group that's not the dev JID).
  const base = stripLqcToolsForOtherChats(chatJid, tools).filter(tool => permitsTool(tool.name));
  if (!isGroupConversation(chatJid)) return base;
  const groupLabel = (getGroupLabel(chatJid) || '').trim().toLowerCase();
  const groupConfig = getGroupConfig(chatJid);
  if (!SOVREN_LABELS.has(groupLabel) || !groupConfig?.allowedProjects?.includes('sovren')) {
    return base;
  }
  return base.filter((tool) => NON_PERSONAL_GROUP_TOOL_NAMES.has(tool.name));
}
