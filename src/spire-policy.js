import { currentConversation } from './conversation-context.js';
import { outboundQuerySafe } from './outbound-query.js';

export const SPIRE_NAMES = new Set(['spire_status', 'spire_look', 'spire_contribute']);
/** Original current owner wording selects a bounded tool compartment, never venue/history text. */
export function isSpireTurn(scope) {
  return scope?.transport === 'slack' && typeof scope.originalRequest === 'string' &&
    (/^Clint, (?:inspect Spire|Spire status)[.!?]?$/i.test(scope.originalRequest) ||
      /^Clint, post to Spire: [\s\S]+$/i.test(scope.originalRequest));
}
export function approvedSpireText(scope) {
  if (typeof scope?.originalRequest !== 'string') return null;
  const match = /^Clint, post to Spire: ([\s\S]+)$/i.exec(scope.originalRequest);
  return match && match[1].length <= 2000 && match[1] === match[1].trim() &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(match[1]) ? match[1] : null;
}
export function spireAllowed(name, input, scope = currentConversation(), spire) {
  if (!SPIRE_NAMES.has(name) || !spire?.enabled || !isSpireTurn(scope) || scope?.transport !== 'slack' ||
      scope.audience !== 'group' || !scope.isOwner || !scope.localOnly || !scope.privateContext ||
      scope.readOnly || scope.webOnly || scope.policy.workspaceShared || scope.policy.mode !== 'open' ||
      !scope.requestId || !scope.taskStorePath || typeof scope.spireReauthorize !== 'function') return false;
  if (name !== 'spire_contribute') return true;
  const text = approvedSpireText(scope);
  return text !== null && outboundQuerySafe(text, spire.guard) &&
    (input === undefined || input?.text === text);
}
