import { join } from 'node:path';
import { LLMService } from '../claude.js';
import { createConversationContext, withConversationContext } from '../conversation-context.js';
import { isControlReply, MAX_REPLY_CHARACTERS } from './policy.js';
import { teachingContextText } from './teaching.js';
import { quickCommand } from './quick-commands.js';
import { requestedThinking, inferenceBudget } from '../inference-policy.js';
import { matchesEvent } from './workspace-channels.js';
import { getDailyCalls, checkDailyLimit } from '../usage-tracker.js';
import coreConfig from '../config.js';

/** Daily model requests kept back from the lane for the owner and the overnight programme. */
export const LANE_CALL_RESERVE = 40;
export const LANE_ANSWER_TOKENS = 2048;
export const LANE_TOOL_ROUNDS = 2;

export const SLACK_PROMPT_VERSION = 'clint-shared-core-v39';

/** Issue request scope, handle explicit diagnostics and pass ordinary conversation to Clint's core. */
export function makeSlackGenerator(config, service = new LLMService({
  qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId,
}), quick = quickCommand, budget = { calls: () => { checkDailyLimit(); return getDailyCalls(); }, limit: coreConfig.dailyCallLimit }) {
  return async (event, history, teaching = null, slackHistory = null) => {
    if (!matchesEvent(event, config)) {
      throw new Error('slack_conversation_identity_mismatch');
    }
    const lane = config.peerLane === true;
    if (lane && !(budget.calls() < budget.limit - LANE_CALL_RESERVE)) throw new Error('slack_lane_budget_reserved');
    const chat = `slack:${event.team}:${event.channel}`;
    const conversation = createConversationContext({ transport: 'slack', conversationId: chat,
      actorId: event.owner, ownerId: config.ownerId, audience: 'group', policy: config.policy || {},
      // Lane text may come from a third-party agent under the owner's name: never owner authority, web reads only.
      webOnly: lane, forceRestricted: lane,
      localOnly: true, readOnly: config.workspaceShared === true || event.owner !== config.ownerId || config.policy?.mode !== 'open',
      requestId: event.id || null, originalRequest: event.text,
      taskStorePath: config.dataDir ? join(config.dataDir, 'owner-tasks.sqlite') : null });
    const immediate = await withConversationContext(conversation, () => quick(event.text, config,
      { getTools: () => service._getAvailableTools?.(true, chat) || [] }));
    if (immediate !== null) return immediate;
    const enableThinking = !lane && requestedThinking(event.text);
    const inference = { enableThinking, maxTokens: lane ? LANE_ANSWER_TOKENS : inferenceBudget(enableThinking).maxTokens,
      ...(lane ? { maxToolRounds: LANE_TOOL_ROUNDS } : {}) };
    const exchanges = [];
    let size = 0;
    const fallbackHistory = !slackHistory || slackHistory.coverage?.thread === 'unavailable' ||
      slackHistory.coverage?.channel === 'unavailable' ? history : [];
    for (const item of [...fallbackHistory].reverse()) {
      size += JSON.stringify(item).length;
      if (size > 48000) break;
      exchanges.unshift({ ...(item.owner ? { actorId: item.owner } : {}), user: item.text, clint: item.answer });
    }
    // Source text never supplies executable identity or policy.
    const conversationEvidence = teachingContextText(teaching) + JSON.stringify({
      slackHistory, earlierAcceptedExchanges: exchanges,
      omittedAcceptedExchanges: history.length - exchanges.length });
    let result = await service.getResponse(event.text, 'professional', event.owner, null, chat,
      { conversation, inference, conversationEvidence });
    if (!lane && result?.text && isControlReply(result.text)) {
      result = await service.getResponse(event.text, 'professional', event.owner, null, chat,
        { conversation, inference, conversationEvidence: conversationEvidence + '\n[Delivery correction: the previous attempt contained only an internal control marker. Give a normal conversational reply to the current message, retaining all privacy and tool restrictions.]' });
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
