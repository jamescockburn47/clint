/** Executable private-owner authority, independent of conversation presentation. */
export const TASK_NAMES = new Set(['task_save', 'task_list', 'task_read', 'task_set_status']);
export const SLACK_READS = new Set(['web_search', 'web_fetch', 'knowledge_search', 'knowledge_read',
  'knowledge_status', 'repository_status', 'system_status', 'proactive_status', 'proactive_report',
  'soul_read', 'google_read_status', 'calendar_list_calendars', 'calendar_read_events', 'drive_search', 'drive_read',
  // Games status: GET requests to services on this host. Nothing here mints, revokes, broadcasts or kicks.
  'steads_status', 'moorstead_status', 'spire_health',
  // Free time computed from Calendar events read in full. Permission is that of the other Google reads.
  'calendar_free_time',
  // Why a message got no answer: times and fixed reasons from Clint's own inbox, no message text.
  'admission_log',
  // v43: remote MCP servers, unguarded by the owner's decision of 29 Sep 2026 (see src/slack/mcp-tools.js).
  'mcp_list_tools', 'mcp_call']);

/** Status of the owner's games. For the owner, in his private channel, and nowhere else. */
export const GAMES_READS = new Set(['steads_status', 'moorstead_status', 'spire_health']);
/** Every read that is for the owner in his private channel and nowhere else. */
export const PRIVATE_READS = new Set([...GAMES_READS, 'admission_log', 'mcp_list_tools', 'mcp_call']);
export const gamesReadsAllowed = scope => !scope || scope.transport !== 'slack' ||
  (scope.audience === 'group' && !!scope.localOnly && !!scope.isOwner && !!scope.privateContext && !scope.webOnly &&
    !scope.readOnly && !scope.policy.workspaceShared && scope.policy.mode === 'open');

export function ownerActionsAllowed(scope) {
  return scope?.transport === 'slack' && scope.audience === 'group' && scope.localOnly &&
    !!scope.isOwner && scope.privateContext && !scope.readOnly && !scope.webOnly &&
    !scope.policy.workspaceShared && scope.policy.mode === 'open' && !!scope.requestId &&
    !!scope.taskStorePath;
}

/** The legacy planner has no durable/cancellable execution contract. */
export function legacyPlannerAllowed(scope) {
  return scope?.transport !== 'slack';
}
