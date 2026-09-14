import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlackCoreConfig } from '../src/slack/core-config.js';
const slack = { modelUrl: 'http://127.0.0.1:11435', modelId: 'qwen3.8-27b' };
const core = { evoLlmUrl: slack.modelUrl, evoChatModel: slack.modelId,
  evoClassifierUrl: slack.modelUrl, evoPlannerUrl: slack.modelUrl, evoMemoryUrl: 'http://127.0.0.1:5100',
  evoSearxngUrl: 'http://localhost:8888' };
test('Slack boot requires aligned local core endpoints and no inherited private cloud credentials', () => {
  assert.doesNotThrow(() => validateSlackCoreConfig(core, slack));
  for (const patch of [{ evoLlmUrl: 'http://127.0.0.1:8080' }, { evoChatModel: 'other' },
    { evoClassifierUrl: 'https://external.example' }, { evoPlannerUrl: 'https://external.example' },
    { evoMemoryUrl: 'http://192.168.1.1:5100' }, { evoSearxngUrl: 'https://searx.example' },
    { anthropicApiKey: 'secret' }, { minimaxApiKey: 'secret' }, { googleRefreshToken: 'secret' },
    { tavilyApiKey: 'secret' }, { braveApiKey: 'secret' }, { perplexityApiKey: 'secret' }]) {
    assert.throws(() => validateSlackCoreConfig({ ...core, ...patch }, slack), error => !error.message.includes('secret'));
  }
});
