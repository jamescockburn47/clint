/** Operator-configured channels; event/model text never grants a new audience. */
export function channelConfigs(config) {
  const channels = [config];
  if (config.publicChannelId) channels.push(Object.freeze({ ...config,
    channelId: config.publicChannelId, workspaceShared: true, proactiveEnabled: false,
    policy: Object.freeze({ mode: 'open', blockedTopics: [], allowedProjects: [], workspaceShared: true,
      researchScope: JSON.stringify([config.teamId, config.channelId, config.ownerId]) }) }));
  return channels;
}

export function matchesEvent(event, config) {
  return !!config && event.team === config.teamId && event.channel === config.channelId &&
    typeof event.owner === 'string' && /^[UW][A-Z0-9]+$/.test(event.owner) &&
    event.owner !== config.botUserId && (config.workspaceShared === true || event.owner === config.ownerId);
}

/** Confirm current membership, not a username or claim from a message. */
export async function authorizeActor(web, config, event) {
  if (!matchesEvent(event, config)) return false;
  if (!config.workspaceShared) return true;
  const result = await web.users.info({ user: event.owner });
  const user = result?.user;
  if (result?.ok !== true || user?.id !== event.owner || user.deleted === true ||
      user.is_bot !== false || user.is_app_user === true || user.is_stranger === true ||
      !/^T[A-Z0-9]+$/.test(user.team_id || '')) return false;
  if (user.team_id === config.teamId) return user.deleted === false;
  // Slack omits deleted for external user profiles; exact current membership is required below.
  // External identity alone is insufficient: require membership of this exact channel.
  // Rechecked by the worker before generation and delivery; never cache this grant.
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const members = await web.conversations.members({ channel: config.channelId, limit: 200,
      ...(cursor ? { cursor } : {}) });
    if (members?.ok !== true || !Array.isArray(members.members) ||
        !members.members.every(id => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id))) return false;
    if (members.members.includes(event.owner)) return true;
    cursor = members.response_metadata?.next_cursor;
    if (!cursor) return false;
    if (typeof cursor !== 'string' || seen.has(cursor)) return false;
    seen.add(cursor);
  }
  return false;
}
