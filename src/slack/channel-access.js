import { allowedChannel } from './policy.js';

/** Private archive context requires James and this bot to be the ONLY channel members.
 * Pagination, missing metadata and API failure never imply a private audience.
 */
export async function authorizeChannel(web, config) {
  if (!allowedChannel(await web.conversations.info({ channel: config.channelId }), config)) return false;
  if (config.workspaceShared === true) return true; // Exact local public channel; actor checked separately.
  if (config.policy?.mode !== 'open') return true;
  if (!config.botUserId || config.botUserId === config.ownerId) return false;
  const result = await web.conversations.members({ channel: config.channelId, limit: 200 });
  const expected = new Set([config.ownerId, config.botUserId]);
  return result.ok === true && Array.isArray(result.members) && result.members.length === 2 &&
    new Set(result.members).size === 2 && result.members.every(id => expected.has(id)) &&
    !result.response_metadata?.next_cursor;
}
