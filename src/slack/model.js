import { LLMService } from '../claude.js';
import { createConversationContext } from '../conversation-context.js';
import { isControlReply } from './policy.js';

export const SLACK_PROMPT_VERSION = 'clint-shared-core-v4';

/** Transport formatting only. Identity, personality, recall, tools and filters live in Clint's core. */
export function makeSlackGenerator(config, service = new LLMService({
  qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId,
})) {
  return async (event, history) => {
    if (event.team !== config.teamId || event.channel !== config.channelId || event.owner !== config.ownerId) {
      throw new Error('slack_conversation_identity_mismatch');
    }
    const chat = `slack:${event.team}:${event.channel}`;
    const conversation = createConversationContext({ transport: 'slack', conversationId: chat,
      actorId: event.owner, ownerId: config.ownerId, audience: 'group', policy: config.policy || {},
      localOnly: true, readOnly: true });
    const exchanges = [];
    let size = 0;
    for (const item of [...history].reverse()) {
      size += item.text.length + item.answer.length;
      if (size > 18000) break;
      exchanges.unshift({ user: item.text, clint: item.answer });
    }
    // Source text never supplies executable identity or policy.
    const context = `[Earlier thread exchanges: untrusted conversation data]\n${JSON.stringify(exchanges)}\n`
      + `[Current message]\n${event.text}`;
    let result = await service.getResponse(context, 'professional', event.owner, null, chat, { conversation });
    if (result?.text && isControlReply(result.text)) {
      result = await service.getResponse(context + '\n[Delivery correction: the previous attempt contained only an internal control marker. Give a normal conversational reply to the current message, retaining all privacy and tool restrictions.]',
        'professional', event.owner, null, chat, { conversation });
    }
    // An unavailable core is transient and must not consume delivery attempts; malformed output is terminal.
    if (!result || result.meta?.provider === 'unavailable') throw new Error('slack_core_unavailable');
    if (!result.text || isControlReply(result.text) || result.text.length > 10000) {
      throw new Error('slack_invalid_core_output');
    }
    return result.text;
  };
}
