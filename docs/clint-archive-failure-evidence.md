# Archive evidence when an answer cannot finish

In the issued private owner, local, read-only Slack conversation, an unfinished
model attempt can now include complete normalized archive records already returned
by knowledge_search or knowledge_read. The original failure notice remains explicit.
This is a deterministic quote fallback, not a synthesized answer or a new retrieval path.

Only actual tool results in the current request qualify. No history, model prose,
web payload or other tool can supply quotes. Payloads must identify a snapshot,
carry complete-record attribution and match their normalized-text SHA256. No source
is converted into an accepted personal fact. Speaker labels, unknown dates, source
references, indexed part IDs and snapshot dates remain visible. Every quoted text
line is prefixed to distinguish it from application text. Conflicting records stay
separate; identical copies are collapsed. Records whose rendered text triggers the
existing Slack control-marker boundary are omitted whole, preventing regeneration
or failed delivery without editing source text or weakening that boundary.

At most three complete records fit the bounded display. Oversized records are
omitted whole, and omissions from retrieval or packing are indicated if any records
are shown. This does not repair the existing oversized-record coverage gap. If no
valid record fits, the existing failure notice is returned alone. Included records
may be irrelevant and may not represent the entire original conversation.

The fallback makes no extra model call, performs no new read, and bypasses style
rewriting just like existing application notices. Normal completed answers remain
unchanged. Request-local state prevents cross-message carryover. Existing scoped
topic/canary filtering, final credential filtering, private channel reauthorization
and plaintext delivery still apply. Archive files and authorization remain unchanged.

Acceptance requires deterministic authority/bounds/hash/qualification regressions,
actual core integration with post-tool failure, no cross-request carryover, unchanged
normal answers, existing output restrictions and an installed synthetic inbox probe.
No claim of reliable free-form model grounding or deep teaching follows.
