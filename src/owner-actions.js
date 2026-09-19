/** Executable private-owner authority, independent of conversation presentation. */
export const TASK_NAMES = new Set(['task_save', 'task_list', 'task_read', 'task_set_status']);
export const SLACK_READS = new Set(['web_search', 'web_fetch', 'knowledge_search', 'knowledge_read',
  'knowledge_status', 'repository_status', 'system_status', 'proactive_status', 'proactive_report',
  'soul_read', 'google_read_status', 'calendar_list_calendars', 'calendar_read_events', 'drive_search', 'drive_read']);

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
