import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../src/tools/definitions.js';
// Set dummy key BEFORE importing prompt.js (which imports config.js which calls process.exit)
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
const { getSystemPrompt } = await import('../src/prompt.js');

describe('tool definitions guardrails', () => {
  it('gmail_send tool does not exist', () => {
    const sendTool = TOOL_DEFINITIONS.find((t) => t.name === 'gmail_send');
    assert.equal(sendTool, undefined, 'gmail_send should not exist — replaced by gmail_draft + gmail_confirm_send');
  });

  it('gmail_draft tool exists with correct required fields', () => {
    const draft = TOOL_DEFINITIONS.find((t) => t.name === 'gmail_draft');
    assert.ok(draft, 'gmail_draft tool must exist');
    assert.deepEqual(draft.input_schema.required, ['to', 'subject', 'body']);
    assert.ok(draft.description.includes('does NOT send'), 'description must state it does not send');
  });

  it('gmail_confirm_send tool exists and requires draft_id', () => {
    const confirm = TOOL_DEFINITIONS.find((t) => t.name === 'gmail_confirm_send');
    assert.ok(confirm, 'gmail_confirm_send tool must exist');
    assert.deepEqual(confirm.input_schema.required, ['draft_id']);
    assert.ok(confirm.description.includes('ONLY call this after James has explicitly confirmed'));
  });

  it('gmail and calendar never expose delete/trash/archive capability', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const name = tool.name.toLowerCase();
      const desc = tool.description.toLowerCase();
      // memory_delete is legitimate — only check for gmail/calendar destructive ops
      if (!name.startsWith('gmail_') && !name.startsWith('calendar_')) continue;
      assert.ok(!name.includes('delete'), `tool ${tool.name} must not have delete in name`);
      assert.ok(!name.includes('trash'), `tool ${tool.name} must not have trash in name`);
      assert.ok(!name.includes('archive'), `tool ${tool.name} must not have archive in name`);
      if (!desc.includes('never') && !desc.includes('memory')) {
        assert.ok(!desc.includes('delete email'), `tool ${tool.name} must not offer delete capability`);
      }
    }
  });

  it('calendar_create_event tool exists but no calendar_delete tool', () => {
    const create = TOOL_DEFINITIONS.find((t) => t.name === 'calendar_create_event');
    assert.ok(create, 'calendar_create_event must exist');
    const deleteTool = TOOL_DEFINITIONS.find((t) => t.name.includes('calendar_delete'));
    assert.equal(deleteTool, undefined, 'no calendar delete tool should exist');
  });

  it('web_search tool exists', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'web_search');
    assert.ok(tool, 'web_search must exist');
    assert.deepEqual(tool.input_schema.required, ['query']);
  });

  it('soul_propose tool exists and requires section + content + reason', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'soul_propose');
    assert.ok(tool, 'soul_propose must exist');
    assert.deepEqual(tool.input_schema.required, ['section', 'content', 'reason']);
    assert.ok(tool.description.includes('Propose a soul update'), `description should mention proposing, got: ${tool.description}`);
  });

  it('soul_confirm warns about owner DM requirement', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'soul_confirm');
    assert.ok(tool, 'soul_confirm must exist');
    assert.ok(tool.description.includes('Only works from owner DM'), `description should mention owner DM, got: ${tool.description}`);
  });
});

describe('system prompt guardrails', () => {
  it('core prompt always contains CORE GUARDRAILS', () => {
    const prompt = getSystemPrompt('direct');
    assert.ok(prompt.includes('CORE GUARDRAILS'), 'core guardrails should always be present');
    assert.ok(prompt.includes('READING is always safe'), 'reading safety should always be present');
  });

  it('email category includes mandatory email guardrails', () => {
    const prompt = getSystemPrompt('direct', true, false, 'email');
    assert.ok(prompt.includes('MUST NEVER send an email in one step'));
    assert.ok(prompt.includes('gmail_draft'));
    assert.ok(prompt.includes('gmail_confirm_send'));
    assert.ok(prompt.includes('NEVER assume confirmation'));
    assert.ok(prompt.includes('NEVER chain gmail_draft'));
  });

  it('email category includes delete prohibition', () => {
    const prompt = getSystemPrompt('direct', true, false, 'email');
    assert.ok(prompt.includes('NEVER delete, trash, or archive'));
  });

  it('calendar category includes confirmation guardrail', () => {
    const prompt = getSystemPrompt('direct', true, false, 'calendar');
    assert.ok(prompt.includes('Wait for explicit confirmation before calling calendar_create_event'));
  });

  it('travel category includes York trip context', () => {
    const prompt = getSystemPrompt('direct', true, false, 'travel');
    assert.ok(prompt.includes('London Kings Cross'));
    assert.ok(prompt.includes('York'));
    assert.ok(prompt.includes('4-trip'));
    assert.ok(prompt.includes('North York Moors'));
  });

  it('includes current date/time', () => {
    const prompt = getSystemPrompt('direct');
    assert.ok(prompt.includes('Current date/time'));
    assert.ok(prompt.includes('Europe/London'));
  });

  it('random mode uses interjection prompt', () => {
    const prompt = getSystemPrompt('random');
    assert.ok(prompt.includes('noticed something in the conversation'));
  });

  it('direct mode uses direct trigger prompt', () => {
    const prompt = getSystemPrompt('direct');
    assert.ok(prompt.includes('directly addressed you'));
  });

  it('planning category contains soul system guardrails', () => {
    const prompt = getSystemPrompt('direct', true, false, 'planning');
    assert.ok(prompt.includes('SOUL SYSTEM RULES'));
    assert.ok(prompt.includes('NEVER chain soul_propose'));
    assert.ok(prompt.includes('soul_confirm'));
  });

  it('self-awareness is present regardless of category', () => {
    const prompt = getSystemPrompt('direct', true, false, 'conversational');
    assert.ok(prompt.includes('Self-Awareness'));
    assert.ok(prompt.includes('search the web'), 'self-awareness mentions web search capability');
  });

  it('email guardrails present in planning category too', () => {
    const prompt = getSystemPrompt('direct', true, false, 'planning');
    assert.ok(prompt.includes('MUST NEVER send an email in one step'));
    assert.ok(prompt.includes('NEVER delete, trash, or archive'));
  });
});

describe('restricted sender guardrails', () => {
  it('restricted prompt includes RESTRICTED SENDER section', () => {
    const prompt = getSystemPrompt('direct', false);
    assert.ok(prompt.includes('RESTRICTED SENDER'));
    assert.ok(prompt.includes('NEVER read, search, draft, or send emails'));
    assert.ok(prompt.includes('NEVER propose or confirm soul changes'));
    assert.ok(prompt.includes('NEVER create calendar events'));
  });

  it('owner prompt does NOT include restricted sender section', () => {
    const prompt = getSystemPrompt('direct', true);
    assert.ok(!prompt.includes('RESTRICTED SENDER'));
  });

  it('default isOwner is true (backward compat)', () => {
    const prompt = getSystemPrompt('direct');
    assert.ok(!prompt.includes('RESTRICTED SENDER'));
  });

  it('immutable core guardrails still present in restricted mode', () => {
    const prompt = getSystemPrompt('direct', false, false, 'email');
    assert.ok(prompt.includes('MUST NEVER send an email in one step'));
    assert.ok(prompt.includes('NEVER delete, trash, or archive'));
    assert.ok(prompt.includes('SOUL SYSTEM RULES'));
  });
});

describe('tool handler dispatch map', () => {
  let executeTool;

  before(async () => {
    const handler = await import('../src/tools/handler.js');
    executeTool = handler.executeTool;
  });

  it('unknown tool returns error message', async () => {
    const result = await executeTool('gmail_send', {});
    assert.ok(result.includes('Unknown tool'), 'old gmail_send should not be in dispatch map');
  });

  it('gmail_delete is not a valid tool', async () => {
    const result = await executeTool('gmail_delete', {});
    assert.ok(result.includes('Unknown tool'));
  });

  it('gmail_trash is not a valid tool', async () => {
    const result = await executeTool('gmail_trash', {});
    assert.ok(result.includes('Unknown tool'));
  });
});
