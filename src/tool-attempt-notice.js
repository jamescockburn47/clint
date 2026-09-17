import { currentConversation } from './conversation-context.js';
import { isControlReply, MAX_REPLY_CHARACTERS } from './slack/policy.js';

const NOTICES = Object.freeze({
  provider_lost: 'I couldn’t get the model response needed to finish this attempt, so I don’t have a completed answer.',
  tool_round_limit: 'I reached the tool-step limit before finishing this attempt. I don’t have a completed answer; please ask me to tackle one part at a time.',
  empty_tool_use: 'The model returned an unusable tool step, so I couldn’t complete this attempt.',
  token_limit: 'The response reached its token limit before it was complete. I don’t have a completed answer from this attempt.',
  unusable_response: 'I couldn’t produce a complete usable answer from this attempt. I haven’t completed your request.',
});

/** Return a terminal notice for an unusable read-only Slack attempt; otherwise leave normal handling unchanged. */
export function finishToolAttempt(outcome, meta, scope = currentConversation()) {
  if (scope?.transport !== 'slack' || scope.audience !== 'group' || !scope.isOwner ||
      !scope.localOnly || !scope.readOnly) return null;
  const response = outcome.response;
  const blocks = Array.isArray(response?.content) ? response.content : [];
  let reason = !response ? 'provider_lost' : response.stop_reason === 'tool_use'
    ? (outcome.toolRounds >= 5 ? 'tool_round_limit' : 'empty_tool_use')
    : response.stop_reason === 'max_tokens' ? 'token_limit' : null;
  const malformed = blocks.some(block => !block || block.type !== 'text' || typeof block.text !== 'string');
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  if (!reason && (response.stop_reason !== 'end_turn' || malformed || !text.trim() ||
      text.length > MAX_REPLY_CHARACTERS || isControlReply(text) || /<tool_call\b|<function=/i.test(text))) reason = 'unusable_response';
  if (!reason) return null;
  const evidence = scope.privateContext && !scope.webOnly && typeof outcome.archiveEvidence === 'string'
    && outcome.archiveEvidence.length <= 9000 ? outcome.archiveEvidence : '';
  return { text: NOTICES[reason] + evidence, meta: { ...meta,
    provider: outcome.provider, modelName: outcome.modelName, providerReason: 'tool_attempt_incomplete',
    incomplete: true, termination: reason, toolRounds: outcome.toolRounds,
    critiqueApplied: false, applicationNotice: true, archiveEvidenceIncluded: !!evidence } };
}
