export const WEB_DEFINITIONS = [
  { name: 'web_search', description: 'Search current sources; results are snippets, not full-page verification. Use include_domains for requested or primary-source restrictions. Restrictions also apply to fallback results.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Search query. Bare-domain site: restrictions are enforced; site paths are unsupported.' },
      count: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results; default 5.' },
      include_domains: { type: 'array', maxItems: 8, items: { type: 'string' },
        description: 'Optional allowed domains, e.g. docs.python.org; exact domain and subdomains. No schemes, ports or paths.' },
    }, required: ['query'] } },
  { name: 'web_fetch', description: 'Read a public page as extracted text with source hash/date. Returns up to 8,000 characters and nextOffset. Continue using the same URL, nextOffset as offset and sourceHash as source_hash. If source_changed, restart rather than combine versions. Images/attachments/dynamic content are not established.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'Full public URL.' },
      offset: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Character offset; default 0.' },
      source_hash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Previous sourceHash; required when offset is positive.' },
    }, required: ['url'] } },
];
