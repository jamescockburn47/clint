/** Startup contract: the planner/classifier/memory singleton must use the same local runtime. */
export function validateSlackCoreConfig(core, slack) {
  if (core.evoLlmUrl.replace(/\/$/, '') !== slack.modelUrl.replace(/\/$/, '') ||
      core.evoChatModel !== slack.modelId) throw new Error('slack_core_model_mismatch');
  for (const value of [core.evoLlmUrl, core.evoClassifierUrl, core.evoPlannerUrl, core.evoMemoryUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password) throw new Error('slack_core_requires_local_services');
  }
  // This process is a separate service; credential inheritance must be intentional.
  if (core.anthropicApiKey || core.minimaxApiKey || core.googleRefreshToken) {
    throw new Error('slack_core_unexpected_cloud_credentials');
  }
}
