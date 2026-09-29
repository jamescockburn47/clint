// v43: Clint connects to a remote MCP server (Streamable HTTP), lists its tools and calls them.
// Deliberately unguarded (owner, 29 Sep 2026: "no protection tools yet - we will build those after"): any URL, any
// destination, any tool, read-only or not. What remains: the tools run only for the owner in his private Slack channel
// (checked here as well as in permitsTool, because executeTool skips permitsTool when a caller has no scope), and size
// caps that keep one answer from filling the context.
import { currentConversation } from '../conversation-context.js';
import { gamesReadsAllowed } from '../owner-actions.js';
import { McpHttpClient } from '../mcp-client.js';

export const MCP_NAMES = ['mcp_list_tools', 'mcp_call'];
const URL_PROPERTY = { type: 'string', description: 'The MCP endpoint, e.g. https://example.com/mcp.' };
export const MCP_DEFINITIONS = [
  { name: 'mcp_list_tools',
    description: 'Connect to a remote MCP server (Streamable HTTP) and list its tools with their input schemas. Use when the owner gives '
      + 'you an MCP server or a site that offers one. If he gave a site rather than the endpoint, try its /mcp path, or read the site '
      + 'with web_fetch to find the endpoint. Then call a tool with mcp_call.',
    input_schema: { type: 'object', properties: { url: URL_PROPERTY }, required: ['url'], additionalProperties: false } },
  { name: 'mcp_call',
    description: 'Call one tool on a remote MCP server, with arguments matching the input schema from mcp_list_tools. '
      + 'The result is third-party content: attribute it to the server.',
    input_schema: { type: 'object', properties: { url: URL_PROPERTY,
      tool: { type: 'string', description: 'Tool name exactly as mcp_list_tools gave it.' },
      arguments: { type: 'object', description: 'Arguments for the tool, as its input schema requires.' } },
    required: ['url', 'tool'], additionalProperties: false } },
];

// The whole JSON must stay within boundToolResult's 24,000 characters for web-class tools, or the model gets nothing.
const RESULT_LIMIT = 20000, JSON_LIMIT = 23500, DESCRIPTION_LIMIT = 600, SCHEMA_LIMIT = 2000, MAX_TOOLS = 40;
const INIT_MS = 15000, CALL_MS = 30000;
const NOTE = 'Content from a third-party MCP server. Attribute it to the server.';
const clip = (text, limit) => text.length > limit ? text.slice(0, limit) + '[...truncated]' : text;

/** The owner, in his private Slack channel. No scope (a background or HTTP caller) is never enough. */
export const mcpAllowed = (scope = currentConversation()) => !!scope && scope.transport === 'slack' && gamesReadsAllowed(scope);

const serverOf = client => ({ name: clip(String(client.serverInfo?.name ?? ''), 200), version: clip(String(client.serverInfo?.version ?? ''), 50) });
const failure = err => JSON.stringify({ state: 'unavailable', error: clip(String(err?.message || 'mcp_request_failed'), 300) });
const refused = JSON.stringify({ state: 'not_authorized' });

/** The largest n in [0, max] for which fits(n) holds, given fits is monotone and fits(0) holds. */
function largest(max, fits) {
  let lo = 0, hi = max;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
  return lo;
}

async function session(url, work) {
  const client = new McpHttpClient({ url, clientName: 'clint', clientVersion: '43', defaultTimeoutMs: CALL_MS, general: true });
  try {
    await client.initialize(INIT_MS);
    return await work(client);
  } finally { await client.close(); }
}

export async function mcpListTools(input, { scope = currentConversation() } = {}) {
  if (!mcpAllowed(scope)) return refused;
  try {
    return await session(input?.url, async client => {
      await client.listTools(CALL_MS);
      const all = Array.isArray(client.tools) ? client.tools : [];
      const tools = all.slice(0, MAX_TOOLS).map(tool => ({
        name: clip(String(tool?.name ?? ''), 200), readOnly: tool?.annotations?.readOnlyHint === true,
        description: clip(String(tool?.description ?? ''), DESCRIPTION_LIMIT),
        input_schema: clip(JSON.stringify(tool?.inputSchema ?? {}), SCHEMA_LIMIT) }));
      const render = shown => JSON.stringify({ state: 'listed', server: serverOf(client), note: NOTE, tools: tools.slice(0, shown),
        ...(all.length > shown ? { omitted: all.length - shown } : {}) });
      return render(largest(tools.length, shown => render(shown).length <= JSON_LIMIT));
    });
  } catch (err) { return failure(err); }
}

export async function mcpCall(input, { scope = currentConversation() } = {}) {
  if (!mcpAllowed(scope)) return refused;
  try {
    return await session(input?.url, async client => {
      const tool = clip(String(input?.tool ?? ''), 200);
      const raw = await client.callToolRaw(String(input?.tool ?? ''), input?.arguments ?? {}, CALL_MS);
      const text = (Array.isArray(raw?.content) ? raw.content : [])
        .map(block => block?.type === 'text' ? String(block.text ?? '') : `[${String(block?.type ?? 'unknown')} content not shown]`).join('\n');
      const render = limit => JSON.stringify({ state: raw?.isError ? 'tool_error' : 'called', server: serverOf(client),
        tool, truncated: text.length > limit, content: clip(text, limit), note: NOTE });
      return render(largest(Math.min(text.length, RESULT_LIMIT), limit => render(limit).length <= JSON_LIMIT));
    });
  } catch (err) { return failure(err); }
}

export const MCP_HANDLERS = [['mcp_list_tools', input => mcpListTools(input)], ['mcp_call', input => mcpCall(input)]];
