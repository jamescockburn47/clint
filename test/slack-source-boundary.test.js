import { test } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { executeTool } from '../src/tools/handler.js';
import { TOOL_DEFINITIONS } from '../src/tools/definitions.js';
import { buildProjectScopePrompt } from '../src/project-access.js';

const scopeFor = (mode = 'open') => createConversationContext({ transport: 'slack',
  conversationId: 'slack:synthetic', actorId: 'owner', ownerId: 'owner', audience: 'group',
  localOnly: true, readOnly: true, policy: { mode, allowedProjects: ['lqcouncil'] } });

test('Slack denies seeded project operations before execution and preserves sourced status tools', async () => {
  for (const mode of ['open', 'project', 'colleague']) {
    await withConversationContext(scopeFor(mode), async () => {
      const names = TOOL_DEFINITIONS.filter(tool => tool.name.startsWith('project_')).map(tool => tool.name);
      assert.ok(names.length >= 5);
      for (const name of names) {
        assert.equal(permitsTool(name, { id: 'lqcouncil' }), false);
        assert.match(await executeTool(name, { id: 'lqcouncil' }, 'owner', 'slack:synthetic'), /denied/);
      }
      assert.equal(permitsTool('system_status', {}), true);
      assert.equal(permitsTool('repository_status', { id: 'clint' }), true);
      assert.equal(permitsTool('knowledge_status', {}), mode === 'open');
      assert.equal(buildProjectScopePrompt('slack:synthetic', 'Explain the registered project'), '');
    });
  }
});

test('read-only Slack skips autonomous planning while retaining the actual core tool loop', async () => {
  let planned = 0;
  const { LLMService } = await esmock('../src/claude.js', {
    '../src/task-planner.js': { executePlan: async () => { planned++; throw Error('planner_must_not_run'); } },
    '../src/usage-tracker.js': { trackTokens: () => {} },
  });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic',
    gatherIntelligence: async () => ({ route: { category: 'conversational', source: 'fixture',
      needsPlan: true, confidence: 1 }, memoryFragment: '', timing: { totalMs: 0, phase1Ms: 0 } }) });
  const requests = [];
  service._qwenClient = { messages: { create: async payload => {
    requests.push(structuredClone(payload));
    return requests.length === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'status1', name: 'knowledge_status', input: {} }], usage: {} }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic answer after a source-status read.' }], usage: {} };
  } } };
  const scope = scopeFor();
  const result = await service.getResponse('Synthetic request', 'professional', 'owner', null,
    scope.conversationId, { conversation: scope });
  assert.equal(planned, 0);
  assert.equal(requests.length, 2);
  assert.equal(result.text, 'Synthetic answer after a source-status read.');
  assert.ok(requests[0].tools.some(tool => tool.name === 'knowledge_status'));
  assert.ok(requests[0].tools.every(tool => !tool.name.startsWith('project_')));
  assert.ok(requests[1].messages.at(-1).content.some(block => block.type === 'tool_result'));
});

test('Slack Cortex cannot inject the legacy project shelf', async () => {
  const { gatherIntelligence } = await esmock('../src/cortex.js', {
    '../src/config.js': { default: { evoMemoryEnabled: false, dreamModeEnabled: false } },
    '../src/router.js': { classifyMessage: async () => ({ category: 'planning', source: 'fixture' }) },
    '../src/lquorum-rag.js': { warmFromQuery: () => assert.fail('legacy shelf warm'),
      getWorkingKnowledge: () => assert.fail('legacy shelf read') },
  });
  const result = await withConversationContext(scopeFor(), () =>
    gatherIntelligence('Synthetic project discussion', false, true, { chatJid: 'slack:synthetic' }));
  assert.equal(result.memoryFragment, '');
});
