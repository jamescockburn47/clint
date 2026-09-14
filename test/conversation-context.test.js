import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationContext as create, withConversationContext as within,
  currentConversation, filterScopedMemories, permitsProject } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { scopedResponse } from '../src/conversation-response.js';
import { getCanaryToken, filterResponse } from '../src/output-filter.js';
import { getSystemPrompt } from '../src/prompt.js';
import { executeTool } from '../src/tools/handler.js';
import { MemoryClient } from '../src/memory.js';
import { validatePlan, executeStep } from '../src/task-planner.js';
import { getWebPrefetch } from '../src/cortex.js';
import { LLMService } from '../src/claude.js';

const policy = { mode: 'project', allowedProjects: ['lqcouncil'], blockedTopics: ['secret project'] };
const make = (transport = 'slack', extra = {}) => create({ transport,
  conversationId: transport === 'slack' ? 'slack:T12345678:C12345678' : '123@g.us',
  actorId: 'owner', ownerId: 'owner', audience: 'group', policy, ...extra });

test('WhatsApp and Slack enforce equivalent privacy and canary policies', async () => {
  for (const transport of ['whatsapp', 'slack']) {
    const scope = make(transport);
    await within(scope, async () => {
      for (const text of ['secret project', getCanaryToken(), 'Henry lives in Helmsley']) {
        assert.equal(filterResponse(text, scope.conversationId).safe, false);
      }
      assert.equal(filterResponse('A sound argument needs evidence.', scope.conversationId).safe, true);
      const prompt = getSystemPrompt('professional', true, true, 'conversational', scope.conversationId);
      assert.ok(prompt.includes(getCanaryToken())); assert.match(prompt, /ANTI-INJECTION/);
      assert.doesNotMatch(prompt, /## The Steads/);
      assert.equal(permitsTool('gmail_read', {}), false);
      assert.equal(permitsTool('lqc_knowledge', {}), true);
      assert.equal(permitsTool('project_read', { id: 'private-other' }), false);
      assert.equal(permitsTool('group_mode', { mode: 'open' }), false);
      assert.equal(permitsTool('web_search', { query: 'secret project' }), false);
      assert.equal(permitsTool('web_fetch', { url: 'https://example.com/?q=secret%20project' }), false);
      assert.equal(permitsTool('project_file_read', { id: 'lqcouncil', path: 'auth_state/key.json' }), false);
      assert.match(await executeTool('gmail_read', {}, 'owner', scope.conversationId), /denied/);
      assert.match(await executeTool('web_search', {}, 'spoof', scope.conversationId), /denied/);
    });
  }
});

test('final response wrapper filters planner/normal results without echoing blocked terms', async () => {
  const conversation = make();
  const result = await scopedResponse({ senderJid: 'owner', chatJid: conversation.conversationId,
    options: { conversation } }, async () => ({ text: 'secret project', meta: { provider: 'planner' } }));
  assert.equal(result.meta.outputBlocked, true); assert.doesNotMatch(result.text, /secret project/);
  await assert.rejects(scopedResponse({ senderJid: 'imposter', chatJid: conversation.conversationId,
    options: { conversation } }, async () => assert.fail()), /identity_mismatch/);
  assert.throws(() => within({ ...conversation, isOwner: true }, () => {}), /unverified/);
});

test('missing identity never becomes the owner; explicit open policy retains legacy private context', () => {
  within(make('slack', { actorId: '', ownerId: '' }), () => assert.equal(permitsTool('web_search'), false));
  const open = make('slack', { policy: { mode: 'open', blockedTopics: ['secret project'] } });
  within(open, () => {
    assert.equal(currentConversation().privateContext, true);
    assert.equal(filterScopedMemories([{ fact: 'private' }]).length, 1);
    assert.equal(filterResponse('secret project', open.conversationId).safe, false);
  });
});

test('online and cached memory searches exclude other chats and unattributed facts', async () => {
  const scope = make();
  const memories = [
    { id: 'other', fact: 'needle', chatJid: 'private@g.us' },
    { id: 'unknown', fact: 'needle' },
    { id: 'allowed', fact: 'needle', chatJid: 'project:lqcouncil' },
    { id: 'channel', fact: 'needle', chatJid: scope.conversationId },
  ];
  const client = new MemoryClient({ memoryUrl: 'http://fixture',
    fetchJSON: async () => ({ results: memories.map(memory => ({ score: 0.9, memory })) }) });
  client._cache = memories;
  await within(scope, async () => {
    for (const online of [false, true]) {
      client._online = online;
      const result = await client.search('needle', null, 8);
      assert.deepEqual(result.map(r => r.memory.id), ['allowed', 'channel']);
    }
    client._online = false;
    assert.equal((await client.search('needle', null, 1))[0].memory.id, 'allowed');
  });
});

test('planner refuses forbidden tools and checks resolved project parameters before execution', async () => {
  await within(make(), async () => {
    assert.equal(validatePlan([{ step_id: 1, tool: 'gmail_read' }]).valid, false);
    const step = { step_id: 2, tool: 'project_read', tool_input: { id: 'private-other' } };
    assert.equal(await executeStep(step, new Map(), 'owner', currentConversation().conversationId), false);
    assert.equal(step.status, 'failed'); assert.match(step.error, /denied/);
    assert.equal(getWebPrefetch('private needle'), null);
  });
});

test('concurrent conversations retain separate policy across asynchronous work', async () => {
  await Promise.all(['first', 'second'].map(id => within(make('slack', {
    conversationId: `slack:${id}`, policy: { mode: 'project', allowedProjects: [id] },
  }), async () => {
    await new Promise(resolve => setTimeout(resolve, id === 'first' ? 12 : 1));
    assert.equal(permitsProject(id), true);
    assert.equal(permitsProject(id === 'first' ? 'second' : 'first'), false);
    assert.equal(permitsTool('project_read', { id }), false);
    assert.equal(permitsTool('project_read', { id: id === 'first' ? 'second' : 'first' }), false);
  })));
});

function core(responses, category = 'conversational') {
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:11435', qwenChatModel: 'qwen3.8-27b',
    gatherIntelligence: async () => ({ route: { category, source: 'fixture' },
      memoryFragment: '', timing: { totalMs: 1, phase1Ms: 1 } }) });
  const requests = [];
  service._qwenClient = { messages: { create: async payload => {
    requests.push(structuredClone(payload)); return responses.shift();
  } } };
  return { service, requests };
}
const reply = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {} });

test('system replies use fast Qwen mode without changing the private channel boundary', async () => {
  const { service, requests } = core([reply('This channel permits read-only tools.')], 'system');
  const conversation = make('slack', { localOnly: true, readOnly: true });
  await service.getResponse('What can you do here?', 'professional', 'owner', null, conversation.conversationId, { conversation });
  assert.equal(requests[0].enableThinking, false);
  assert.match(requests[0].system[0].text, /reads only/);
});

test('real core sends its original prompt and denies a model-invented tool, then filters its answer', async () => {
  const { service, requests } = core([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'SYNTHETIC_PRIVATE_TOOL_NAME', input: {} }], usage: {} },
    reply('secret project'),
  ]);
  const conversation = make('slack', { localOnly: true, readOnly: true });
  const result = await service.getResponse('Hello', 'professional', 'owner', null,
    conversation.conversationId, { conversation });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.enableThinking === false));
  assert.ok(requests[0].max_tokens > 512, 'auto-tool first response can be a full answer');
  assert.match(requests[0].system[0].text, /ANTI-INJECTION/);
  assert.ok(requests[1].messages.at(-1).content[0].content.includes('denied'));
  assert.equal(result.meta.outputBlocked, true);
  assert.deepEqual(service.getLastToolsCalled(), ['unrecognized_tool']);
});

test('local policy refuses cloud fallback and incomplete replies', async () => {
  const { service } = core([reply('unused')]);
  service._qwenClient.messages.create = async () => { throw Error('offline'); };
  service._minimaxClient = { messages: { create: async () => assert.fail('cloud must not run') } };
  await within(make('slack', { localOnly: true }), async () => {
    assert.equal(service._selectClient(true).providerHint, 'qwen');
    assert.equal(service._cloudFallback(), null);
    const result = await service._toolLoop(service._qwenClient, 'qwen', service._qwenBreaker,
      [], [], [], true, 'professional', 'owner', currentConversation().conversationId, 'fixture');
    assert.equal(result, null);
  });
  // A length-truncated local reply is delivered and flagged; any other unfinished stop is refused.
  const partial = core([{ ...reply('unfinished'), stop_reason: 'max_tokens' }]);
  const conversation = make('slack', { localOnly: true });
  const result = await partial.service.getResponse('Hello', 'professional', 'owner', null,
    conversation.conversationId, { conversation });
  assert.equal(result.text, 'unfinished');
  assert.equal(result.meta.truncated, true);
  const refused = core([{ ...reply('unfinished'), stop_reason: 'refusal' }]);
  const other = await refused.service.getResponse('Hello', 'professional', 'owner', null,
    conversation.conversationId, { conversation });
  assert.equal(other.text, null);
});
