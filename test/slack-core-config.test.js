import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlackCoreConfig } from '../src/slack/core-config.js';
import { loadSlackConfig } from '../src/slack/config.js';
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

const environment = { SLACK_APP_TOKEN: 'xapp-synthetic-only', SLACK_BOT_TOKEN: 'xoxb-synthetic-only',
  SLACK_APP_ID: 'ATEST00000', SLACK_TEAM_ID: 'TTEST00000', SLACK_CHANNEL_ID: 'CTEST00000',
  SLACK_OWNER_ID: 'UTEST00000', SLACK_DATA_DIR: process.cwd() };
test('real Slack configuration accepts the reviewed Flash alias and aligns the shared core', () => {
  const configured = loadSlackConfig({ ...environment, SLACK_MODEL_URL: 'http://127.0.0.1:11437',
    SLACK_MODEL_ID: 'qwen3.8-flash-next' });
  assert.equal(configured.modelId, 'qwen3.8-flash-next');
  assert.doesNotThrow(() => validateSlackCoreConfig({ ...core,
    evoLlmUrl: configured.modelUrl, evoClassifierUrl: configured.modelUrl,
    evoPlannerUrl: configured.modelUrl, evoChatModel: configured.modelId }, configured));
  assert.throws(() => validateSlackCoreConfig(core, configured), /model_mismatch/);
});
test('Slack model selection keeps the old default and rejects unreviewed names or remote endpoints', () => {
  assert.equal(loadSlackConfig(environment).modelId, 'qwen3.8-27b');
  for (const value of ['other-model', 'qwen3.8-flash', '../qwen3.8-flash-next']) {
    assert.throws(() => loadSlackConfig({ ...environment, SLACK_MODEL_ID: value }), /SLACK_MODEL_ID/);
  }
  assert.throws(() => loadSlackConfig({ ...environment, SLACK_MODEL_URL: 'https://remote.example' }), /SLACK_MODEL_URL/);
});
