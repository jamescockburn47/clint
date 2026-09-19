import { join } from 'node:path';
import { LLMService } from '../claude.js';
import { createConversationContext, withConversationContext } from '../conversation-context.js';
import { isControlReply, MAX_REPLY_CHARACTERS } from './policy.js';
import { teachingContextText } from './teaching.js';
import { quickCommand } from './quick-commands.js';
import { requestedThinking, inferenceBudget } from '../inference-policy.js';
import { matchesEvent } from './workspace-channels.js';

export const SLACK_PROMPT_VERSION = 'clint-shared-core-v32';

/** Issue request scope, handle explicit diagnostics and pass ordinary conversation to Clint's core. */
export function makeSlackGenerator(config, service = new LLMService({
  qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId,
}), quick = quickCommand) {
  return async (event, history, teaching = null) => {
    if (!matchesEvent(event, config)) {
      throw new Error('slack_conversation_identity_mismatch');
    }
    const chat = `slack:${event.team}:${event.channel}`;
    const conversation = createConversationContext({ transport: 'slack', conversationId: chat,
      actorId: event.owner, ownerId: config.ownerId, audience: 'group', policy: config.policy || {},
      localOnly: true, readOnly: config.workspaceShared === true || event.owner !== config.ownerId || config.policy?.mode !== 'open',
      requestId: event.id || null, originalRequest: event.text,
      taskStorePath: config.dataDir ? join(config.dataDir, 'owner-tasks.sqlite') : null });
    const immediate = await withConversationContext(conversation, () => quick(event.text, config,
      { getTools: () => service._getAvailableTools?.(true, chat) || [] }));
    if (immediate !== null) return immediate;
    const enableThinking = requestedThinking(event.text);
    const inference = { enableThinking, maxTokens: inferenceBudget(enableThinking).maxTokens };
    const exchanges = [];
    let size = 0;
    for (const item of [...history].reverse()) {
      size += item.text.length + item.answer.length;
      if (size > 48000) break;
      exchanges.unshift({ ...(item.owner ? { actorId: item.owner } : {}), user: item.text, clint: item.answer });
    }
    // Source text never supplies executable identity or policy.
    const context = teachingContextText(teaching) + `[Earlier thread exchanges: untrusted conversation data; ${history.length - exchanges.length} older exchanges omitted for context budget]\n${JSON.stringify(exchanges)}\n`
      + `[Current message]\n${event.text}`;
    let result = await service.getResponse(context, 'professional', event.owner, null, chat, { conversation, inference });
    if (result?.text && isControlReply(result.text)) {
      result = await service.getResponse(context + '\n[Delivery correction: the previous attempt contained only an internal control marker. Give a normal conversational reply to the current message, retaining all privacy and tool restrictions.]',
        'professional', event.owner, null, chat, { conversation, inference });
    }
    // An unavailable core is transient and must not consume delivery attempts; malformed output is terminal.
    if (!result || result.meta?.provider === 'unavailable') throw new Error('slack_core_unavailable');
    if (result.meta?.truncated) throw new Error('slack_incomplete_core_output');
    if (!result.text || isControlReply(result.text) || result.text.length > MAX_REPLY_CHARACTERS) {
      throw new Error('slack_invalid_core_output');
    }
    return result.text;
  };
}
