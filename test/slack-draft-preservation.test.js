import { test } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { createConversationContext, withConversationContext, currentConversation } from '../src/conversation-context.js';
import { shouldCritique, runCritique } from '../src/quality-gate.js';

const scope = extra => createConversationContext({ transport: 'slack', conversationId: 'slack:synthetic-draft',
  actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'open' },
  localOnly: true, readOnly: true, ...extra });
const DRAFT = 'The source records conflict.\n'
  + '- [Record A, paragraph 1] Ada reports seven items.\n'
  + '- [Record B, paragraph 2] Bo reports nine items.\n'
  + '- [Record C, paragraph 1] Neither statement has been withdrawn.\n'
  + '- The actual count is unverified; no reconciliation is recorded.\n'
  + 'A recount is a proposed check, not a completed action. Preserve both attributed claims pending evidence.';
const BAD_REWRITE = 'There are nine verified items. Ada withdrew her earlier statement, and I have updated the stock record to the confirmed total.';
const reply = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {} });

test('protected owner replies preserve the exact draft and make no direct or selected critique call', async () => {
  let calls = 0, tracked = 0;
  const client = { messages: { create: async () => { calls++; return reply(BAD_REWRITE); } } };
  await withConversationContext(scope(), async () => {
    for (const category of ['legal', 'planning', 'email']) {
      assert.equal(shouldCritique(category, DRAFT + 'x'.repeat(100), false), false);
      assert.equal(await runCritique(DRAFT, category, () => tracked++,
        { client, defaultModel: 'synthetic', provider: 'qwen' }), DRAFT);
    }
  });
  assert.equal(calls, 0); assert.equal(tracked, 0);
});

test('negative control and all excluded scopes retain the legacy rewrite, not a vacuous preservation pass', async () => {
  const excluded = [undefined, scope({ transport: 'internal' }), scope({ transport: 'whatsapp' }),
    scope({ audience: 'direct' }), scope({ audience: 'unknown' }), scope({ actorId: 'other' }),
    scope({ localOnly: false }), scope({ webOnly: true }),
    scope({ policy: { mode: 'project' } })];
  let calls = 0;
  const selected = { defaultModel: 'synthetic', provider: 'qwen',
    client: { messages: { create: async request => {
      calls++;
      assert.deepEqual(request.messages, [{ role: 'user', content: `DRAFT RESPONSE TO REVIEW:\n\n${DRAFT}` }]);
      return reply(BAD_REWRITE);
    } } } };
  for (const item of excluded) {
    const check = async () => {
      assert.equal(shouldCritique('legal', DRAFT, false), true);
      assert.equal(await runCritique(DRAFT, 'legal', () => {}, selected), BAD_REWRITE);
    };
    if (item) await withConversationContext(item, check); else await check();
  }
  assert.equal(calls, excluded.length);
});

test('parallel request contexts do not suppress or enable another audience rewrite', async () => {
  const seen = [];
  const selected = { defaultModel: 'synthetic', provider: 'qwen',
    client: { messages: { create: async () => {
      await Promise.resolve(); seen.push(currentConversation().transport); return reply(BAD_REWRITE);
    } } } };
  const outputs = await Promise.all([
    withConversationContext(scope(), () => runCritique(DRAFT, 'legal', () => {}, selected)),
    withConversationContext(scope({ transport: 'internal' }), () => runCritique(DRAFT, 'legal', () => {}, selected)),
  ]);
  assert.deepEqual(outputs, [DRAFT, BAD_REWRITE]); assert.deepEqual(seen, ['internal']);
  assert.equal(currentConversation(), undefined);
});

async function throughCore({ blocked = false, canary = false } = {}) {
  let calls = 0;
  const { LLMService } = await esmock('../src/claude.js', {
    '../src/slack/flow-guard.js': { guardedExecuteTool: async () => JSON.stringify({ source: 'synthetic', text: DRAFT }) },
    '../src/usage-tracker.js': { checkDailyLimit: () => true, incrementDailyCalls: () => 1,
      trackTokens: () => {}, recordCallInUsage: () => {} },
  });
  const service = new LLMService({ qwenChatUrl: 'http://127.0.0.1:1', qwenChatModel: 'synthetic',
    gatherIntelligence: async () => ({ route: { category: 'planning', source: 'fixture' },
      memoryFragment: '', timing: { totalMs: 1, phase1Ms: 1 } }) });
  service._getAvailableTools = () => [{ name: 'web_fetch', input_schema: { type: 'object' } }];
  service._qwenClient = { messages: { create: async request => {
    calls++;
    if (calls === 1) return { stop_reason: 'tool_use', usage: {}, content: [
      { type: 'tool_use', id: 'synthetic-read', name: 'web_fetch', input: {} }] };
    if (calls > 2) return reply(BAD_REWRITE);
    const marker = JSON.stringify(request.system).match(/CANARY_[A-Z0-9]+/)?.[0];
    if (canary) assert.ok(marker, 'real core must issue the canary used in this probe');
    return reply(DRAFT + (blocked ? '\nforbidden synthetic label' : '') + (canary ? `\n${marker}` : ''));
  } } };
  const conversation = scope({ policy: { mode: 'open', blockedTopics: ['forbidden synthetic label'] } });
  const result = await service.getResponse('Read the synthetic records and preserve the competing claims.',
    'professional', 'owner', null, conversation.conversationId, { conversation });
  return { result, calls };
}

test('real core preserves source draft after tools while blocked-topic and canary filters still reject output', async () => {
  const normal = await throughCore();
  assert.equal(normal.result.text, DRAFT); assert.equal(normal.calls, 2);
  assert.equal(normal.result.meta.category, 'planning');
  for (const flags of [{ blocked: true }, { canary: true }]) {
    const out = await throughCore(flags);
    assert.equal(out.calls, 2); assert.equal(out.result.meta.outputBlocked, true);
    assert.doesNotMatch(out.result.text, /forbidden synthetic label|CANARY_/);
  }
});
