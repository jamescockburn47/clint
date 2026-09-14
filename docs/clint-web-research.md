# Source-controlled web research

v11 candidate keeps the owner-authorized contextual search policy and fixed outbound
credential checks. Search snippets are leads; source-backed answers need page reading.

`web_search` accepts up to eight `include_domains`, as bare hostnames. It passes native
filters to Tavily and checks every returned URL's hostname locally, including SearXNG
fallback. Exact domains and their subdomains match; deceptive suffixes and userinfo do not.
Bare `site:domain` query syntax is also enforced. Unsupported forms (paths, negative or
quoted/parenthesized site operators, missing names) are rejected before search instead of
silently broadening. If both explicit domains and site operators exist, both constraints
must hold. Domain arguments pass the same outbound secret checks as query text.

`web_fetch` returns extracted text in 8,000-character pages with the requested/final URL,
observation date, sourceHash, totalCharacters and nextOffset. Continuation requires the
previous sourceHash. A changed text/redirect version returns source_changed and no content;
restart reading rather than combining versions. Each read retains public-IP validation,
DNS pinning and per-redirect validation. Content is bounded before decoding.

Binary pages, unknown MIME types, undecompressed transfer content and declared non-UTF8
text fail explicitly; they are not represented as extracted page text. The Google Drive
document worker separately supports PDF/Word/spreadsheet extraction. This web reader does
not yet send public binary documents to that worker. Images, attachments and dynamically
rendered content are not established by a text-page read.

Teaching remains experimental and disconnected after its failed v10 behavioral screen.
No inference that better retrieval creates general factual reliability is warranted.
