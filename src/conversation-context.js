/** Transport-neutral request authority. Only adapters construct these; model data cannot activate one. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const requests = new AsyncLocalStorage();
const issued = new WeakSet();
const policySchema = z.object({
  mode: z.enum(['open', 'project', 'colleague']).default('colleague'),
  workspaceShared: z.boolean().optional(),
  researchScope: z.string().max(200).optional(),
  label: z.string().optional(),
  blockedTopics: z.array(z.string().min(1).max(200)).default([]),
  allowedProjects: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default([]),
  projectScopeMode: z.enum(['allow_list', 'single_project_only']).optional(),
  offTopicPolicy: z.enum(['allow', 'soft_redirect']).optional(),
}).strip();

export function createConversationContext({ transport, conversationId, actorId, ownerId,
  audience, policy = {}, localOnly = false, forceRestricted = false, webOnly = false, readOnly = false, requestId = null, taskStorePath = null, originalRequest = null, spireReauthorize = null }) {
  if (!['whatsapp', 'slack', 'internal', 'venue'].includes(transport) ||
      !['group', 'direct', 'unknown'].includes(audience) ||
      typeof conversationId !== 'string' || !conversationId || conversationId.length > 200 ||
      typeof actorId !== 'string' || actorId.length > 200 || typeof ownerId !== 'string') {
    throw new Error('invalid_conversation_context');
  }
  const parsed = policySchema.parse(policy);
  parsed.blockedTopics = Object.freeze([...parsed.blockedTopics]);
  parsed.allowedProjects = Object.freeze([...parsed.allowedProjects]);
  const isOwner = !forceRestricted && !!actorId && !!ownerId && actorId === ownerId;
  const isGroup = audience !== 'direct';
  const privateContext = !forceRestricted && !webOnly &&
    ((audience === 'direct' && isOwner) || (audience === 'group' && parsed.mode === 'open'));
  const scope = Object.freeze({ transport, conversationId, actorId, isOwner, audience,
    isGroup, policy: Object.freeze(parsed), privateContext, localOnly: !!localOnly,
    webOnly: !!webOnly, readOnly: !!readOnly, requestId, taskStorePath, originalRequest, spireReauthorize });
  issued.add(scope);
  return scope;
}

export function withConversationContext(scope, fn) {
  if (!issued.has(scope)) throw new Error('unverified_conversation_context');
  return requests.run(scope, fn);
}
export const currentConversation = () => requests.getStore();
export function isGroupConversation(id) {
  const scope = currentConversation();
  if (scope && scope.conversationId === id) return scope.isGroup;
  return typeof id === 'string' && (id.endsWith('@g.us') || id.startsWith('slack:') || id.startsWith('spire:'));
}
export function currentPolicy(id) {
  const scope = currentConversation();
  return scope && scope.conversationId === id ? scope.policy : null;
}
export const permitsPrivateContext = () => !currentConversation() || currentConversation().privateContext;
export function permitsProject(id) {
  const scope = currentConversation();
  if (!scope) return true;
  const allowed = scope.policy.allowedProjects;
  return allowed.length ? allowed.includes(id) : scope.privateContext;
}
export function filterScopedMemories(rows) {
  const scope = currentConversation();
  if (!scope || scope.privateContext) return rows;
  if (scope.webOnly || scope.audience === 'unknown') return [];
  const keys = new Set([scope.conversationId, ...scope.policy.allowedProjects.map(id => `project:${id}`)]);
  return rows.filter(row => {
    const memory = row?.memory || row;
    return typeof memory?.chatJid === 'string' && keys.has(memory.chatJid);
  });
}
