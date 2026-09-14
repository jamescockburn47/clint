import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

/**
 * Tavily tests need to inject a non-empty `tavilyApiKey` without mutating
 * the singleton config module. esmock overrides the config import inside
 * the search module for the lifetime of the mocked import.
 */
async function loadWithTavilyKey(overrides = {}) {
  const base = {
    tavilyApiKey: 'test-tavily-key',
    tavilyBaseUrl: 'https://api.tavily.test',
    tavilySearchDepth: 'basic',
    evoSearxngUrl: 'http://localhost:8888',
  };
  const mod = await esmock('../src/tools/search.js', {
    '../src/config.js': { default: { ...base, ...overrides } },
  });
  return mod.webSearch;
}

describe('webSearch — Tavily primary', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('calls Tavily endpoint with bearer auth and returns formatted results', async () => {
    const webSearch = await loadWithTavilyKey();
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({
          results: [
            { title: 'Tavily Hit', url: 'https://example.com/x', content: 'Extracted page content — much richer than a snippet.' },
          ],
        }),
      };
    };

    const result = await webSearch({ query: 'preflight checks reliability', count: 3 });

    assert.equal(fetchCalls.length, 1, 'should only hit Tavily, not fall back');
    assert.ok(fetchCalls[0].url.includes('api.tavily.test/search'));
    assert.equal(fetchCalls[0].init.method, 'POST');
    assert.equal(fetchCalls[0].init.headers.authorization, 'Bearer test-tavily-key');
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.query, 'preflight checks reliability');
    assert.equal(body.max_results, 3);
    assert.equal(body.search_depth, 'basic');
    assert.ok(result.includes('1. Tavily Hit'));
    assert.ok(result.includes('Extracted page content'));
  });

  it('falls through to SearXNG when Tavily returns no results', async () => {
    const webSearch = await loadWithTavilyKey();
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('api.tavily.test')) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'Searxng Hit', url: 'https://example.com/s', content: 'Fallback snippet' }],
        }),
      };
    };

    const result = await webSearch({ query: 'q', count: 2 });
    assert.equal(urls.length, 2, 'should call Tavily then SearXNG');
    assert.ok(urls[0].includes('api.tavily.test'));
    assert.ok(urls[1].includes('localhost:8888'));
    assert.ok(result.includes('Searxng Hit'));
  });

  it('falls through to SearXNG when Tavily returns non-2xx', async () => {
    const webSearch = await loadWithTavilyKey();
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.tavily.test')) {
        return { ok: false, status: 429, text: async () => 'rate limited' };
      }
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'SearXNG hit', url: 'https://example.com/s', content: 'x' }],
        }),
      };
    };

    const result = await webSearch({ query: 'q' });
    assert.ok(result.includes('SearXNG hit'));
  });

  it('temporarily skips Tavily after a quota or rate-limit response', async () => {
    const webSearch = await loadWithTavilyKey();
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('api.tavily.test')) {
        return { ok: false, status: 432, text: async () => 'usage limit' };
      }
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'SearXNG hit', url: 'https://example.com/s', content: 'x' }],
        }),
      };
    };

    await webSearch({ query: 'first' });
    const second = await webSearch({ query: 'second' });

    assert.ok(second.includes('SearXNG hit'));
    assert.equal(urls.filter((url) => url.includes('api.tavily.test')).length, 1);
    assert.equal(urls.filter((url) => url.includes('localhost:8888')).length, 2);
  });

  it('falls through to SearXNG when Tavily throws', async () => {
    const webSearch = await loadWithTavilyKey();
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.tavily.test')) throw new Error('DNS fail');
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'SearXNG hit', url: 'https://example.com/s', content: 'x' }],
        }),
      };
    };

    const result = await webSearch({ query: 'q' });
    assert.ok(result.includes('SearXNG hit'));
  });

  it('returns generic no-results when both Tavily and SearXNG return nothing', async () => {
    const webSearch = await loadWithTavilyKey();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const result = await webSearch({ query: 'nothing' });
    assert.match(result, /no usable results.*does not establish/);
  });

  it('truncates oversized Tavily content to the per-result cap', async () => {
    const webSearch = await loadWithTavilyKey();
    const longContent = 'a'.repeat(5000);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [{ title: 't', url: 'https://example.com', content: longContent }],
      }),
    });

    const result = await webSearch({ query: 'q' });
    // 1200-char cap per result — well under the raw 5000.
    const contentSection = result.split('\n').slice(2).join('\n');
    assert.ok(contentSection.length <= 1400, `content was ${contentSection.length} chars, expected <=1400`);
  });
});
