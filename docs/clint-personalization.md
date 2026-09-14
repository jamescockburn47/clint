# Learning James's working style and judgment

Status: full available corpus preparation underway; longitudinal model analysis and runtime
activation have not occurred. 13 September 2026. James explicitly rejected a small sample
as the analysis scope and asked to include Clint's WhatsApp history on the EVO.
James has asked whether ChatGPT and Claude can analyse his prompts/interactions so that
Clint behaves more like him. Preserve Clint as the custom agent; add an inspectable,
versioned behavior profile rather than replace identity with a generic personality prompt.

## Learn three distinct things

1. Communication: structure, directness, detail, humor and tone by audience and context.
2. Working method: how James frames problems, tests claims, prioritizes evidence, challenges
   assumptions, chooses depth and decides when to act or ask.
3. Preferences: which outcomes and trade-offs James chooses in a stated situation.

Keep factual knowledge and permissions separate. A preference is not evidence that a
claim is true. Predicting a likely choice does not authorize an action. The public Slack
agent remains identified as Clint; it may draft in James's style without silently sending
messages as James or treating simulated consent as real consent.

Prompts show requested assistant behavior more directly than the author's own conduct.
Use James-authored documents and messages, accepted edits and observed choices when
modelling how James would write or decide. Do not confuse quoted opponents' positions,
hypotheticals or assistant-generated prose with James's beliefs. Silence is not acceptance.

## Evidence and two-model analysis

Keep source archives locally in a private scope. Preserve speaker, date, thread, quotation
boundaries, correction sequence and the surrounding task. Analyse every available conversation
in bounded chunks, preserving whole episodes where possible and explicitly joining episodes
that cross a chunk boundary. Maintain a per-source coverage ledger: prepared, analysed by
each model, reconciled, or excluded with a concrete reason. Indexing is not semantic analysis.
Minimise/redact third-party and confidential material before cross-provider analysis; retain
the original privately and record the transformation. Do not post archives to LQ Slack.

Give ChatGPT and Claude the same eligible corpus independently. Each proposes concrete behavioral
rules with source IDs, applicability limits, explicit-versus-inferred labels, contradictory
examples and missing evidence. Then compare the proposals, preserving disagreement. A
second model is an additional interpretation, not independent evidence of what James meant.
Explicit current instructions outrank inferred patterns; task-specific rules stay scoped.

The deliverable must go beyond tone: problem framing, evidence thresholds, challenge and
disagreement, delegation, decisions under uncertainty, revision after correction, priorities,
humor, interpersonal adaptation, and differences between professional and personal contexts.
For every proposed pattern, retain original supporting episodes and counterexamples, context,
date range, and alternative explanations. Separate observed behavior, explicitly requested
assistant behavior, and inference. Record change over time instead of averaging it away.
Do not treat a repeated prompt, mirrored archive or recycled memory as independent support.
Synthesis passes compare all episode findings by context and period; retrieval examples alone
cannot stand in for the exhaustive first pass. Unresolved authorship stays unresolved.

Retain an example of desired behavior and a plausible bad example for each rule. Separate
stable preferences from temporary frustration or project-specific constraints. Do not make
clinical or demographic inferences, infer general risk appetite, copy typographical errors,
or optimize for flattery. A compressed prompt does not imply that all replies must be terse.

## Test behavior before activation

The central assumption is that the profile predicts useful behavior on unfamiliar tasks.
The earlier 20-episode proposal is superseded as an analysis scope. Historical corrections
and accepted edits can test whether a rule describes its source, but are not an unseen test
after full-history analysis. Freeze the resulting profile and test on subsequently acquired
interactions or new scenarios judged by James. Models cannot invent his preference answer key.
Evaluate by context and failure type; a strong aggregate score cannot hide failed attribution,
invented preferences, unauthorized action or inappropriate disclosure.

Compare baseline Clint with profile-enabled Clint using the same model and resources.
Inspect anonymized, order-randomized outputs for: reasoning approach, priorities, audience
fit and communication. Score source correctness and authorization independently. Retain
both fidelity failures and factual failures; sounding like James must not offset either.
Allow one evidence-led profile revision before revisiting the mechanism or corpus.

Only the approved profile and a few context-relevant examples enter task context. Raw
histories stay in their originating private scopes. Public style rules can be shared only
after review for disclosure; provenance links may themselves contain sensitive information.
Version profile changes and permit rollback. Correcting a style or workflow rule does not
alter the tool policy, confidentiality boundaries or model routing.

## Full-corpus acquisition and current coverage

Private development evidence is outside the agent Git worktree at
`../../evidence/personalization/`. These counts describe preparation, not completed analysis.

| Source | Discovered coverage | State and limits |
| --- | --- | --- |
| ChatGPT account export | 2,150 conversations; 13,682 user-role and 29,946 assistant messages; December 2022–17 February 2026 | All user/assistant nodes, including alternative branches, normalized; 1,338 non-text user parts remain referenced to the original export. User-role text is not automatically original writing. |
| Recent ChatGPT app retrieval | 13 conversations, 70 user messages and 66 assistant messages across 17 pages; conversation update dates 16 August–7 September 2026 | Saved privately with all returned pages. Only ChatGPT entries in the latest 50 mixed app tasks; two assistant blocks truncated at 20,000 characters. One explicit synthetic test must not become biographical evidence. |
| WhatsApp logs on EVO | 218 source files, 18,775 source rows; 13,455 records after merging 5,320 mirrored copies; 15 March–5 August 2026 | Originals copied byte-for-byte to private local evidence, hashes checked; every source row retains a reference. No claim of complete WhatsApp account history. |
| WhatsApp owner attribution | 1,722 records exactly match a configured owner sender ID; 894 have the bot flag; 10,839 remain unresolved human/other-agent records | Other people's and other agents' messages remain context, not evidence of James's behavior. Names alone do not verify an author. |
| Jason/Alex spoken conversations | Six complete discovered residency transcripts, 25 August–9 September 2026: four Jason, two Alex; 1,669 James-labelled speaker lines | Immutable byte-verified copies and source manifest prepared. Gemini summaries are excluded as evidence of verbatim speech. Existing redactions remain intact. |
| Clint memory store | 57,745 main-file rows plus 15,455 archive rows; 4,773 distinct exact fact texts across both | Derived evidence only; not 73,200 independent observations about James. Source strings have no obvious file/line/message locators in this inspection. |
| Claude Code on Windows | 89 main session files and 1,726 subagent files | Inventoried only. Subagent prose is not James's writing. Main sessions require role and boilerplate attribution. |
| Codex on Windows | 989 session files plus one archived file | Inventoried only; must distinguish human input from injected context and agent-generated sessions. |
| Supplied Claude profile | `JAMES-agent-profile.md`, 13 September 2026; 17,351 bytes | Preserved and read in full. A model interpretation based on memories/topic sampling, not primary transcripts or an instruction to install. Private review records concrete scope/provenance issues. |
| Claude account export | 463 conversations; 2,434 human and 2,413 assistant messages; 10 October 2023–13 September 2026 | All four declared parts readable and preserved. Every exported message indexed. Includes 22 projects/58 document records and separate memories; conversation-to-project association is not supplied in conversation fields. |
| Fresh ChatGPT account export | Not yet received | Export started: OpenAI email confirmation 13 September 2026, 19:20:40 UTC. The supplied Claude profile and Claude export do not replace it. |

The WhatsApp originals lack message IDs in the main collection. Only 4,674 main-log rows
contain sender IDs. Their timestamp field may be a logging time or an original backfilled
send time; preserve it without pretending the distinction is known. The old log collection
was entirely mirrored in the main collection; it adds provenance, not additional interactions.
Three invalid ChatGPT message timestamps were recorded rather than invented or silently fixed.
Access-denied directories encountered during discovery were not bypassed.

Source manifests, hashes, raw snapshots and coverage are in `inventory.json`, `coverage.json`,
`corpus-status.json`, `evo-inventory.json`, `evo-coverage.json`, `evo-provenance.json`,
`whatsapp-status.json`. That status file points to the complete immutable WhatsApp snapshot
directory, containing its own source manifest, original files and normalized corpus. Reruns
preserve previous snapshots and reject empty acquisition. `corpus-chatgpt.jsonl` and each
snapshot's `corpus-whatsapp.jsonl` retain episode/branch/thread and original-source references.
Neither corpus has completed its semantic model-analysis pass.

James subsequently required more recent ChatGPT data before further personality synthesis.
`chatgpt-refresh-status.json` records the fresh full-export request and confirmation, and
`recent-chatgpt-app-20260913/manifest.json` describes the partial recent source retrieval.
The February export is historical context, not adequate coverage of current behavior. The
new export's actual dates, roles, branches and attachment coverage must be checked on receipt;
reconcile overlapping records by identifiers rather than counting them twice. Do not present
the limited app retrieval as full February-to-September account coverage.

The Claude export is preserved in private `claude-export-20260913/originals/`. Its current
index and coverage are under `indexes/3746b85a9d175818a4491eb160711b7a60ac38b79dae93b338c8245fcb522b26/`.
The user-supplied `Unconfirmed 26000.crdownload` contains a structurally complete conversation
ZIP: central directory and CRC checks pass, and bytes were stable across validation. Its
original filename/content remain untouched; a content-addressed copy is retained. This does
not assert that the browser marked its download complete. No manifest download URLs were
followed or exposed in the coverage report.

All 4,847 messages retain their original archive and JSON-pointer references, raw timestamps
and parent IDs. A repeated root-like sentinel remains explicitly labelled as a candidate,
not silently rewritten. Tool output, model thinking, injected prompt blocks, quoted documents,
attachments and project files must not be attributed to James merely because they appear in
his account. The behavioral index excludes login metadata; the original metadata archive is
preserved privately. Corpus indexing is complete for these exported messages; semantic
analysis and proof of full account/project coverage are not.

James also explicitly authorized the Jason and Alex transcripts for actual spoken style.
The private `spoken-manifests/` register preserves source paths, content hashes, speaker-line
references and disclosure/analysis state; `spoken-originals/` preserves the complete files.
`spoken-style-notes.md` records the first substantive Codex read of the 9 September Jason
call, with source lines and counterexamples. All six remain in scope for both full model
passes. Separate machine-generated notes from transcribed speech, and James's own speech
from model output he reads aloud. Do not reconstruct the removed tax discussion in the
5 September Alex file. Transcripts alone cannot establish vocal tone or reliable pacing.
Mentoring style is a contextual mode, not automatically his behavior in every relationship.

The supplied Claude profile and metadata are preserved under private `supplied-claude/`;
`claude-profile-review.md` records its assessment. It mixes assistant preferences, observed
behavior and expressed factual/technical/legal positions. These must remain separate.
First-pass independent analysts should receive the underlying eligible episodes without
this profile or each other's findings; compare the supplied profile after those passes.
The current Codex review has seen it and is not a blind independent analysis. Its proposed
system prompt has no instruction authority and has not been activated.

## Provisional seed and actual model access

The source sample and first Codex interpretation are in the workspace's private development
evidence directory. They contain seven current-task excerpts, superseded as the project scope.
Provisional lessons include current research verification,
attention to fundamental causes, bounded autonomy and preserving Clint's custom core.
They do not establish James's broader personality or behavior with other people.

Claude was initially invoked through the EVO with tools, MCP, hooks and persistent sessions
disabled for this analysis. CLI version: 2.1.178. Authentication returned HTTP 401 because
the OAuth access token had expired. Reported model usage and cost were zero. No Claude
analysis or two-model agreement existed from that attempt. The Windows Claude CLI was also
signed out. Slack desktop authentication does not authenticate a separate Claude Code CLI installation.

Resolved on 13 September 2026 at 18:42 UTC: refreshed the existing EVO Claude Max OAuth login
over SSH, completing the browser flow on the Windows control machine. A real isolated model
request returned the exact expected `CLAUDE_EVO_AUTH_OK` response with no error. No private
corpus was included and no persistent model session was created. The redacted result is
`../../evidence/personalization/claude-auth-health.json`. Claude authentication no longer
blocks the independent analysis; the full analysis itself has not yet run.

## Source acquisition

Official account exports can supply actual history where supported. Check that the files
contain the intended conversations; do not assume summaries are the complete archive.
ChatGPT self-service export is unavailable in Business/Enterprise workspaces; their data
access is organization-managed. Claude exports are available through supported account
privacy controls. Account eligibility and source contents must be verified before ingestion.
Sources: [ChatGPT exports](https://help.openai.com/en/articles/7260999),
[Claude exports](https://support.claude.com/en/articles/9450526-export-your-claude-data).

No cross-provider bulk corpus transfer, Slack message, model fine-tuning or running Clint
profile activation has occurred. Claude CLI reauthentication is complete. Completing source
attribution, exhaustive model passes,
disagreement/contradiction synthesis and behavioral validation remain outstanding.
