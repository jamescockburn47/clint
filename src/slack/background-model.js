import { inferenceBudget, FLASH_MODEL, checkFlashContext } from '../inference-policy.js';

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
        chat_template_kwargs: { enable_thinking: true }, stream: false };
      if (config.modelId === FLASH_MODEL) await checkFlashContext(config.modelUrl, body, fetchFn, requestSignal);
      const response = await fetchFn(config.modelUrl + '/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('background_model_unavailable'); }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2097152) throw new Error('background_model_response_too_large');
          chunks.push(value);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const choice = data.choices?.[0];
        if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' ||
            !choice.message.content.trim()) throw new Error('background_model_incomplete');
        return choice.message.content;
      } finally { await reader.cancel(); reader.releaseLock(); }
    };
    const pending = queue.then(run);
    queue = pending.catch(() => {}); // Preserve rejection for the caller; later work can still be cancelled.
    return pending;
  };
}
