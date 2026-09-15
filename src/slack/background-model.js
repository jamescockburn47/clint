/** Cancellable, bounded local synthesis. Foreground messages cancel this request. */
export function backgroundChat(config, signal, fetchFn = fetch) {
  let queue = Promise.resolve();
  return (system, input, maxTokens = 800) => {
    const run = async () => {
      signal.throwIfAborted();
      const response = await fetchFn(config.modelUrl + '/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.modelId,
          messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
          max_tokens: Math.min(maxTokens, 1200), temperature: 0.3,
          chat_template_kwargs: { enable_thinking: false }, stream: false }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('background_model_unavailable'); }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128000) throw new Error('background_model_response_too_large');
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
