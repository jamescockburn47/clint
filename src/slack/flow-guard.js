// v44 flow guard: every tool call in a Slack conversation's LLM loop passes here (claude.js imports this as executeTool).
// Deterministic, whatever the model does or has been told:
//   1. URL provenance — web_fetch may open only a URL the owner typed in the message being answered, or one that appeared
//      verbatim in a tool result in this conversation in the last 24 hours. Clint cannot compose a URL, so it cannot append
//      data to one. (Search first, then open a result.)
//   2. Leak guard — a request that reaches a server an attacker could run (web_fetch, mcp_*) is refused if its input, raw or
//      decoded, alone or joined with the turn's earlier such text, carries a span of private tool output (39+ normalised
//      characters) the owner did not type himself. web_search is checked only after flagged/unscanned content, or when it is
//      aimed (include_domains or site:) at a domain the owner did not name: otherwise its queries go to the search provider,
//      which a page author cannot read directly, so the owner can ask Clint to research details from his own records (v45).
//   3. After untrusted content the injection classifier flagged or could not scan: MCP only at a URL the owner typed now.
//   4. After any untrusted content in the turn, no tool that writes, except the owner's own task list (local, reversible);
//      owner-approved MCP tools the server does not mark read-only are refused likewise, in mcp-tools.js (FIDES P-T, coarse).
// The URL checked is the URL sent: web_fetch receives the canonical form that matched.
// Stated residuals (not closed):
// - private context that never came from a tool (Slack history, earlier exchanges, memory, the system prompt) is not
//   fingerprinted; the leak guard knows only tool results;
// - private data in web_search queries, verbatim or not: they go to Tavily, a third party that keeps them (SearXNG fallback);
//   indirectly, a site's search-console query reports and which result links come back can reveal something of a query;
// - text an injected page gets saved into a task can come back later through task_read as if private (owner-visible list);
// - paraphrased or re-encoded private data (beyond the decodings in leak-guard.js) in MCP arguments to a server the owner added;
// - which known URL is opened is itself a signal (a hostile page listing many links): in every turn (history and memory
//   are always private context), at most MAX_UNTRUSTED_FETCHES links not typed by the owner may be opened, which bounds but
//   does not close it;
// - pieces of private text under 39 characters sent across turns, or within a turn with filler between them or out of order;
// - instructions laundered through Clint's own earlier replies; the two background pipelines that call tools directly
//   (slack/proactive-research.js web searches, slack/nightly-papers.js).
import { executeTool } from '../tools/handler.js';
import { currentConversation } from '../conversation-context.js';
import { LeakGuard, strings } from './leak-guard.js';
import { scanUntrusted, scannable } from './injection-guard.js';
import { turnState as turn } from './turn-state.js';
import logger from '../logger.js';

export const OUTBOUND = new Set(['web_search', 'web_fetch', 'mcp_list_tools', 'mcp_call']);
const UNTRUSTED = new Set(['web_search', 'web_fetch', 'mcp_list_tools', 'mcp_call']);
const MCP = new Set(['mcp_list_tools', 'mcp_call']);
/** Tools that only read. Anything else is refused once the turn holds untrusted content. */
const READS = new Set(['knowledge_search', 'knowledge_read', 'knowledge_status', 'repository_status', 'system_status',
  'calendar_list_calendars', 'calendar_read_events', 'calendar_free_time', 'drive_search', 'drive_read', 'google_read_status',
  'soul_read', 'memory_search', 'task_list', 'task_read', 'proactive_status', 'proactive_report', 'admission_log',
  'steads_status', 'moorstead_status', 'spire_health', 'web_search', 'web_fetch', 'mcp_list_tools', 'mcp_call']);
/** The owner's own task list: local and reversible; stays writable after untrusted content. */
const OWNER_VISIBLE_WRITES = new Set(['task_save', 'task_set_status']);
/** Outbound calls whose arguments reach a server an attacker could run, so they pass the leak guard. */
const LEAK_CHECKED = new Set(['web_fetch', 'mcp_list_tools', 'mcp_call']);
const URL_TTL_MS = 24 * 3600 * 1000, MAX_UNTRUSTED_FETCHES = 6;

export const leakGuard = new LeakGuard();
const seenUrls = new Map(); // conversationId -> Map(url -> expiry)
const refuse = (reason, detail) => JSON.stringify({ state: 'refused', reason, detail });

const TRAILING = /[.,;:!?)\]}'"]+$/;
/** The URL as it will be sent. No punctuation is stripped here: what is compared is exactly what goes out. */
export function canonical(raw) {
  try { const u = new URL(String(raw)); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; }
  catch { return null; }
}
/** URLs written in text: Slack links (<https://x|label>) and bare http(s) URLs. */
export function urlsIn(text) {
  const out = new Set();
  const body = String(text ?? '');
  const add = raw => { for (const form of [raw, raw.replace(TRAILING, '')]) { const c = canonical(form); if (c) out.add(c); } };
  for (const [, link] of body.matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/gi)) add(link);
  // Written-out URLs: both as written and without sentence punctuation, so "see https://x/a." and "Foo_(bar)" both work.
  for (const [raw] of body.matchAll(/https?:\/\/[^\s"'<>|\\`]+/gi)) add(raw);
  return out;
}
/** Remember URLs found verbatim in tool results (exported for tests). */
export function rememberUrls(conversationId, texts, now = Date.now()) {
  const map = seenUrls.get(conversationId) ?? new Map();
  for (const text of texts) for (const url of urlsIn(text)) map.set(url, now + URL_TTL_MS);
  for (const [url, expires] of map) if (expires <= now) map.delete(url);
  seenUrls.set(conversationId, map);
}
/** A URL the owner typed in this message, or one seen verbatim in a tool result in this conversation in the last 24 h. */
export function urlKnown(url, scope, now = Date.now()) {
  const c = canonical(url);
  if (!c) return false;
  if (urlsIn(scope.originalRequest).has(c)) return true;
  return (seenUrls.get(scope.conversationId)?.get(c) ?? 0) > now;
}

/** The part of a call's input that can carry new data: a known URL (owner-typed or seen verbatim) cannot, so it is left out. */
const checkedInput = (name, input, scope) => (name === 'web_fetch' && urlKnown(input?.url, scope) ? { ...input, url: undefined } : input);

/** A search restricted to a domain the owner did not name (include_domains or site:) can land in that site's reports. */
function aimedElsewhere(input, scope) {
  const named = [...urlsIn(scope.originalRequest)].map(url => new URL(url).hostname.toLowerCase());
  const domains = [...(Array.isArray(input?.include_domains) ? input.include_domains : []),
    ...[...String(input?.query ?? '').matchAll(/\bsite:([^\s/]+)/gi)].map(m => m[1])].map(d => String(d).toLowerCase());
  return domains.some(domain => !named.some(host => host === domain || host.endsWith('.' + domain)));
}

/** The reason a call is refused before it runs, or null. */
export function precheck(name, input, scope, state = turn(scope)) {
  if (state.untrusted && !READS.has(name) && !OWNER_VISIBLE_WRITES.has(name)) {
    return ['untrusted_content_restricts_writes', 'This turn has read untrusted web or MCP content. No tool that acts may run now.'];
  }
  if (name === 'web_fetch' && !urlKnown(input?.url, scope)) {
    return ['url_not_from_owner_or_results', 'web_fetch opens only a URL the owner gave in his message or one found verbatim in a '
      + 'search or page result. Search for it first, or ask the owner for the link.'];
  }
  if (name === 'web_fetch' && state.private && !urlsIn(scope.originalRequest).has(canonical(input?.url))
      && state.fetchedAfterPrivate >= MAX_UNTRUSTED_FETCHES) {
    return ['fetch_limit_after_private_read', `At most ${MAX_UNTRUSTED_FETCHES} links from results may be opened in one message. `
      + 'Ask again in a new message, or give the link.'];
  }
  if (MCP.has(name) && state.tainted && !urlsIn(scope.originalRequest).has(canonical(input?.url))) {
    return ['untrusted_content_restricts_mcp', `Earlier untrusted content in this turn was ${state.tainted} by the injection guard. `
      + 'MCP only at a URL the owner typed in this message.'];
  }
  if (LEAK_CHECKED.has(name) || (name === 'web_search' && (state.tainted || aimedElsewhere(input, scope)))) {
    // A known URL (owner-typed or seen verbatim) cannot carry new data, so it is not itself checked: a long calendar or archive
    // link can be opened. Every other field is.
    const checked = checkedInput(name, input, scope);
    const texts = [...strings(checked), JSON.stringify(checked ?? null)];
    if (leakGuard.leaks(scope.conversationId, [...texts, [...state.outbound, ...texts].join(' ')], scope.originalRequest || '')) {
      return ['private_data_in_outbound_request', 'The request carries text from a private source (archive, calendar, Drive, memory, '
        + 'tasks) that the owner did not type. It was not sent.'];
    }
  }
  return null;
}

const NO_CONTENT = new Set(['refused', 'unavailable', 'not_authorized']);
/** A result that carries no third-party content: a refusal, an error, a denial. */
function contentless(result) {
  if (/^(Tool denied|Tool error|Unknown tool)/.test(result)) return true;
  try { return NO_CONTENT.has(JSON.parse(result)?.state); } catch { return false; }
}

/** The host of a listing that matched the report the owner saw at mcp add (set by mcp-tools.js), or null. */
function pinnedCleanHost(name, result) {
  if (name !== 'mcp_list_tools') return null;
  try { const host = JSON.parse(result)?.pinnedCleanHost; return typeof host === 'string' && host ? host : null; } catch { return null; }
}

/** Scan an untrusted result; MCP results carry their own scan verdict, set by mcp-tools. */
async function verdict(name, result) {
  if (MCP.has(name)) {
    try { return JSON.parse(result)?.scan?.state ?? 'unscanned'; } catch { return 'unscanned'; }
  }
  return (await scanUntrusted([scannable(result)])).state;
}

export async function guardedExecuteTool(name, input, senderJid, chatJid) {
  const scope = currentConversation();
  if (scope?.transport !== 'slack') return executeTool(name, input, senderJid, chatJid);
  const state = turn(scope);
  const blocked = precheck(name, input, scope, state);
  if (blocked) {
    logger.warn({ tool: name, reason: blocked[0], requestId: scope.requestId }, 'flow guard refused a tool call');
    return refuse(...blocked);
  }
  if (LEAK_CHECKED.has(name)) state.outbound.push(...strings(checkedInput(name, input, scope))); // what was checked, so a known URL is not held against later calls
  if (name === 'web_fetch') {
    if (state.private && !urlsIn(scope.originalRequest).has(canonical(input?.url))) state.fetchedAfterPrivate++;
    input = { ...input, url: canonical(input.url) }; // send exactly the URL that was checked
  }
  const result = await executeTool(name, input, senderJid, chatJid);
  return noteToolResult(name, result, scope, state);
}

/** After a tool ran: remember URLs, fingerprint private results, and mark or scan untrusted content (exported for tests). */
export async function noteToolResult(name, result, scope, state = turn(scope)) {
  if (typeof result !== 'string') return result;
  rememberUrls(scope.conversationId, [result]);
  if (UNTRUSTED.has(name)) {
    if (contentless(result)) return result;
    const cleanHost = pinnedCleanHost(name, result);
    if (cleanHost) { state.cleanListingHosts.add(cleanHost); return result; }
    state.untrusted = true;
    const found = await verdict(name, result);
    if (found !== 'clean' && !state.tainted) {
      state.tainted = found;
      logger.warn({ tool: name, verdict: found, requestId: scope.requestId }, 'flow guard: untrusted content restricts the rest of the turn');
    }
  } else {
    state.private = true;
    leakGuard.recordResult(scope.conversationId, result);
  }
  return result;
}
