import { inferenceBudget, FLASH_MODEL, checkFlashContext } from '../inference-policy.js';
import { backgroundResponse } from '../overnight/model-response.js';

/** Cancellable thinking synthesis. Foreground messages cancel this request. */
export function backgroundChat(config, signal, fetchFn = fetch) {
  let queue = Promise.resolve();
  return (system, input, maxTokens = 800) => {
    void maxTokens; // Legacy final-answer hints must not cap the reasoning allowance.
    const run = async () => {
      signal.throwIfAborted();
      const budget = inferenceBudget(true);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(budget.timeoutMs)]);
      const body = { model: config.modelId,
        messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
        max_tokens: budget.maxTokens, temperature: 0.3,
        chat_template_kwargs: { enable_thinking: true }, stream: true };
      if (config.modelId === FLASH_MODEL) await checkFlashContext(config.modelUrl, body, fetchFn, requestSignal);
      const response = await fetchFn(config.modelUrl + '/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('background_model_unavailable'); }
      return backgroundResponse(response);
    };
    const pending = queue.then(run);
    queue = pending.catch(() => {}); // Preserve rejection for the caller; later work can still be cancelled.
    return pending;
  };
}
