/** Operator-configured channels; event/model text never grants a new audience. */
export function channelConfigs(config) {
  const channels = [config];
  if (config.publicChannelId) channels.push(Object.freeze({ ...config,
    channelId: config.publicChannelId, workspaceShared: true, proactiveEnabled: false,
    policy: Object.freeze({ mode: 'open', blockedTopics: [], allowedProjects: [], workspaceShared: true,
      researchScope: JSON.stringify([config.teamId, config.channelId, config.ownerId]) }) }));
  // Third-party agent lane: shared-channel admission, but web-only scope and no research or archive audience.
  if (config.peerChannelId && config.peerAppId) channels.push(Object.freeze({ ...config,
    channelId: config.peerChannelId, workspaceShared: true, peerLane: true, proactiveEnabled: false, papersEnabled: false,
    policy: Object.freeze({ mode: 'open', blockedTopics: [], allowedProjects: [], workspaceShared: true, peerLane: true }) }));
  return channels;
}

export function matchesEvent(event, config) {
  return !!config && event.team === config.teamId && event.channel === config.channelId &&
    typeof event.owner === 'string' && /^[UW][A-Z0-9]+$/.test(event.owner) &&
    event.owner !== config.botUserId && (config.workspaceShared === true || event.owner === config.ownerId) &&
    // Stored lane rows carry a marker: they run under the lane definition or not at all, and nothing else runs under it.
    (typeof event.id === 'string' && event.id.startsWith('lane:')) === (config.peerLane === true);
}

/** Confirm current membership, not a username or claim from a message. */
export async function authorizeActor(web, config, event) {
  if (!matchesEvent(event, config)) return false;
  if (!config.workspaceShared) return true;
  const result = await web.users.info({ user: event.owner });
  const user = result?.user;
  // The lane's only admissible bot is the configured peer app's own bot user, confirmed by Slack, never by message text.
  if (config.peerLane === true && user?.is_bot === true) {
    return result?.ok === true && user.id === event.owner && user.deleted === false && user.is_stranger !== true &&
      user.team_id === config.teamId && typeof config.peerAppId === 'string' && user.profile?.api_app_id === config.peerAppId;
  }
  if (result?.ok !== true || user?.id !== event.owner || user.deleted === true ||
      user.is_bot !== false || user.is_app_user === true || user.is_stranger === true ||
      !/^T[A-Z0-9]+$/.test(user.team_id || '')) return false;
  if (user.team_id === config.teamId) return user.deleted === false;
  if (config.peerLane === true) return false; // The lane is local: no Slack Connect participants.
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
