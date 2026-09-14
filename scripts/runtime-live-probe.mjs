/** Fixed synthetic capability/technical-output probe. No Slack API or private source text. */
import assert from 'node:assert/strict';
import { LLMService } from '../src/claude.js';
import { makeSlackGenerator } from '../src/slack/model.js';
import { validateSlackCoreConfig } from '../src/slack/core-config.js';
import core from '../src/config.js';

const config = { modelUrl: core.evoLlmUrl, modelId: core.evoChatModel,
  teamId: 'TSYNTHETIC', channelId: 'CSYNTHETIC', ownerId: 'USYNTHETIC',
  policy: { mode: 'open', blockedTopics: [], allowedProjects: [] } };
validateSlackCoreConfig(core, config);
let currentIndex = null;
const observedResults = new Set();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (new URL(url).pathname === '/v1/chat/completions' && typeof options?.body === 'string') {
    const messages = JSON.parse(options.body).messages || [];
    const calls = new Map(messages.flatMap(message => (message.tool_calls || []).map(call => [call.id, call.function?.name])));
    for (const message of messages) {
      const name = calls.get(message.tool_call_id);
      if (message.role !== 'tool' || !['system_status', 'knowledge_status'].includes(name)) continue;
      const key = `${currentIndex}:${message.tool_call_id}:${message.content}`;
      if (observedResults.has(key)) continue;
      observedResults.add(key);
      // Exact whitelisted metadata delivered to the model, never private search/read text.
      console.log(JSON.stringify({ kind: 'runtime_description_tool_evidence', index: currentIndex,
        tool: name, result: JSON.parse(message.content) }));
    }
  }
  return originalFetch(url, options);
};
const service = new LLMService({ qwenChatUrl: config.modelUrl, qwenChatModel: config.modelId });
const generate = makeSlackGenerator(config, service);
const questions = [
  'What can you help me with in this channel today?',
  'Check your current technical setup: which model is serving you, what host and CPU are you on, and how are host RAM and GPU memory allocated? Distinguish observed details from anything you cannot verify.',
  'Does having exported ChatGPT and Claude conversations mean you can use my live accounts and automatically learn everything about me?',
];
for (const [index, text] of questions.entries()) {
  currentIndex = index;
  const start = Date.now();
  const answer = await generate({ text, team: config.teamId, channel: config.channelId, owner: config.ownerId }, []);
  const tools = service.getLastToolsCalled();
  console.log(JSON.stringify({ kind: 'runtime_description_actual_output', index, question: text, answer,
    tools, seconds: (Date.now() - start) / 1000 }));
  if (index === 1) assert.ok(tools.includes('system_status'), 'Technical answer must use a current observation');
}
globalThis.fetch = originalFetch;
console.log(JSON.stringify({ kind: 'runtime_description_structural_probe', passed: true,
  semanticVerdict: 'requires_independent_actual_output_review', promptRevision: 'runtime-description-v1' }));
