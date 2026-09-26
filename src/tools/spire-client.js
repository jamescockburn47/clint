/** The known Spire JSON HTTP MCP dialect; writes are never retried. */
export class SpireAuthorizationDenied extends Error {
  constructor() { super('spire_authorization_denied'); this.name = 'SpireAuthorizationDenied'; }
}
export async function callSpire(spire, name, args, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(spire.url, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${spire.key}`, 'content-type': 'application/json',
        accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    if (response.status === 401 || response.status === 403) {
      controller.abort(); // Discard the untrusted denial body; the status is authoritative.
      throw new SpireAuthorizationDenied();
    }
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw Error('spire_http_failure');
    const reader = response.body?.getReader();
    if (!reader) throw Error('spire_missing_body');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 24000) throw Error('spire_response_limit');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (reply.jsonrpc !== '2.0' || reply.id !== 1 || reply.error || !reply.result ||
        !Array.isArray(reply.result.content)) throw Error('spire_invalid_response');
    return reply.result;
  } finally { clearTimeout(timer); }
}
