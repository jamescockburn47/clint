/** Explicit budgets for the single-slot Flash service; thinking includes its final answer. */
export const FLASH_MODEL = 'qwen3.8-flash-next';
export const FLASH_CONTEXT = 131072;
export const THINKING_TOKENS = 32768;
export const ANSWER_TOKENS = 8192;
export const THINKING_TIMEOUT_MS = 30 * 60000;
export const ANSWER_TIMEOUT_MS = 15 * 60000;
export const RESEARCH_TIMEOUT_MS = 90 * 60000;

export function inferenceBudget(thinking) {
  return { maxTokens: thinking ? THINKING_TOKENS : ANSWER_TOKENS,
    timeoutMs: thinking ? THINKING_TIMEOUT_MS : ANSWER_TIMEOUT_MS };
}

/** Only the authenticated current message is passed here, never history or retrieved text. */
export function requestedThinking(text) {
  return /^(?:<@[A-Z0-9]+>\s*)?(?:clint[, :]*)?(?:think(?:ing)?(?: mode)?|use thinking mode)(?:\s*[:\n]\s*|\s+(?:for|about)\s+)\S/i.test(text.trim());
}

/** Count the actual rendered prompt, including tool schemas. Never silently trim evidence. */
export async function checkFlashContext(base, payload, fetchFn, signal) {
  const post = async (path, body) => {
    const response = await fetchFn(base + path, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('flash_context_check_failed'); }
    return response.json();
  };
  const rendered = await post('/apply-template', { messages: payload.messages,
    ...(payload.tools ? { tools: payload.tools } : {}), chat_template_kwargs: payload.chat_template_kwargs });
  if (typeof rendered.prompt !== 'string') throw new Error('flash_context_check_failed');
  const tokenized = await post('/tokenize', { content: rendered.prompt, add_special: true });
  if (!Array.isArray(tokenized.tokens)) throw new Error('flash_context_check_failed');
  const count = tokenized.tokens.length;
  // Reserve the full thinking allowance even on ordinary turns, plus template/tokenizer margin.
  if (count + THINKING_TOKENS + 1024 > FLASH_CONTEXT) throw new Error('flash_context_budget_exceeded');
  return count;
}
