# Clint overhaul policy

Clint serves personal assistance and technical/research work equally. The EVO is
the execution host; this Windows worktree is the reviewable development source.

Current direction: preserve James's custom Clint core and add Slack; see
`docs/clint-slack-release.md`. LQ reached its app limit on 13 September, and James
chose `clint-qtj3570.slack.com` (T0C2CKVEPKJ) for the first Slack release.
LQ remains the preferred eventual workspace. This owner decision supersedes the
OpenClaw-first replacement proposal in the earlier architectural reset. Repair
durable task state, scoped recall and learning within Clint. The acceptance trial
still defines the behavioral proof needed; broader adaptation remains proposed,
not implemented. Do not present policy v1 below as the finished learning capability.
Keep existing safeguards until replacements pass.

The separate minimal-prompt pilot has been replaced in source by a shared-core
`src/slack/model.js` adapter. Release `c1335e8c0868bab2` (v5) is running on the EVO with
boot startup enabled. Its service identity, archive access, private membership and fresh
runtime observations passed live checks; post-upgrade owner-message delivery is pending.
The prior v4 release established actual Slack delivery/restart recall. See
`docs/clint-existing-control-audit.md`. Do not replace live EVO group policies with
repository defaults, or treat a non-WhatsApp ID as a private owner conversation.
James's messages in `clint-private` no longer require mentions; the exact
owner/channel restriction remains. Internal control markers are never deliverable replies.

14 September 2026 owner decision: WhatsApp is decommissioned. `clawdbot.service` and
`llama-server-main.service` are disabled on the EVO (both had been crash-looping since
31 August: logged-out session, missing GGUF); the WhatsApp auth state was archived to
`~/backups/` and removed. Slack is Clint's only conversational transport. WhatsApp-specific
regressions found in the 14 September review (group tool authority, `/debate` auth, Spire
floor audience, pairing recovery) are recorded in the review, not fixed. The source is now
committed on `codex/clint-overhaul` (base `6bcd928`); the 14 September changes (`v4`
adapter: attempt accounting for an unavailable core, classified Slack send failures,
thread notices for dropped messages, channel-level recall for top-level messages, error
codes in journal lines, private planner context and project names gated on
`permitsPrivateContext`, `EVO_MEMORY_ENABLED` honoured by the memory client, wider
credential guard, extract rejections separated from file errors, unverified statements at
confidence 0.5, no queued duplicates on promotion, sandbox-unavailable status) each carry
tests. Every "independent review" must leave an artifact (findings with file:line) in
`../evidence/`; a verdict string written by the deploying session is not a review.
Legacy ceilings for `src/claude.js`, `src/http-server.js`, `src/memory.js` and
`src/task-planner.js` were raised by the exact size of those bounded fixes.
The independent-review follow-up adds three memory disable guards (+3 lines) and
one safe diagnostic-code import each in `claude.js` and `task-planner.js` (+1 each);
their exact legacy ceilings include only those additions. Error messages remain
source data; diagnostic fields use an explicit machine-code/class allowlist.

Personalization direction: `docs/clint-personalization.md`. Learn source-linked,
context-specific behavior from James's interactions. Separate desired assistant behavior
from inferred personal conduct. A style/preference profile never grants authority or
certifies facts; no profile is active merely because a model proposed it.
The 14 September candidate profile failed actual-output trials and is excluded from
the release prompt. Preserve that failed verdict until a changed mechanism passes;
repairs and archive indexing do not complete the mirror objective.

The factual-state prototype in `src/knowledge/factual-state.js` is experimental and
disconnected from ingestion and Slack. Its source identity metadata is supplied by
synthetic fixtures; its semantic support check is model-dependent. Follow
`docs/clint-factual-state-trial.md` and actual-output evidence before integrating it.
Preserve v1–v4 failures in the trial reports; no factual-memory promotion follows
from deterministic checks. Current v4 requires a trusted James requester; absent,
other or unknown requesters fail before generation. This is not authentication.
With that correction, Qwen missed an unknown-to-negative distinction, GPT accepted
an instruction as completed use, and Gemma missed two temporal answers. None passed.
A whole-bundle Gemma selection revision also failed its six-case semantic screen.
The fresh challenge remains reserved. The later Flash Q4 streaming/lazy-table trial
loaded and performed short inference within the existing 96 GiB GPU partition.
Its exact-output serving prerequisite failed; factual comparison did not run. This
is not evidence of factual inferiority. All candidates were removed and original
chat, embedding and Slack services restored with actual probes at 16:22 UTC.
Raw-source hybrid retrieval is a separate synthetic experiment, not a new route to
promote facts or activate a personality profile. Evaluate final answers as well as
retrieval; preserve exact source records, attribution, scope and missing evidence.
Archive reconstruction and intact tool delivery are structural repairs, not proof
of recall or correct synthesis. No hybrid runtime is enabled by these experiments.

14 September owner instruction: avoid overfitting throughout. Freeze prompts,
settings, source fixtures and scoring before comparative trials. Development scores
are diagnostic and must never be reported as fresh validation. Do not tune against
the reserved challenge, rerun until a preferred answer appears, discard failures,
or combine outputs from separate runs into a passing result. After one evidence-led
revision, a failed mechanism needs a changed hypothesis rather than another prompt
patch. Use independent review of actual output and fresh, representative cases before
expansion; once a held-out case informs a change, it becomes development material.
Model selection across many candidates also consumes validation independence.
Preserve failed mechanisms and their limits even when a different component improves.

14 September runtime-description release: owner authorizes deploying reviewed current
changes for private Slack testing, including archive reads. Keep experimental factual
promotion/profile learning disconnected. Current tool schemas and fresh system_status
observations govern capability descriptions; never infer service health from a name.
Two added legacy lines in each of claude.js and tools/handler.js connect the new bounded
runtime module; their exact size ceilings increase by two. Rollback restores configuration
and archive selection with code while retaining compatible acknowledged inbox events.
The private archive is now enabled under open policy with exactly James and Clint in
the private unshared channel; general web tools are denied in archive-capable requests.
Mandatory read-only binds protect both archive aliases. The external systemd unit was
corrected after installation; the application release remains unchanged. See the unit
correction and actual namespace evidence in `../evidence/updated-slack-live-proof-20260914.json`.
Actual technical-description output passed independent comparison with its tool payload.
The broader capability screen still failed on file-input and background-learning claims;
owner testing is explicitly imperfect. Do not tune again against that small screen.
Flash Next remains an active candidate: test the real adapter under the frozen next-trial
plan, preserving earlier failures. No Flash inference job is currently running.

14 September v6 candidate: the first Flash actual-adapter screen failed overall despite
working JSON, status reads and action denial. Slack now excludes seeded project tools,
project-scope text and the legacy LQuorum shelf; dated archives and registered repository
observations remain available. Read-only Slack uses the ordinary bounded tool loop without
the separate autonomous task planner. Its prompt assembly excludes the legacy admin/tool
capability block, local-summary self-attribution and LQ guide. This removes contradictory
source paths rather than adding answer-specific prompt examples. Preserve the six-case
failure and use the independently frozen four-case revision screen once. These source
changes are not deployed merely because deterministic tests pass.

- Tier A: channel authentication, memory provenance and autonomous execution.
  Fresh independent review is required before release.
- Preserve the live EVO checkout's uncommitted integrations. Source-only inventory
  is outside this worktree at `../evidence/evo-source`; no runtime data is a fixture.
- No external messages, credential resets, production changes, commits or pushes
  are authorised by a test run. Deployment needs explicit release authorisation.
- Dreams are extractive recollections and reviewable hypotheses. A source citation
  establishes attribution, not truth or entailment. Never synthesize citations.
- Self-code must preserve proposals. Missing execution isolation or real replay is
  a blocked capability, never a neutral/pass result. Source requires independent review.
  The owner authorises automatic low-risk adaptation: policy v1 permits only explicit
  owner DM feedback selecting compact/spaced report layout. It cannot alter content,
  tools, prompts, identity, permissions, model routing or executable source. Preserve
  the previous setting and source reference. Broader automatic policies need a new
  consequence assessment and discriminating acceptance fixtures.
- `npm run verify` is the canonical deterministic verification command. Legacy
  failures must remain visible; do not suppress them to obtain a green release.
- New modules stay below 300 lines. Narrow integrity fixes in legacy JS entrypoints,
  HTTP/config/memory/prompt/transport facades and existing overnight composers may remain
  in their current language and exceed the cap during this overhaul;
  wholesale type conversion would obscure the fixes. Do not expand those facades.
  September shared-core exception: bounded additions to existing LLM, Cortex,
  prompt, memory, tool and planner call sites carry conversation authority and
  final-output enforcement. New policy and network/file boundaries are separate
  modules. Their exact facade ceilings are recorded in the limits file.
  `hooks/legacy-source-limits.json` records the reviewed legacy/conventional-test
  exceptions (including preserved EVO integrations). Verification rejects new oversized
  files and growth past those limits. Amend an exception only with a stated reason.
- Use explicit cmd.exe for Windows commands: PowerShell startup stalled in this
  session. SSH scripts use byte input to avoid Windows CRLF translation.

The current owner instructions override historical deployment/model claims in
CLAUDE.md. Model inventory must be measured. On 2026-09-13, the EVO gateway reported
`qwen3.8-27b` loaded from `Qwen3.8-27B-Q8_0.gguf`; Qwen3-Embedding-8B-Q8_0 also ran.
This establishes model availability, not second-brain or training readiness.
