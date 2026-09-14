import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeModel, observeHardware, systemStatus, capabilityPrompt } from '../src/runtime-status.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { getToolsForCategory } from '../src/router.js';
import { boundToolResult } from '../src/tool-result.js';
import { executeTool } from '../src/tools/handler.js';

const scope = patch => createConversationContext({ transport: 'slack', conversationId: 'slack:test',
  actorId: 'owner', ownerId: 'owner', audience: 'group', localOnly: true, readOnly: true,
  policy: { mode: 'colleague' }, ...patch });
const response = value => new Response(JSON.stringify(value));
const props = name => ({ model_path: `/models/${name}.gguf`, total_slots: 1,
  default_generation_settings: { n_ctx: 32768 }, build_info: 'pinned-build',
  chat_template: 'DO NOT EXPOSE TEMPLATE', private: 'DO NOT EXPOSE PRIVATE' });
const modelArgs = { baseUrl: 'http://127.0.0.1:11435', modelId: 'configured' };

test('fresh observations reflect model changes and later failure never reuses successful state', async () => {
  let state = 'first';
  const fetchFn = async () => { if (state === 'down') throw new Error('secret'); return response(props(state)); };
  assert.equal((await observeModel({ ...modelArgs, fetchFn })).reportedModel, 'first.gguf');
  state = 'replacement';
  assert.equal((await observeModel({ ...modelArgs, fetchFn })).reportedModel, 'replacement.gguf');
  state = 'down';
  const failed = await observeModel({ ...modelArgs, fetchFn });
  assert.equal(failed.observedAt, null);
  assert.equal(failed.reportedModel, null);
  assert.doesNotMatch(JSON.stringify(failed), /secret|replacement/);
});

test('gateway observation never uses autoloading upstream endpoints and excludes commands and prompts', async () => {
  const calls = [];
  const fetchFn = async url => {
    calls.push(url.pathname);
    if (url.pathname === '/props') return new Response('', { status: 404 });
    if (url.pathname === '/running') return response({ running: [{ model: 'configured', state: 'ready', cmd: 'SECRET' }] });
    assert.fail('An upstream request could reload or swap a model');
  };
  const result = await observeModel({ ...modelArgs, fetchFn });
  assert.equal(result.reportedModel, 'configured');
  assert.equal(result.contextPerSlot, null);
  assert.deepEqual(calls, ['/props', '/running']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|TEMPLATE|PRIVATE/);
  calls.length = 0;
  const absent = await observeModel({ ...modelArgs, fetchFn: async url => {
    calls.push(url.pathname);
    return url.pathname === '/props' ? new Response('', { status: 404 }) : response({ running: [] });
  } });
  assert.equal(absent.state, 'not_ready');
  assert.deepEqual(calls, ['/props', '/running']);
});

test('invalid destinations and model path injection cannot make network calls', async () => {
  for (const patch of [{ baseUrl: 'https://example.com' }, { baseUrl: 'http://127.0.0.1:123/a' },
    { baseUrl: 'http://secret@127.0.0.1:123' }, { modelId: '../other' }]) {
    const result = await observeModel({ ...modelArgs, ...patch, fetchFn: () => assert.fail('network') });
    assert.equal(result.state, 'unavailable');
  }
});

test('hardware distinguishes host and GPU allocations, missing values and current availability', async () => {
  let available = 2000;
  const host = { cpus: () => [{ model: 'AMD Test CPU' }], platform: () => 'linux', arch: () => 'x64', release: () => 'test' };
  const read = async path => {
    if (path === '/proc/meminfo') return `MemTotal:       3000 kB\nMemAvailable:    ${available} kB\n`;
    if (path.endsWith('mem_info_vram_total')) return '96000';
    if (path.endsWith('mem_info_vram_used')) return '12000';
    throw new Error('not readable');
  };
  const dependencies = { host, read, list: async () => ['card0', 'card0-HDMI-A-1'] };
  const first = await observeHardware(dependencies);
  assert.equal(first.linuxManagedBytes, 3000 * 1024);
  assert.equal(first.installedPhysicalBytes, null);
  assert.equal(first.gpu.length, 1);
  assert.equal(first.gpu[0].gttUsedBytes, null);
  assert.equal(first.gpu[0].totalBytes, 96000);
  available = 800;
  assert.equal((await observeHardware(dependencies)).linuxAvailableBytes, 800 * 1024);
  assert.equal(first.product, null);
  assert.ok(first.unavailable.includes('product_name'));
});

test('owner-only live status denies every unauthorized scope before reads; tool dispatch enforces it', async () => {
  for (const s of [undefined, scope({ actorId: 'other' }), scope({ audience: 'unknown' }),
    scope({ localOnly: false }), scope({ webOnly: true })]) {
    const result = await systemStatus({ scope: s, model: () => assert.fail('model read'), hardware: () => assert.fail('hardware read') });
    assert.equal(JSON.parse(result).state, 'not_authorized');
  }
  const other = scope({ actorId: 'other' });
  const denied = await withConversationContext(other, () => executeTool('system_status', {}, 'other', other.conversationId));
  assert.match(denied, /denied/);
  assert.equal(permitsTool('system_status', {}, scope({})), true);
});

test('snapshot is atomic and capability descriptions use current offered tools', async () => {
  const s = scope({});
  const result = await systemStatus({ scope: s, model: async () => ({ state: 'unavailable' }),
    hardware: async () => ({ installedPhysicalBytes: null }), resolve: async () => { throw new Error('absent'); },
    core: { evoLlmUrl: modelArgs.baseUrl, evoChatModel: 'configured', evoMemoryEnabled: false } });
  assert.equal(JSON.parse(result).deployment.release, null);
  assert.equal(JSON.parse(result).deployment.currentProcessReleaseMatches, null);
  assert.equal(boundToolResult('system_status', result), result);
  const overLegacyCap = JSON.stringify({ state: 'runtime_snapshot', padding: 'x'.repeat(2100),
    freshness: 'point_in_time', deployment: { release: null } });
  assert.equal(boundToolResult('system_status', overLegacyCap), overLegacyCap);
  const large = JSON.stringify({ data: 'x'.repeat(30000) });
  assert.equal(JSON.parse(boundToolResult('system_status', large)).state, 'evidence_unavailable');
  const tools = getToolsForCategory('conversational', [{ name: 'system_status' }, { name: 'gmail_read' }]);
  assert.deepEqual(tools, [{ name: 'system_status' }]);
  const prompt = capabilityPrompt(tools, s);
  assert.match(prompt, /system_status/);
  assert.doesNotMatch(prompt, /gmail_read/);
  assert.match(prompt, /offered operations, not evidence/);
});

test('disabled memory tools are denied for Slack before they can be offered or executed', () => {
  for (const name of ['memory_search', 'memory_update', 'memory_delete']) {
    assert.equal(permitsTool(name, {}, scope({ policy: { mode: 'open' } }), { evoMemoryEnabled: false }), false);
  }
  assert.equal(permitsTool('system_status', {}, scope({}), { evoMemoryEnabled: false }), true);
});
