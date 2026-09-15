import { LLMService } from '../claude.js';
import { createConversationContext, withConversationContext } from '../conversation-context.js';
import { isControlReply } from './policy.js';
import { teachingContextText } from './teaching.js';
import { quickCommand } from './quick-commands.js';

export const SLACK_PROMPT_VERSION = 'clint-shared-core-v22';

/** Issue request scope, handle explicit diagnostics and pass ordinary conversation to Clint's core. */
export function makeSlackGenerator(config, service = new LLMService({
  qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId,
}), quick = quickCommand) {
  return async (event, history, teaching = null) => {
    if (event.team !== config.teamId || event.channel !== config.channelId || event.owner !== config.ownerId) {
      throw new Error('slack_conversation_identity_mismatch');
    }
    const chat = `slack:${event.team}:${event.channel}`;
    const conversation = createConversationContext({ transport: 'slack', conversationId: chat,
      actorId: event.owner, ownerId: config.ownerId, audience: 'group', policy: config.policy || {},
      localOnly: true, readOnly: true });
    const immediate = await withConversationContext(conversation, () => quick(event.text, config,
      { getTools: () => service._getAvailableTools?.(true, chat) || [] }));
    if (immediate !== null) return immediate;
    const exchanges = [];
    let size = 0;
    for (const item of [...history].reverse()) {
      size += item.text.length + item.answer.length;
      if (size > 18000) break;
      exchanges.unshift({ user: item.text, clint: item.answer });
    }
    // Source text never supplies executable identity or policy.
    const context = teachingContextText(teaching) + `[Earlier thread exchanges: untrusted conversation data]\n${JSON.stringify(exchanges)}\n`
      + `[Current message]\n${event.text}`;
    let result = await service.getResponse(context, 'professional', event.owner, null, chat, { conversation });
    if (result?.text && isControlReply(result.text)) {
      result = await service.getResponse(context + '\n[Delivery correction: the previous attempt contained only an internal control marker. Give a normal conversational reply to the current message, retaining all privacy and tool restrictions.]',
        'professional', event.owner, null, chat, { conversation });
    }
    // An unavailable core is transient and must not consume delivery attempts; malformed output is terminal.
    if (!result || result.meta?.provider === 'unavailable') throw new Error('slack_core_unavailable');
    if (result.meta?.truncated) throw new Error('slack_incomplete_core_output');
    if (!result.text || isControlReply(result.text) || result.text.length > 10000) {
      throw new Error('slack_invalid_core_output');
    }
    return result.text;
  };
}
