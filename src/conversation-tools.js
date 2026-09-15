import { currentConversation, permitsProject } from './conversation-context.js';
import { filterResponse } from './output-filter.js';
import { KNOWLEDGE_NAMES, knowledgeAllowed } from './knowledge/tools.js';
import { repositoryAllowed } from './knowledge/repository.js';
import { runtimeStatusAllowed } from './runtime-status.js';
import config from './config.js';
import { GOOGLE_READ_NAMES } from './tools/google-definitions.js';
import { outboundQuerySafe } from './outbound-query.js';
import { PROACTIVE_NAMES } from './slack/proactive-tools.js';

export const OWNER_ONLY_TOOLS = new Set(['gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send',
  'soul_propose', 'soul_confirm', 'soul_learn', 'soul_forget', 'calendar_create_event', 'calendar_update_event',
  'evolution_task', 'moorstead_status', 'moorstead_broadcast', 'moorstead_kick', 'moorstead_bairns_status',
  'moorstead_bairns_set', 'moorstead_ops', 'moorstead_ops_confirm', 'moorstead_code', 'moorstead_code_confirm',
  'steads_status', 'steads_mint', 'steads_revoke', 'steads_revoke_confirm', 'steads_mute']);
const PUBLIC_READS = new Set(['web_search', 'web_fetch', 'memory_search', 'project_list', 'project_read',
  'project_pitch', 'project_list_files', 'project_file_read', 'lqc_knowledge', 'lqc_status', 'sovren_site_access']);
const PROJECT_READS = new Set(['project_read', 'project_pitch', 'project_list_files', 'project_file_read']);
const READ_ONLY_TOOLS = new Set([...PUBLIC_READS, 'soul_read']);

/** One execution predicate shared by schema selection, ordinary calls and planner steps. */
export function permitsTool(name, input, scope = currentConversation(), core = config) {
  // Seeded project definitions have no verified freshness/provenance contract for Slack.
  if (scope?.transport === 'slack' && name.startsWith('project_')) return false;
  if (scope?.transport === 'slack' && name.startsWith('memory_') && !core.evoMemoryEnabled) return false;
  if (name === 'system_status' && scope?.transport === 'slack') return runtimeStatusAllowed(scope);
  if (name === 'repository_status') return repositoryAllowed(scope);
  if (KNOWLEDGE_NAMES.includes(name)) return knowledgeAllowed(scope);
  if (PROACTIVE_NAMES.includes(name)) return scope?.transport === 'slack' && knowledgeAllowed(scope);
  // Owner authorizes contextual web research; cloud synthesis and unrelated services remain excluded.
  if (knowledgeAllowed(scope) && ['live_briefing',
    'sovren_site_access', 'lqc_knowledge', 'lqc_status'].includes(name)) return false;
  if (GOOGLE_READ_NAMES.includes(name)) return knowledgeAllowed(scope);
  if (!scope) return true; // Legacy background jobs have a separate trusted invocation contract.
  if (scope.audience === 'unknown' || !scope.actorId) return false;
  if (input !== undefined && ['web_search', 'web_fetch'].includes(name)) {
    let text = name === 'web_search' ? String(input?.query || '') + '\n' + JSON.stringify(input?.include_domains ?? []) : String(input?.url || '');
    if (!outboundQuerySafe(text, core)) return false;
    try { text = decodeURIComponent(text); } catch { /* Plain search text may contain a literal percent. */ }
    if (!filterResponse(text, scope.conversationId).safe) return false;
  }
  if (scope.webOnly) return name === 'web_search' || name === 'web_fetch';
  if (scope.localOnly && ['live_briefing', 'sovren_site_access'].includes(name)) return false;
  if (scope.readOnly && !READ_ONLY_TOOLS.has(name)) return false;
  if (!scope.isOwner && (!PUBLIC_READS.has(name) || OWNER_ONLY_TOOLS.has(name))) return false;
  if (!scope.privateContext && !PUBLIC_READS.has(name)) return false;
  // Project authorization does not publish credentials/runtime files in its checkout.
  // Shared-channel file access awaits an explicit published-document boundary.
  if (scope.isGroup && ['project_file_read', 'project_list_files'].includes(name)) return false;
  if (!scope.privateContext && name === 'soul_read') return false;
  if (name.startsWith('lqc_') && scope.isGroup && !scope.policy.allowedProjects.includes('lqcouncil')) return false;
  if (name === 'sovren_site_access' && !scope.policy.allowedProjects.includes('sovren')) return false;
  if (PROJECT_READS.has(name) && input !== undefined && !permitsProject(input?.id)) return false;
  // Shared groups cannot change their own disclosure rules, even when the owner speaks there.
  if (['group_mode', 'group_block', 'group_project'].includes(name) && (scope.isGroup || !scope.isOwner)) return false;
  return true;
}
