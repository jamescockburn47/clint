export const EMBEDDING_URL = 'http://127.0.0.1:8083';
export const EMBEDDING_MODEL = 'Qwen3-Embedding-8B-Q8_0.gguf';
export const EMBEDDING_DIMENSIONS = 4096;
export const EMBEDDING_BUILD = 'b8646-0c58ba336';
export const QUERY_INSTRUCTION = 'Retrieve source passages relevant to the question, including corrections, explicit uncertainty and conflicting reports.';

export async function embeddingRequest(path, body, fetchFn = fetch) {
  const response = await fetchFn(EMBEDDING_URL + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('embedding_unavailable'); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512000) throw new Error('embedding_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export function normalizeVector(values) {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS ||
      values.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('invalid_embedding');
  const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('invalid_embedding_norm');
  return values.map(n => n / norm);
}

/** Tokenizer checks prevent the resident 2,048-token server silently clipping a passage. */
export async function passageSegments(text, request = embeddingRequest) {
  const data = await request('/tokenize', { content: text, add_special: true });
  if (!Array.isArray(data.tokens)) throw new Error('invalid_tokenizer_result');
  if (data.tokens.length <= 1792) return [text];
  const chars = Array.from(text);
  if (chars.length < 2) throw new Error('embedding_cannot_segment');
  const middle = Math.ceil(chars.length / 2);
  return [...await passageSegments(chars.slice(0, middle).join(''), request),
    ...await passageSegments(chars.slice(middle).join(''), request)];
}

export async function embedText(text, request = embeddingRequest) {
  const response = await request('/v1/embeddings', { input: text, encoding_format: 'float' });
  if (response.data?.length !== 1) throw new Error('invalid_embedding_count');
  return normalizeVector(response.data[0].embedding);
}

export async function verifyEmbeddingRuntime(request = embeddingRequest) {
  const props = await request('/props');
  const context = props.default_generation_settings?.n_ctx;
  if (String(props.model_path || props.model_alias).split(/[\\/]/).at(-1) !== EMBEDDING_MODEL ||
      props.build_info !== EMBEDDING_BUILD || !Number.isInteger(context) || context < 2048) {
    throw new Error('embedding_runtime_mismatch');
  }
}

export async function embedQuery(query) {
  await verifyEmbeddingRuntime();
  return embedText(`Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`);
}
