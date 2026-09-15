# Clint: grounded personalization and live sources

Deployed for authorized owner testing on 14 September: release `c1335e8c0868bab2` / v5,
on the existing Qwen backend. The private snapshot is enabled in the exact two-member
`clint-private` channel. Source SHA, service-identity reads, both read-only archive mounts,
Slack authentication/membership and fresh runtime observations passed live checks.
The next owner message supplies the post-upgrade delivery probe; no test Slack message was sent.
This preserves the shared core and Slack transport; WhatsApp remains retired. It does not
establish complete or consistently correct recall, personality adaptation or live account access.

## Behavior

`src/behavior-profile.js` retains an offline candidate for helpful conversation, practical
mentoring, evidence-led challenge and contextual warmth. Its sources are James's current
instructions and the provisional, source-linked mentoring observations already recorded in
`clint-personalization.md`. It contains no raw transcript extracts or private biographical
facts. It is **not** the promised exhaustive ChatGPT/Claude personality synthesis.

**Personality activation is withheld.** Actual Qwen outputs invented James having seen a
prototype and supplied unsupported extraction-reliability criteria; one calibration revision
failed to cure both defects. A six-case isolated Claude trial improved some factual discipline
but still invented assurances. The profile is therefore not appended by `getSystemPrompt`.
The regression check prevents its accidental inclusion. Complete synthetic outputs and fresh
independent verdicts are retained in `../evidence/behavior-comparison-20260914.md` and
`../evidence/independent-behavior-review-20260914.md`. Indexing, repairs and source-access
implementation are not a successful personality release. The full mirror objective remains open.

The old unconditional web-search rule conflicted with private recall and normal conversation.
The revised prompt selects the relevant evidence source. Requested documents must be complete;
the Slack adapter now rejects model output marked truncated instead of silently delivering it.

## Source access

The runtime has three read-only archive tools: `knowledge_status`, `knowledge_search` and
`knowledge_read`. Search returns up to three reconstructed normalised source records, each
with source, speaker role, recorded date (nullable), original reference, archive hash and
the identifiers of all indexed parts. Reading any returned part ID reconstructs the record.
Missing/inconsistent parts or records above 12,000 UTF-16 units are explicitly unavailable.
Normalised records are not necessarily whole original messages or conversations. Tool delivery
preserves valid JSON within 24,000 characters; oversized searches omit whole records with
their IDs, and oversized individual reads fail intact. Qualifiers are never silently clipped.
Search is lexical FTS, not proof of exhaustive recall. The initial snapshot covers 76,065
chunks from the preserved ChatGPT and Claude visible text fields, WhatsApp records, all six
spoken files and recent ChatGPT app retrieval. Source dates/roles and unresolved attribution
remain separate; machine summaries and assistant messages are not James's own conduct.

Every archive result carries `evidenceType: archive_snapshot`, a separate import timestamp
and explicit `verification` fields: current state and external truth have not been checked;
authorship is a source label; assistant statements are not independent corroboration.
Import time never upgrades an older message's date or verifies that its contents remain true.
This metadata is deterministic; model compliance with it still requires output evaluation.

Private source snapshots stay outside Git at `../evidence/personalization/`. The v3 normalized
JSONL and SQLite snapshot are the current source snapshot; the SQLite copy is deployed. These do not include non-text attachments,
model thinking/tool payloads or the inventoried local coding sessions. Originals remain intact.
The full semantic analysis and cross-model reconciliation have not been completed. Indexing
and a successful behavioral probe cannot substitute for that work.

Archive tools require an issued conversation context that is owner-authenticated, private and
locally inferred. Missing scope, a non-owner or a restricted channel fails before opening the DB.
In Slack, explicit `mode: open` additionally requires the verified owner and bot to be the only
two channel members, with no incomplete membership page. This is checked before generation,
successful sending and failure notices. Slack cannot atomically check and send; administrators
must keep the channel private, and a later added member may see its existing history.

Archive-capable requests cannot use general external web/search or council query tools. This
is enforced in the common tool gate, including planner execution. The fixed GitHub lookup below
remains allowed because source text cannot control its destination or arguments. If wider live
research is needed alongside private archives, design a separate public-query boundary rather
than removing this restriction. Colleague mode retains public research, but the deployed
private channel now uses open mode and therefore denies general external web tools.

## Actual live Git knowledge

`repository_status(id="clint")` queries GitHub's official read-only API on demand for the
operator-registered public `jamescockburn47/clawd-admin` repository. It sends no token, arbitrary
query, branch, file path or archive text. Input is a strict enum, redirects are rejected, and
both request time and response size are bounded. It returns the observation time, default branch,
five recent commits, original commit dates and links. Errors return unavailable, not a stale value.
Successful reads identify a published-repository observation and mark deployment, local working
tree and code behavior unchecked; commit messages remain author reports. Failed reads carry
`observedAt: null` and a separate `attemptedAt`, with published-branch verification unavailable.

The 14 September probe found published `main` still at `6bcd928` (16 June). The local
`codex/clint-overhaul` commits from September have **not** become GitHub knowledge merely because
they exist on Windows. The tool expressly does not certify local/unpushed state or deployment.
Commit/push remains an owner-authorized action. Additional repos require an operator-reviewed
registration; private repos would need a scoped GitHub App or read-only token for the actual service.
The Codex app's GitHub connector credentials are not automatically available to Clint.

Reference: [GitHub List commits, including Contents read permission and public access](https://docs.github.com/en/rest/commits/commits).

## ChatGPT, Claude and coding-session updates

Supported account exports provide refreshable snapshots. The full saved ChatGPT export ends
17 February 2026; partial app retrieval reaches 7 September. Claude export reaches 13 September.
James said to proceed with these because the requested newer ChatGPT export has not arrived.
No general personal-account live-history API was established in this review. Model APIs do not
give Clint automatic access to the web products' conversation histories.

[ChatGPT export documentation](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)
and [Claude export documentation](https://support.claude.com/en/articles/9450526-export-your-claude-data)
describe the supported snapshot route. Once a new export arrives, preserve it, validate coverage,
reconcile stable message IDs and build a new snapshot; do not append duplicates to the old one.
Local Codex/Claude Code logs are a feasible next source for current project work, but their
human messages, injected context, tool output and subagent messages need distinct attribution.
The bounded 14 September local schema audit found 166 tool-result records among 201
user-role records in three Claude Code sessions, plus generated notifications; sampled
Codex user records also included injected environment/policy text. Role alone cannot
identify James. See the [local source contract](../../evidence/local-coding-source-contract-20260914.md);
no importer is activated by that structural inspection.
Nothing here silently scrapes authenticated consumer sessions or installs a background uploader.

## Verification and activation

`npm run verify` is the canonical check, including synthetic fixtures for every archive adapter,
role/correction counterexamples, unchanged-original rejection, Unicode chunk integrity, disabled
memory, diagnostics, Slack membership and fixed-destination GitHub reads. Runtime: Node 22.20.0;
normalization uses Python's standard library (tested on Windows Python 3.13 and EVO Python 3.12).

Preparation commands (new destination paths only):

```text
python scripts/normalize-archives.py PRIVATE_EVIDENCE_DIR NEW_NORMALIZED_JSONL
node scripts/build-knowledge.mjs NEW_NORMALIZED_JSONL NEW_SQLITE_SNAPSHOT
node scripts/knowledge-live-probe.mjs NEW_SQLITE_SNAPSHOT
```

Publication refuses existing destinations, validates every row and SQLite integrity, then
publishes atomically. On a failed normalization, any partial file is explicitly named partial;
it does not replace an existing source or active index. Original text is never rewritten.

The canonical source stage and upgrade path remain in `clint-slack-release.md`. James authorized
the current build and private archive for testing. The installed snapshot has SHA-256
`2936b3c93450c95b3b1565106c9a8b009c60705ac277f9600726fd8cec073a93`.
Preserved v4, configuration, runtime/inbox and archive backups are under
`/var/backups/clint-slack/c1335e8c0868bab2`. Rollback restores the previous release and policy,
retaining compatible acknowledged inbox rows rather than overwriting new events.
No automatic learning, service timer or cloud corpus transfer is enabled by this change.

During owner testing, inspect the actual private Slack first-use journey: source question -> attributed
answer -> follow-up chunk/recall -> controlled restart, with no duplicate delivery. The synthetic
probe is necessary behavioral evidence but is not that live Slack entry journey. Keep source
correctness and privacy separate from James's judgment of whether a reply sounds like him.

Fresh `system_status` now observes the serving alias, host/CPU, Linux-managed/available RAM,
GPU allocation/use and current deployed release. Unmeasured installed physical capacity and
gateway-hidden model build/context remain null. It does not load a model to inspect it.
Independent actual-output review passed the technical answer against the captured tool result,
but the wider capability screen still failed: file-input and background-learning claims exceeded
the evidence. Preserve this split verdict. See `../evidence/independent-runtime-description-review-20260914.md`.
# 15 September query-word preservation

The v21 candidate removes an undocumented first-twelve-unique-words cutoff from
archive search. Every recognized term in the already validated 300-character query
now reaches the quoted literal OR expression. A distinguishing entity at the end of
a longer query is no longer discarded solely because of its position.

Search remains SQLite FTS5/BM25 with the same result and complete-record limits.
This does not add semantic, graph or live-account retrieval, and it does not establish
that the model will use retrieved evidence correctly. Source records, qualifiers,
attribution and the immutable snapshot remain unchanged. Focused regression checks
cover late terms, movement across the old cutoff, 100 terms in 299 characters,
overlength rejection and quoted FTS/SQL metacharacters. A local aggregate-only cost
probe on the existing snapshot took23–431ms for three fixed queries; that is not a
general recall benchmark or a latency guarantee.
