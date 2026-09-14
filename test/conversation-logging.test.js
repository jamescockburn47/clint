import { test } from 'node:test';
import assert from 'node:assert/strict';
import logger from '../src/logger.js';
import { classifyVia4B } from '../src/evo-llm.js';
import { executePlan } from '../src/task-planner.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
const secret = 'SYNTHETIC_PRIVATE_DO_NOT_LOG_29473';

test('classifier and planner do not log source fragments, generated goals or adaptation reasons', async t => {
  const logged = [];
  for (const method of ['info', 'warn', 'error']) t.mock.method(logger, method, (...args) => logged.push(args));
  const replies = [secret, JSON.stringify({ category: secret }), JSON.stringify({ goal: secret,
    steps: [{ step_id: 1, tool: 'project_read', tool_input: { id: 'fixture' } },
      { step_id: 2, tool: 'project_read', tool_input: { id: 'fixture' }, depends_on: [1] }] }),
    JSON.stringify({ action: 'abort', reason: secret }), 'No project found.'];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (replies.length > 3) assert.equal(JSON.parse(options.body).chat_template_kwargs?.enable_thinking, false);
    return { ok: true,
    json: async () => ({ choices: [{ message: { content: replies.shift() } }] }) }; });
  assert.equal(await classifyVia4B(secret), null);
  assert.equal(await classifyVia4B(secret), null);
  // Read-only Slack bypasses this planner; exercise the retained non-Slack planner path.
  const scope = createConversationContext({ transport: 'whatsapp', conversationId: 'fixture@g.us',
    actorId: 'owner', ownerId: 'owner', audience: 'group', localOnly: true, readOnly: true,
    policy: { mode: 'project', allowedProjects: ['fixture'] } });
  const result = await withConversationContext(scope,
    () => executePlan(secret, {}, 'owner', scope.conversationId, ''));
  assert.ok(result); assert.equal(result.plan.goal, secret);
  assert.equal(replies.length, 0);
  replies.push(JSON.stringify({ goal: secret, steps: [{ step_id: secret, tool: secret, tool_input: {} }] }));
  await withConversationContext(scope, () => executePlan(secret, {}, 'owner', scope.conversationId, ''));
  replies.push(JSON.stringify({ goal: secret,
    steps: [{ step_id: 1, tool: 'project_read', tool_input: { id: 'fixture' } },
      { step_id: 2, tool: 'project_read', tool_input: { id: 'fixture' }, depends_on: [1] }] }),
    `{broken ${secret}}`, 'No project found.');
  await withConversationContext(scope, () => executePlan(secret, {}, 'owner', scope.conversationId, ''));
  assert.equal(replies.length, 0);
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(secret));
});
