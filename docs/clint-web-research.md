# Source-controlled web research

The live v11 path keeps the owner-authorized contextual search policy and fixed outbound
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

The v12 increment connects public PDF, DOCX and XLSX responses to the same isolated
document worker used by Google Drive. Supported MIME types permit up to 20 MB; ordinary
text and unknown MIME types retain the 512 KB network cap. Declared and streamed sizes
are checked. Partial HTTP responses, unsupported formats, compressed transfer content
and declared non-UTF8 text fail explicitly. No parser runs with Slack credentials.

Document pages include rawSha256, representation, completeExtraction, limitations and
available page/OCR/unread-page or sheet metadata. Source hashes cover the raw bytes,
extracted text, representation and final URL. The maximum continuation offset is two
million characters, matching the extractor's output bound. Complete extraction refers to
the reported representation, not visual understanding or factual verification. Diagrams,
handwriting, layout and OCR still need checking against the original; text-page images,
attachments and dynamically rendered content are not established.

The candidate passed an actual service-UID/group/mount/network-namespace read of the
versioned 26-page GraphRAG paper, including continuation with matching hashes. That probe
did not share the Slack process cgroup; the existing extraction worker retained its own
resource limits. No model inference or Slack message was involved. See the independent
review and public-document-candidate-proof-20260914.json in ../evidence.

Teaching remains experimental and disconnected after its failed v10 behavioral screen.
No inference that better retrieval creates general factual reliability is warranted.
