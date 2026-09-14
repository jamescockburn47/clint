/** Startup contract: the planner/classifier/memory singleton must use the same local runtime. */
const CLOUD_CREDENTIAL_FIELDS = ['anthropicApiKey', 'minimaxApiKey', 'braveApiKey', 'perplexityApiKey'];

export function validateSlackCoreConfig(core, slack) {
  if (core.evoLlmUrl.replace(/\/$/, '') !== slack.modelUrl.replace(/\/$/, '') ||
      core.evoChatModel !== slack.modelId) throw new Error('slack_core_model_mismatch');
  // Every service the core may call from a Slack request, including the metasearch gateway.
  for (const value of [core.evoLlmUrl, core.evoClassifierUrl, core.evoPlannerUrl, core.evoMemoryUrl, core.evoSearxngUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password) throw new Error('slack_core_requires_local_services');
  }
  // This process is a separate service; credential inheritance must be intentional.
  if (CLOUD_CREDENTIAL_FIELDS.some(field => core[field])) {
    throw new Error('slack_core_unexpected_cloud_credentials');
  }
  // Owner authorized Tavily search and fixed Google read APIs; neither permits cloud model fallback.
  if (core.tavilyApiKey && core.tavilyBaseUrl !== 'https://api.tavily.com') {
    throw new Error('slack_core_unexpected_search_endpoint');
  }
}
