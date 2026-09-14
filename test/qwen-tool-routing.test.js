import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.EVO_LLM_URL = process.env.EVO_LLM_URL || 'http://localhost:8080';

const { selectMaxTokensForToolLoop, selectToolsForProvider } = await import('../src/claude.js');

const allTools = [
  { name: 'todo_list' },
  { name: 'todo_add' },
  { name: 'web_search' },
  { name: 'web_fetch' },
  { name: 'calendar_list_events' },
  { name: 'gmail_search' },
  { name: 'memory_search' },
];

describe('selectToolsForProvider', () => {
  it('narrows Qwen tool payloads to category tools for non-planning requests', () => {
    const categoryTools = allTools.filter((tool) =>
      ['todo_list', 'todo_add', 'web_search', 'web_fetch'].includes(tool.name),
    );

    const selected = selectToolsForProvider({
      provider: 'qwen',
      category: 'task',
      allTools,
      categoryTools,
    });

    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['todo_list', 'todo_add', 'web_search', 'web_fetch'],
    );
  });

  it('keeps the full Qwen tool payload for planning requests', () => {
    const selected = selectToolsForProvider({
      provider: 'qwen',
      category: 'planning',
      allTools,
      categoryTools: allTools,
    });

    assert.equal(selected.length, allTools.length);
  });

  it('narrows Qwen factual prompts to web tools', () => {
    const categoryTools = allTools.filter((tool) =>
      ['web_search', 'web_fetch'].includes(tool.name),
    );

    const selected = selectToolsForProvider({
      provider: 'qwen',
      category: 'general_knowledge',
      allTools,
      categoryTools,
    });

    assert.deepEqual(selected.map((tool) => tool.name), ['web_search', 'web_fetch']);
  });

  it('narrows Qwen memory-like prompts to status and memory tools', () => {
    const categoryTools = allTools.filter((tool) =>
      ['web_search', 'web_fetch', 'memory_search'].includes(tool.name),
    );

    const selected = selectToolsForProvider({
      provider: 'qwen',
      category: 'system',
      allTools,
      categoryTools,
    });

    assert.deepEqual(selected.map((tool) => tool.name), ['web_search', 'web_fetch', 'memory_search']);
  });
});

describe('selectMaxTokensForToolLoop', () => {
  it('allows a complete answer on the first Qwen auto-tool request', () => {
    assert.equal(selectMaxTokensForToolLoop({
      provider: 'qwen',
      isFirstRequest: true,
      hasTools: true,
      defaultMaxTokens: 4000,
    }), 4000);
  });

  it('keeps the full final-answer budget after tool results', () => {
    assert.equal(selectMaxTokensForToolLoop({
      provider: 'qwen',
      isFirstRequest: false,
      hasTools: true,
      defaultMaxTokens: 4000,
    }), 4000);
  });

  it('keeps non-Qwen provider budgets unchanged', () => {
    assert.equal(selectMaxTokensForToolLoop({
      provider: 'minimax',
      isFirstRequest: true,
      hasTools: true,
      defaultMaxTokens: 4000,
    }), 4000);
  });
});
