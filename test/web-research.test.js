import { test } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { domainRestrictions, allowedSearchResult } from '../src/tools/search-domains.js';
import { webPage, validPageRequest } from '../src/tools/web-page.js';

test('Domain constraints intersect query and explicit scopes and reject deceptive host suffixes', () => {
  const policy = domainRestrictions('reference site:docs.example.org', ['example.org']);
  assert.equal(allowedSearchResult({ url: 'https://docs.example.org/reference' }, policy), true);
  for (const url of ['https://example.org', 'https://docs.example.org.attacker.test', 'https://evildocs.example.org',
    'https://docs.example.org@attacker.test', 'javascript:alert(1)']) {
    assert.equal(allowedSearchResult({ url }, policy), false, url);
  }
  for (const values of [['https://example.org'], ['example.org/path'], ['127.0.0.1'], ['localhost'], Array(9).fill('example.org')]) {
    assert.throws(() => domainRestrictions('reference', values), /invalid_search_domains/);
  }
  assert.throws(() => domainRestrictions('reference site:example.org/path'), /invalid_search_domains/);
  for (const query of ['reference site:', 'reference (site:docs.example.org)', 'reference -site:example.org', 'reference "site:example.org"']) {
    assert.throws(() => domainRestrictions(query), /invalid_search_domains/);
  }
});

test('Native domains are transmitted and fallback results cannot broaden requested scope', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const { webSearch } = await esmock('../src/tools/search.js', {
    '../src/config.js': { default: { tavilyApiKey: 'synthetic-key', tavilyBaseUrl: 'https://search.test',
      tavilySearchDepth: 'basic', evoSearxngUrl: 'http://localhost:8888' } },
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body && JSON.parse(init.body) });
    return { ok: true, json: async () => ({ results: String(url).startsWith('https://')
      ? [{ title: 'Outside', url: 'https://other.test', content: 'Rejected' }]
      : [{ title: 'Deceptive', url: 'https://docs.example.org.attacker.test', content: 'Rejected' },
        { title: 'Allowed', url: 'https://docs.example.org/reference', content: 'Kept' }] }) };
  };
  const result = await webSearch({ query: 'reference', include_domains: ['docs.example.org'] });
  assert.deepEqual(calls[0].body.include_domains, ['docs.example.org']);
  assert.equal(calls.length, 2); assert.match(decodeURIComponent(calls[1].url), /site:docs.example.org/);
  assert.match(result, /Allowed/); assert.doesNotMatch(result, /Outside|Deceptive/);
  calls.length = 0;
  await webSearch({ query: 'reference', include_domains: ['example.org/path'] });
  assert.equal(calls.length, 0);
});

test('Page continuation reconstructs full content, requires source hash and detects changed source or redirect', () => {
  const text = 'First paragraph.\n'.repeat(1200) + 'Final finding 427.';
  const first = JSON.parse(webPage(text, { url: 'https://example.org' }));
  assert.equal(first.content.length, 8000); assert.equal(first.nextOffset, 8000);
  assert.equal(validPageRequest(first.nextOffset), false);
  assert.equal(validPageRequest(first.nextOffset, first.sourceHash), true);
  let assembled = first.content, offset = first.nextOffset;
  while (offset !== null) {
    const page = JSON.parse(webPage(text, { url: 'https://example.org', offset, sourceHash: first.sourceHash }));
    assembled += page.content; offset = page.nextOffset;
  }
  assert.equal(assembled, text);
  for (const options of [{}, { finalUrl: 'https://example.org/moved' }]) {
    const changed = JSON.parse(webPage(options.finalUrl ? text : text + ' changed',
      { url: 'https://example.org', offset: 8000, sourceHash: first.sourceHash, ...options }));
    assert.equal(changed.state, 'source_changed'); assert.equal(changed.content, null);
  }
  assert.equal(JSON.parse(webPage(text, { url: 'https://example.org', offset: 999999 })).state, 'offset_out_of_range');
});

test('Actual fetch entry rejects invalid continuation before I/O and preserves public fetch path', async () => {
  let calls = 0;
  const { webFetch } = await esmock('../src/tools/search.js', {
    '../src/conversation-context.js': { currentConversation: () => ({ transport: 'slack' }) },
    '../src/public-web-fetch.js': { fetchPublicText: async () => {
      calls++; return { status: 200, contentType: 'text/html', finalUrl: 'https://example.org/final',
        text: '<main><p>' + 'z'.repeat(9000) + '</p></main>' };
    } },
  });
  assert.equal(JSON.parse(await webFetch({ url: 'https://example.org', offset: 8000 })).state, 'invalid_page_request');
  assert.equal(calls, 0);
  const first = JSON.parse(await webFetch({ url: 'https://example.org' }));
  const next = JSON.parse(await webFetch({ url: 'https://example.org', offset: first.nextOffset, source_hash: first.sourceHash }));
  assert.equal(first.content + next.content, 'z'.repeat(9000));
  assert.equal(next.finalUrl, 'https://example.org/final'); assert.equal(calls, 2);
});

test('Binary pages and explicitly non-UTF8 pages are not labelled extracted text', async () => {
  let type = 'application/pdf';
  const { webFetch } = await esmock('../src/tools/search.js', {
    '../src/conversation-context.js': { currentConversation: () => ({ transport: 'slack' }) },
    '../src/public-web-fetch.js': { fetchPublicText: async () => ({ status: 200, contentType: type, text: '%PDF binary' }) },
  });
  assert.equal(JSON.parse(await webFetch({ url: 'https://example.org/file' })).state, 'unsupported_content_type');
  type = 'text/html; charset=ISO-8859-1';
  assert.equal(JSON.parse(await webFetch({ url: 'https://example.org/file' })).state, 'unsupported_text_encoding');
});
