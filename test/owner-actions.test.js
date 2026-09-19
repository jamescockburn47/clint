import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { legacyPlannerAllowed } from '../src/owner-actions.js';
import { taskAction } from '../src/tasks/owner-store.js';
import { executeTool } from '../src/tools/handler.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { getToolsForCategory } from '../src/router.js';
import { OWNER_TASK_DEFINITIONS } from '../src/tasks/owner-tools.js';
import { quickCommand } from '../src/slack/quick-commands.js';
import { runCritique } from '../src/quality-gate.js';
import { finishToolAttempt } from '../src/tool-attempt-notice.js';
import { createArchiveAttemptEvidence } from '../src/archive-attempt-evidence.js';
import { orderedToolReads } from '../src/parallel-reads.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';

const scope = extra => createConversationContext({ transport: 'slack', conversationId: 'slack:T1:C1',
  actorId: 'U1', ownerId: 'U1', audience: 'group', policy: { mode: 'open' }, localOnly: true,
  readOnly: false, requestId: 'EvONE', originalRequest: 'Save exactly this request.', taskStorePath: '/synthetic/tasks.sqlite', ...extra });
const record = { title: 'Synthetic task', details: 'Preserve exact details.\nSecond line.' };

test('owner action authority is explicit; public, non-owner, restricted and background requests cannot write', () => {
  assert.equal(permitsTool('task_save', record, scope()), true);
  for (const change of [{ actorId: 'U2' }, { policy: { mode: 'open', workspaceShared: true } },
    { policy: { mode: 'colleague' } }, { readOnly: true }, { requestId: null }, { taskStorePath: null }, { webOnly: true },
    { localOnly: false }, { transport: 'internal' }, { audience: 'direct' }]) {
    assert.equal(permitsTool('task_save', record, scope(change)), false);
  }
  for (const name of ['gmail_confirm_send', 'calendar_create_event', 'moorstead_ops', 'soul_learn',
    'todo_add', 'unknown_tool']) assert.equal(permitsTool(name, {}, scope()), false);
  assert.equal(legacyPlannerAllowed(scope()), false);
  assert.equal(legacyPlannerAllowed({ transport: 'internal' }), true);
  assert.deepEqual(getToolsForCategory('task', OWNER_TASK_DEFINITIONS), OWNER_TASK_DEFINITIONS);
});

test('writable private scope retains source draft, evidence fallback, honest notices, help and sequential writes', async () => {
  await withConversationContext(scope(), async () => {
    const draft = 'Source A says seven; Source B says nine. Unresolved.';
    let critiqueCalls = 0;
    assert.equal(await runCritique(draft, 'legal', () => {}, {
      client: { messages: { create: async () => { critiqueCalls++; return { stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Nine is verified. I updated the record.' }], usage: {} }; } } }, defaultModel: 'test' }), draft);
    assert.equal(critiqueCalls, 0);
    assert.ok(createArchiveAttemptEvidence());
    const notice = finishToolAttempt({ response: null, toolRounds: 1 }, {});
    assert.equal(notice.meta.incomplete, true); assert.match(notice.text, /already recorded remain saved/);
    assert.match(await quickCommand('clint help', {}, { getTools: () => OWNER_TASK_DEFINITIONS }), /task_save/);
    let active = 0, peak = 0;
    await orderedToolReads([{ name: 'task_save' }, { name: 'task_set_status' }], async () => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    });
    assert.equal(peak, 1);
  });
});

test('committed tasks survive reopen, exact replay is stable, changed retry fails and scope cannot cross', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clint-owner-test-'));
  try {
    const path = join(dir, 'tasks.sqlite'), owner = scope();
    const saved = taskAction(path, owner, 'task_save', record);
    assert.deepEqual(taskAction(path, owner, 'task_save', record), saved);
    assert.throws(() => taskAction(path, owner, 'task_save', { ...record, title: 'Different' }), /replay_conflict/);
    let tasks = taskAction(path, owner, 'task_list', {}).tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].details, undefined);
    const full = taskAction(path, owner, 'task_read', { id: tasks[0].id }).task;
    assert.equal(full.details, record.details); assert.equal(full.original_request, owner.originalRequest);
    assert.equal(taskAction(path, scope({ conversationId: 'slack:T1:OTHER' }), 'task_list', {}).tasks.length, 0);
    assert.throws(() => taskAction(path, scope({ actorId: 'U2' }), 'task_set_status',
      { id: saved.task.id, status: 'completed' }), /not_found_in_scope/);
    const changed = taskAction(path, scope({ requestId: 'EvTWO' }), 'task_set_status',
      { id: saved.task.id, status: 'cancelled' });
    assert.equal(changed.task.status, 'cancelled');
    assert.equal(taskAction(path, owner, 'task_list', {}).tasks[0].status, 'cancelled');
    assert.throws(() => taskAction(path, owner, 'task_list', { path: '/etc/passwd' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual Slack adapter and tool handler persist a synthetic action, rejecting mismatched actors and shared scopes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clint-slack-owner-test-'));
  try {
    const config = { teamId: 'T1', channelId: 'C1', ownerId: 'U1', dataDir: dir, policy: { mode: 'open' } };
    const generate = makeSlackGenerator(config, { getResponse: async (_text, _mode, sender, _image, chat, options) => {
      assert.equal(options.conversation.readOnly, false);
      return withConversationContext(options.conversation, async () => {
        assert.match(await executeTool('task_save', record, 'U2', chat), /denied/);
        const result = JSON.parse(await executeTool('task_save', record, sender, chat));
        assert.equal(result.state, 'recorded');
        return { text: 'Saved local task.' };
      });
    } }, async () => null);
    const event = { id: 'EvTEST', team: 'T1', channel: 'C1', owner: 'U1', text: 'Please save a synthetic task.' };
    assert.equal(await generate(event, []), 'Saved local task.');
    assert.equal(await generate(event, []), 'Saved local task.');
    assert.equal(taskAction(join(dir, 'owner-tasks.sqlite'), scope(), 'task_list', {}).tasks.length, 1);
    const publicGenerate = makeSlackGenerator({ ...config, workspaceShared: true,
      policy: { mode: 'open', workspaceShared: true } }, { getResponse: async (_t, _m, _s, _i, _c, options) => {
      assert.equal(options.conversation.readOnly, true);
      assert.equal(permitsTool('task_save', record, options.conversation), false);
      return { text: 'Public reply' };
    } }, async () => null);
    assert.equal(await publicGenerate(event, []), 'Public reply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('worker retries after a committed write and lost answer without duplicating the saved task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clint-owner-retry-'));
  const config = { teamId: 'T1', channelId: 'C1', ownerId: 'U1', botUserId: 'U9', dataDir: dir, policy: { mode: 'open' } };
  let store = new SlackStore(dir), attempts = 0, delivered = 0;
  try {
    const generate = makeSlackGenerator(config, { getResponse: async (_t, _m, sender, _i, chat, options) =>
      withConversationContext(options.conversation, async () => {
        const result = JSON.parse(await executeTool('task_save', record, sender, chat));
        assert.equal(result.state, 'recorded');
        if (++attempts === 1) throw Error('synthetic_lost_answer_after_commit');
        return { text: 'Saved local task.' };
      }) }, async () => null);
    const web = { conversations: { info: async () => ({ ok: true, channel: { id: 'C1', is_private: true,
      is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }),
      members: async () => ({ ok: true, members: ['U1', 'U9'] }) },
    chat: { postMessage: async () => { delivered++; return { ok: true, channel: 'C1', ts: '1789328011.000001' }; } } };
    const event = { id: 'EvRETRY', team: 'T1', channel: 'C1', owner: 'U1', ts: '1789328000.000001',
      thread: '1789328000.000001', text: 'Save this synthetic task.' };
    store.enqueue(event, Date.now());
    await new SlackWorker({ store, config, web, generate }).drain();
    assert.equal(delivered, 0);
    store.close(); store = new SlackStore(dir); store.recover();
    await new SlackWorker({ store, config, web, generate }).drain();
    assert.equal(attempts, 2); assert.equal(delivered, 1);
    assert.equal(taskAction(join(dir, 'owner-tasks.sqlite'), scope(), 'task_list', {}).tasks.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
