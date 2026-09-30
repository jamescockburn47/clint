// Which MCP servers the owner has added, the tool definitions pinned when Clint first connected, and the tools the owner has
// allowed by name. Trust comes only from the owner's commands, handled in code before the model runs (quick-commands.js):
//   "Clint, mcp add <https link>"             — exactly one link; trusts that host for 30 days; connects and pins its tools;
//   "Clint, mcp allow <link> <tool> [tool..]" — the owner approves tools the server does not mark read-only;
//   "Clint, mcp deny <link> <tool> [tool..]"  — withdraws that approval;
//   "Clint, mcp remove <link>"                — forgets the host at once;  "Clint, mcp list" — shows what is added.
// ("@Clint" works in place of "Clint,".) Nothing else trusts a host: not sharing or discussing a link, not the model. A tool
// whose definition changed after it was pinned, or that appeared after pinning, cannot be called until the owner adds the
// server again, which re-pins and clears the owner's approvals (he reviews the new definitions).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { domainToASCII } from 'node:url';

const TRUST_TTL_MS = 30 * 24 * 3600 * 1000;
/** First line of every add report. History and stored exchanges replace a Clint message starting with it (server text). */
export const MCP_REPORT_MARK = 'MCP server report:';
const COMMAND = /^\s*(?:(?:@?clint|<@[UW][A-Z0-9]+>)[\s,:]*)\s*mcp\s+(add|remove|allow|deny|list)\b/i;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

const hostOf = raw => { try { const u = new URL(raw); const h = domainToASCII(u.hostname.replace(/\.$/, '')); return h ? { protocol: u.protocol, host: h.toLowerCase(), href: u.href } : null; } catch { return null; } };

/** Links the owner wrote: Slack link targets (<http(s)://host/path|label>) and written-out http(s) URLs outside <...>. */
export function linksIn(text) {
  const out = [];
  for (const [, link] of String(text || '').matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/gi)) { const l = hostOf(link); if (l) out.push(l); }
  for (const [raw] of String(text || '').replace(/<[^>]*>/g, ' ').matchAll(/https?:\/\/[^\s<>|]+/gi)) { const l = hostOf(raw); if (l) out.push(l); }
  return out;
}
/** Hosts named as web links in the text (not bare words, file names or mailto). IDN hosts compare in punycode. */
export const hostsNamed = text => new Set(linksIn(text).map(link => link.host));

/** { action, host, url, tools } | { error } for an owner MCP command, or null when the text is not one. */
export function parseMcpCommand(text) {
  const match = COMMAND.exec(String(text || ''));
  if (!match) return null;
  const action = match[1].toLowerCase();
  if (action === 'list') return { action };
  const rest = String(text).slice(match.index + match[0].length);
  const links = linksIn(rest);
  const hosts = new Set(links.map(link => link.host));
  if (hosts.size !== 1) return { error: `Send exactly one link: Clint, mcp ${action} <https://server/mcp>${['allow', 'deny'].includes(action) ? ' <tool>' : ''}` };
  if (action === 'add' && links.some(link => link.protocol !== 'https:')) return { error: 'MCP servers must use https.' };
  const tools = rest.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/gi, ' ').split(/[\s,]+/).filter(Boolean);
  if (['allow', 'deny'].includes(action) && (!tools.length || !tools.every(name => TOOL_NAME.test(name)))) {
    return { error: `Name the tools after the link: Clint, mcp ${action} <https://server/mcp> tool_one tool_two` };
  }
  return { action, host: links[0].host, url: links.find(link => link.protocol === 'https:')?.href ?? links[0].href, tools };
}

export const toolDigest = tool => createHash('sha256').update(JSON.stringify([tool?.name ?? null, tool?.description ?? null,
  tool?.inputSchema ?? null, tool?.annotations ?? null])).digest('hex');

export class McpTrust {
  /** @param {string|null} path — JSON file; null keeps the store in memory only. */
  constructor(path, { now = Date.now } = {}) { this.path = path; this.now = now; this.data = { hosts: {} }; this.loaded = false; }

  static forScope(scope) {
    return new McpTrust(scope?.taskStorePath ? join(dirname(scope.taskStorePath), 'mcp-trust.json') : null);
  }

  load() {
    if (this.loaded || !this.path) { this.loaded = true; return this.data; }
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!this.data || typeof this.data.hosts !== 'object') throw new Error('mcp_trust_store_invalid');
    this.loaded = true;
    return this.data;
  }

  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }

  current(host) {
    const entry = this.load().hosts[host];
    return entry && Date.parse(entry.addedAt) + TRUST_TTL_MS > this.now() ? entry : null;
  }

  /** The owner's "mcp add": trust this host for 30 days; tools are pinned on first connection; earlier approvals are cleared. */
  add(host, url = null) { this.load().hosts[host] = { addedAt: new Date(this.now()).toISOString(), url, tools: null, allowed: [], reviewed: false }; this.save(); }

  /** The add report listing every pinned tool was shown to the owner. Only then does a matching listing count as reviewed. */
  markReviewed(host) { const entry = this.current(host); if (entry && entry.tools) { entry.reviewed = true; this.save(); } }

  reviewed(host) { return this.current(host)?.reviewed === true; }

  /** The owner's "mcp remove": forget this host now. True if it was trusted. */
  remove(host) { const had = !!this.load().hosts[host]; if (had) { delete this.data.hosts[host]; this.save(); } return had; }

  /** The owner's "mcp allow"/"mcp deny": { changed, unknown } — only pinned tools of a current host can be allowed. */
  setAllowed(host, names, allow) {
    const entry = this.current(host);
    if (!entry || !entry.tools) return null;
    const unknown = names.filter(name => !Object.hasOwn(entry.tools, name));
    const known = names.filter(name => Object.hasOwn(entry.tools, name));
    const set = new Set(entry.allowed ?? []);
    for (const name of known) { if (allow) set.add(name); else set.delete(name); }
    entry.allowed = [...set].sort();
    this.save();
    return { changed: known, unknown };
  }

  /** Added hosts, newest first: { host, addedAt, expired, pinned, allowed }. */
  list() {
    return Object.entries(this.load().hosts).map(([host, entry]) => ({ host, addedAt: entry.addedAt, expired: !this.current(host),
      pinned: entry.tools ? Object.keys(entry.tools).length : null, allowed: entry.allowed ?? [] }))
      .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  }

  /** { allowed, host, reason } for this URL: https, the host added by the owner within the last 30 days, and exactly the
   *  endpoint he added (origin, path, query; a trailing slash is ignored). An entry without a stored endpoint trusts nothing. */
  authorise(url) {
    const link = hostOf(url);
    if (!link || link.protocol !== 'https:') return { allowed: false };
    const entry = this.current(link.host);
    const endpoint = raw => { try { const u = new URL(raw); return u.origin + u.pathname.replace(/\/+$/, '') + u.search; } catch { return null; } };
    if (!entry || !entry.url) return { allowed: false, host: link.host, reason: 'not_added' };
    return endpoint(entry.url) === endpoint(url) ? { allowed: true, host: link.host }
      : { allowed: false, host: link.host, reason: 'other_endpoint', endpoint: entry.url };
  }

  /** Whether the owner allowed this tool by name on this host. */
  ownerAllowed(host, name) { return !!this.current(host)?.allowed?.includes(name); }

  /** Pin the listed tools on first use after "mcp add"; afterwards report which tools differ from the pins. */
  pin(host, tools) {
    const entry = this.load().hosts[host];
    if (!entry) return new Map(tools.map(tool => [String(tool?.name), 'server_not_added']));
    if (entry.tools === null) {
      entry.tools = Object.fromEntries(tools.map(tool => [String(tool?.name), toolDigest(tool)]));
      this.save();
    }
    return new Map(tools.map(tool => { const name = String(tool?.name); const pin = Object.hasOwn(entry.tools, name) ? entry.tools[name] : null;
      return [name, pin === toolDigest(tool) ? 'pinned' : pin ? 'changed_since_added' : 'new_since_added']; }));
  }
}
