// Which MCP servers the owner has added, and the tool definitions pinned the first time Clint connected after he added them.
// Trust comes only from the owner's commands, handled in code before the model runs (quick-commands.js):
//   "Clint, mcp add <https link>" or "@Clint mcp add <https link>" — exactly one link; trusts that host for 30 days;
//   "Clint, mcp remove <link>" — deletes the host at once.
// Nothing else trusts a host: not sharing or discussing a link, not the model. A tool whose definition changed after it was
// pinned, or that appeared after pinning, cannot be called until the owner adds the server again (which re-pins on first use).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { domainToASCII } from 'node:url';

const TRUST_TTL_MS = 30 * 24 * 3600 * 1000;
const COMMAND = /^\s*(?:(?:@?clint|<@[UW][A-Z0-9]+>)[\s,:]*)\s*mcp\s+(add|remove)\b/i;

const hostOf = raw => { try { const u = new URL(raw); const h = domainToASCII(u.hostname.replace(/\.$/, '')); return h ? { protocol: u.protocol, host: h.toLowerCase() } : null; } catch { return null; } };

/** Links the owner wrote: Slack link targets (<http(s)://host/path|label>) and written-out http(s) URLs outside <...>. */
export function linksIn(text) {
  const out = [];
  for (const [, link] of String(text || '').matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/gi)) { const l = hostOf(link); if (l) out.push(l); }
  for (const [raw] of String(text || '').replace(/<[^>]*>/g, ' ').matchAll(/https?:\/\/[^\s<>|]+/gi)) { const l = hostOf(raw); if (l) out.push(l); }
  return out;
}
/** Hosts named as web links in the text (not bare words, file names or mailto). IDN hosts compare in punycode. */
export const hostsNamed = text => new Set(linksIn(text).map(link => link.host));

/** { action: 'add' | 'remove', host } | { error } for an owner MCP command, or null when the text is not one. */
export function parseMcpCommand(text) {
  const match = COMMAND.exec(String(text || ''));
  if (!match) return null;
  const action = match[1].toLowerCase();
  const links = linksIn(String(text).slice(match.index + match[0].length));
  const hosts = new Set(links.map(link => link.host));
  if (hosts.size !== 1) return { error: `Send exactly one link: Clint, mcp ${action} <https://server/mcp>` };
  if (action === 'add' && links.some(link => link.protocol !== 'https:')) return { error: 'MCP servers must use https.' };
  return { action, host: [...hosts][0] };
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

  /** The owner's "mcp add": trust this host for 30 days; its tools are pinned on first use. */
  add(host) { this.load().hosts[host] = { addedAt: new Date(this.now()).toISOString(), tools: null }; this.save(); }

  /** The owner's "mcp remove": forget this host now. True if it was trusted. */
  remove(host) { const had = !!this.load().hosts[host]; if (had) { delete this.data.hosts[host]; this.save(); } return had; }

  /** { allowed, host } for this URL: https, and the host added by the owner within the last 30 days. */
  authorise(url) {
    const link = hostOf(url);
    if (!link || link.protocol !== 'https:') return { allowed: false };
    const entry = this.load().hosts[link.host];
    return { allowed: !!entry && Date.parse(entry.addedAt) + TRUST_TTL_MS > this.now(), host: link.host };
  }

  /** Pin the listed tools on first use after "mcp add"; afterwards report which tools differ from the pins. */
  pin(host, tools) {
    const entry = this.load().hosts[host];
    if (!entry) return new Map(tools.map(tool => [String(tool?.name), 'server_not_added']));
    if (entry.tools === null) {
      entry.tools = Object.fromEntries(tools.map(tool => [String(tool?.name), toolDigest(tool)]));
      this.save();
    }
    return new Map(tools.map(tool => [String(tool?.name), entry.tools[String(tool?.name)] === toolDigest(tool) ? 'pinned'
      : entry.tools[String(tool?.name)] ? 'changed_since_added' : 'new_since_added']));
  }
}
