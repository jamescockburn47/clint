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
  return result?.ok === true && user?.id === event.owner && user.team_id === config.teamId &&
    user.deleted === false && user.is_bot === false && user.is_app_user !== true && user.is_stranger !== true;
}
