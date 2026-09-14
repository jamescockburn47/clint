import config from '../config.js';
import logger from '../logger.js';
import { currentConversation } from '../conversation-context.js';
import { fetchPublicText } from '../public-web-fetch.js';
import { domainRestrictions, allowedSearchResult } from './search-domains.js';
import { validPageRequest, webPage } from './web-page.js';

export async function webFetch({ url, offset = 0, source_hash: sourceHash }) {
  if (!url) return 'URL is required.';
  if (!validPageRequest(offset, sourceHash)) return JSON.stringify({ state: 'invalid_page_request',
    instruction: 'Use offset 0 initially; continuation requires the previous sourceHash and nextOffset.' });
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 15000);

    const publicResult = currentConversation() ? await fetchPublicText(url) : null;
    const res = publicResult ? { ok: publicResult.status >= 200 && publicResult.status < 300,
      status: publicResult.status, headers: { get: () => publicResult.contentType },
      text: async () => publicResult.text, json: async () => JSON.parse(publicResult.text),
    } : await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Clawdbot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) return `Failed to fetch URL (HTTP ${res.status}).`;

    const contentType = res.headers.get('content-type') || '';
    if (!/^text\//i.test(contentType) && !/^application\/(?:json|[\w.-]+\+json|xhtml\+xml|xml)(?:;|$)/i.test(contentType)) {
      return JSON.stringify({ state: 'unsupported_content_type', content: null,
        instruction: 'This reader supports text pages and JSON/XML, not binary documents or images.' });
    }
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
    if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) return JSON.stringify({ state: 'unsupported_text_encoding', content: null });

    // JSON — return formatted
    if (/^application\/(?:json|[\w.-]+\+json)(?:;|$)/i.test(contentType)) {
      const json = await res.json();
      const text = JSON.stringify(json, null, 2);
      return webPage(text, { url, finalUrl: publicResult?.finalUrl || res.url || url, offset, sourceHash });
    }

    let text = await res.text();

    if (/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
      // Remove non-content blocks
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
      text = text.replace(/<!--[\s\S]*?-->/g, '');

      // Try to extract the main content area
      const mainMatch = text.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
      if (mainMatch) {
        text = mainMatch[1];
      }

      // Preserve links: <a href="url">text</a> → text (url)
      text = text.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, linkText) => {
          const clean = linkText.replace(/<[^>]+>/g, '').trim();
          if (!clean) return '';
          // Skip internal anchors and javascript links
          if (href.startsWith('#') || href.startsWith('javascript:')) return clean;
          return `${clean} (${href})`;
        }
      );

      // Headings → markdown style
      text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, content) => {
        const clean = content.replace(/<[^>]+>/g, '').trim();
        return clean ? `\n## ${clean}\n` : '';
      });

      // List items
      text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
        const clean = content.replace(/<[^>]+>/g, '').trim();
        return clean ? `- ${clean}\n` : '';
      });

      // Paragraph breaks
      text = text.replace(/<\/p>/gi, '\n\n');
      text = text.replace(/<br\s*\/?>/gi, '\n');

      // Strip remaining tags
      text = text.replace(/<[^>]+>/g, ' ');

      // Collapse whitespace (preserve newlines)
      text = text.replace(/[ \t]+/g, ' ');
      text = text.replace(/\n{3,}/g, '\n\n');
      text = text.trim();
    }

    logger.info({ chars: text.length }, 'web_fetch complete');
    return webPage(text, { url, finalUrl: publicResult?.finalUrl || res.url || url, offset, sourceHash });
  } catch (err) {
    if (err.name === 'AbortError') return 'URL fetch timed out (15s).';
    return currentConversation() ? 'Web fetch failed or destination is not permitted.' : `Web fetch error: ${err.message}`;
  } finally { clearTimeout(timeout); }
}

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_CHARS = 1200;
const TAVILY_COOLDOWN_MS = 15 * 60 * 1000;
const TAVILY_COOLDOWN_STATUSES = new Set([401, 403, 429, 432]);
let tavilyCooldownUntil = 0;

function clampCount(count) {
  const raw = count == null ? 5 : Number(count);
  return Math.max(1, Math.min(10, Number.isNaN(raw) ? 5 : Math.trunc(raw)));
}

function formatResults(results, query) {
  if (results.length === 0) return `No results found for "${query}".`;
  return results
    .map((r, i) => {
      const snippet = (r.content || '').slice(0, MAX_CONTENT_CHARS);
      return `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippet}`;
    })
    .join('\n\n');
}

/**
 * Tavily — LLM-native search. Returns extracted page content in `content`
 * rather than a short SERP snippet, which means one call usually yields
 * citable evidence instead of a stub the caller has to follow up with
 * web_fetch. Returns null on any failure so the caller can fall back.
 */
async function searchTavily(query, n, restriction) {
  if (!config.tavilyApiKey) return null;
  if (Date.now() < tavilyCooldownUntil) {
    logger.warn({ cooldownUntil: new Date(tavilyCooldownUntil).toISOString() }, 'tavily search skipped during cooldown');
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.tavilyBaseUrl}/search`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.tavilyApiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: config.tavilySearchDepth,
        max_results: n,
        include_answer: false,
        ...(restriction.native.length ? { include_domains: restriction.native } : {}),
      }),
    });

    if (!res.ok) {
      await res.body?.cancel();
      logger.warn({ status: res.status }, 'tavily search non-2xx');
      if (TAVILY_COOLDOWN_STATUSES.has(res.status)) {
        tavilyCooldownUntil = Date.now() + TAVILY_COOLDOWN_MS;
      }
      return null;
    }

    const data = await res.json();
    const results = (data?.results || []).filter(result => allowedSearchResult(result, restriction)).slice(0, n);
    if (results.length === 0) return null;

    logger.info({ count: results.length }, 'web search via Tavily');
    return formatResults(results, query);
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('tavily search timed out');
    } else {
      logger.warn('tavily search error');
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * SearXNG — self-hosted on EVO. Fallback when Tavily is not configured,
 * fails, or returns zero results. Degrades when upstream engines are
 * rate-limited (Brave / DuckDuckGo / Google regularly suspend or CAPTCHA
 * SearXNG IP ranges); in practice the fallback returns `null` to signal
 * the caller should surface a "No results" string rather than pretend.
 */
async function searchSearxng(query, n, restriction) {
  const searxngUrl = config.evoSearxngUrl;
  const narrowed = restriction.native.length ? `(${restriction.native.map(domain => 'site:' + domain).join(' OR ')}) ${query}` : query;
  const url = `${searxngUrl}/search?q=${encodeURIComponent(narrowed)}&format=json&pageno=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'searxng non-2xx');
      return null;
    }

    const data = await res.json();
    const results = (data?.results || []).filter(result => allowedSearchResult(result, restriction)).slice(0, n);
    if (results.length === 0) {
      logger.warn({
        unresponsive: data?.unresponsive_engines?.length || 0,
      }, 'searxng returned zero results');
      return null;
    }

    logger.info({ count: results.length }, 'web search via SearXNG');
    return formatResults(results, query);
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('searxng timed out');
    } else {
      logger.warn('searxng error');
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function webSearch({ query, count, include_domains: includeDomains = undefined }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) return 'Invalid search query; no search was sent.';
  const n = clampCount(count);
  let restriction;
  try { restriction = domainRestrictions(query, includeDomains); }
  catch { return 'Invalid source restriction. Use up to eight domain names, without schemes, ports or paths; no search was sent.'; }

  // Tavily primary — LLM-native content extraction, one call = usable evidence.
  const tavilyResult = await searchTavily(query, n, restriction);
  if (tavilyResult) return tavilyResult;

  // SearXNG fallback.
  const searxngResult = await searchSearxng(query, n, restriction);
  if (searxngResult) return searxngResult;

  return 'Search unavailable or returned no usable results. This does not establish that no relevant sources exist.';
}
