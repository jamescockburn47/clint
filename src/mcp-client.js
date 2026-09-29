// A minimal MCP client over Streamable HTTP, no SDK and no dependencies — just
// the global fetch. It speaks MCP JSON-RPC directly: initialize / tools/list /
// tools/call, plus the notifications/initialized handshake.
//
// Built to talk to servers shaped like The Spire's own endpoint
// (relay/mcp-http.mjs): they answer with plain application/json (never SSE) and
// key their session by the bearer token — so there is no Mcp-Session-Id dance to
// perform. Any other MCP-over-HTTP server that follows the same shape works too;
// this is Clint's general "add an MCP server by URL" capability, not a Spire
// one-off.
//
// With `general: true` (v43, any MCP server) the client also takes an SSE
// answer (returning as soon as it arrives, even if the stream stays open),
// checks that a JSON answer is the answer to the request, carries the server's
// Mcp-Session-Id and protocol version, caps the bytes it reads, releases every
// response body and ends the session on close(). The Spire path keeps its
// original behaviour.
import logger from './logger.js';

const PROTOCOL_VERSION = '2025-06-18';
const GENERAL_MAX_BYTES = 1_000_000;

const isAnswer = (message, id) => !!message && typeof message === 'object' && message.id === id && ('result' in message || 'error' in message);

/** The JSON-RPC answer to `id`: from the complete events of an SSE body, or a whole JSON body. Throws if there is none. */
export function parseRpcBody(text, contentType, id) {
  if (!/text\/event-stream/i.test(contentType || '')) {
    let message;
    try { message = JSON.parse(text); } catch { throw new Error('mcp_invalid_answer'); }
    if (!isAnswer(message, id)) throw new Error('mcp_invalid_answer');
    return message;
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    let message;
    try { message = JSON.parse(data); } catch { continue; } // A non-JSON event is not an answer; keep looking.
    if (isAnswer(message, id)) return message;
  }
  throw new Error('mcp_no_answer_in_stream');
}

/** Read a general-mode answer within the byte cap. An SSE answer is returned as soon as its event is complete. */
async function readAnswer(res, id, max) {
  const contentType = res.headers.get('content-type') || '';
  const sse = /text\/event-stream/i.test(contentType);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('mcp_invalid_answer');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.length;
        if (size > max) throw new Error('mcp_response_too_large');
        text += decoder.decode(value, { stream: true });
      }
      if (sse && !done) {
        const end = Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('\r\n\r\n'));
        if (end >= 0) {
          try { return parseRpcBody(text.slice(0, end), contentType, id); }
          catch (err) { if (err.message !== 'mcp_no_answer_in_stream') throw err; }
        }
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(err => logger.debug?.({ err: err.message }, 'mcp response release failed (non-fatal)'));
  }
  return parseRpcBody(text + decoder.decode(), contentType, id);
}

export class McpHttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url — the MCP endpoint (query string allowed, e.g. ?name=Clint)
   * @param {Record<string,string>} [opts.headers] — extra headers (e.g. Authorization)
   * @param {string} [opts.clientName]
   * @param {string} [opts.clientVersion]
   * @param {number} [opts.defaultTimeoutMs] — used when a call passes no timeout
   */
  constructor({ url, headers = {}, clientName = 'clawd', clientVersion = '1.0.0', defaultTimeoutMs = 70000, general = false }) {
    this.url = url;
    this.headers = headers;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.general = general;
    this.sessionId = null;
    this.initialized = false;
    this._id = 0;
    this.serverInfo = null;
    this.tools = [];
  }

  _generalHeaders() {
    return { ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.initialized ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}) };
  }

  async _post(payload, timeoutMs) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        accept: this.general ? 'application/json, text/event-stream' : 'application/json',
        ...(this.general ? this._generalHeaders() : {}),
        ...this.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeoutMs),
    });
    if (this.general) this.sessionId = res.headers.get('mcp-session-id') || this.sessionId;
    return res;
  }

  /** A request/response JSON-RPC call. Throws on transport, auth, or RPC error. */
  async _rpc(method, params, timeoutMs) {
    const id = ++this._id;
    const res = await this._post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
    if (this.general && !res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new Error('mcp_server_requires_authorisation_not_supported');
      throw new Error(`MCP ${method} HTTP ${res.status}`);
    }
    if (res.status === 401) throw new Error(`unauthorized (401) on ${method} — check the bearer key`);
    if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}`);
    const body = this.general
      ? await readAnswer(res, id, GENERAL_MAX_BYTES)
      : await res.json().catch(() => ({}));
    if (body.error) throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  /** A fire-and-forget notification (no id, server answers 202 with no body). */
  async _notify(method, params, timeoutMs = 8000) {
    try {
      const res = await this._post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
      if (this.general) await res.body?.cancel();
    } catch (err) {
      logger.debug?.({ err: err.message, method }, 'mcp notify failed (non-fatal)');
    }
  }

  async initialize(timeoutMs = 15000) {
    const result = await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    }, timeoutMs);
    this.serverInfo = result?.serverInfo || null;
    this.initialized = true;
    await this._notify('notifications/initialized');
    return result;
  }

  async listTools(timeoutMs = 15000) {
    const result = await this._rpc('tools/list', {}, timeoutMs);
    this.tools = result?.tools || [];
    return this.tools;
  }

  /** The raw tools/call result, unparsed (general use: the caller decides how to read content). */
  async callToolRaw(name, args = {}, timeoutMs) {
    return this._rpc('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** General mode: end the server-side session. Best effort; a failure is logged, not raised. */
  async close(timeoutMs = 5000) {
    if (!this.general || !this.sessionId) return;
    try {
      const res = await fetch(this.url, { method: 'DELETE', headers: { ...this._generalHeaders(), ...this.headers },
        signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
    } catch (err) {
      logger.debug?.({ err: err.message }, 'mcp session close failed (non-fatal)');
    }
  }

  /**
   * Call a tool. Returns { data, isError, raw }, where `data` is the parsed JSON
   * of the first text content block (servers like The Spire encode their tool
   * results as a JSON string), or { text } when the block isn't JSON, or {} when
   * there is no text block.
   */
  async callTool(name, args = {}, timeoutMs) {
    const raw = await this._rpc('tools/call', { name, arguments: args }, timeoutMs);
    const textBlock = raw?.content?.find((c) => c?.type === 'text')?.text;
    let data = {};
    if (textBlock !== undefined) {
      try { data = JSON.parse(textBlock); } catch { data = { text: textBlock }; }
    }
    return { data, isError: !!raw?.isError, raw };
  }
}
