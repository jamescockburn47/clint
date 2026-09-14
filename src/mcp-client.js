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
import logger from './logger.js';

const PROTOCOL_VERSION = '2025-06-18';

export class McpHttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url — the MCP endpoint (query string allowed, e.g. ?name=Clint)
   * @param {Record<string,string>} [opts.headers] — extra headers (e.g. Authorization)
   * @param {string} [opts.clientName]
   * @param {string} [opts.clientVersion]
   * @param {number} [opts.defaultTimeoutMs] — used when a call passes no timeout
   */
  constructor({ url, headers = {}, clientName = 'clawd', clientVersion = '1.0.0', defaultTimeoutMs = 70000 }) {
    this.url = url;
    this.headers = headers;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this._id = 0;
    this.serverInfo = null;
    this.tools = [];
  }

  async _post(payload, timeoutMs) {
    return fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeoutMs),
    });
  }

  /** A request/response JSON-RPC call. Throws on transport, auth, or RPC error. */
  async _rpc(method, params, timeoutMs) {
    const id = ++this._id;
    const res = await this._post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
    if (res.status === 401) throw new Error(`unauthorized (401) on ${method} — check the bearer key`);
    if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (body.error) throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  /** A fire-and-forget notification (no id, server answers 202 with no body). */
  async _notify(method, params, timeoutMs = 8000) {
    try {
      await this._post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
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
    await this._notify('notifications/initialized');
    return result;
  }

  async listTools(timeoutMs = 15000) {
    const result = await this._rpc('tools/list', {}, timeoutMs);
    this.tools = result?.tools || [];
    return this.tools;
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
