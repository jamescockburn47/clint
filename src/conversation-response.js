import config from './config.js';
import { getGroupConfig } from './group-registry.js';
import { createConversationContext, withConversationContext } from './conversation-context.js';
import { filterResponse, getBlockedResponse } from './output-filter.js';

/** Wrap every normal/planner result in the same scoped authority and outbound policy. */
export function scopedResponse({ senderJid, chatJid, options }, generate) {
  let scope = options.conversation;
  if (!scope) {
    const knownOwner = [config.ownerJid, config.ownerLid].find(id => id && id === senderJid) || '';
    const group = typeof chatJid === 'string' && chatJid.endsWith('@g.us');
    const direct = typeof chatJid === 'string' && /@(s\.whatsapp\.net|lid)$/.test(chatJid);
    scope = createConversationContext({ transport: group || direct ? 'whatsapp' : 'venue',
      conversationId: chatJid || 'unknown', actorId: senderJid || '', ownerId: knownOwner,
      audience: group ? 'group' : direct ? 'direct' : 'unknown',
      policy: getGroupConfig(chatJid) || {}, forceRestricted: options.forceRestricted,
      webOnly: options.spireSafe });
  }
  return withConversationContext(scope, async () => {
    if (scope.actorId !== (senderJid || '') || scope.conversationId !== (chatJid || 'unknown')) {
      throw new Error('conversation_identity_mismatch');
    }
    const result = await generate();
    if (!result?.text) return result;
    const checked = filterResponse(result.text, scope.conversationId);
    return checked.safe ? result : { ...result,
      text: getBlockedResponse(checked.reason), meta: { ...result.meta, outputBlocked: true } };
  });
}
