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
`src/slack/model.js` adapter. Release `63a09a8d6a92f9e6` is running on the EVO with
boot startup enabled; controls and actual Slack delivery/restart recall were verified. See
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

Personalization direction: `docs/clint-personalization.md`. Learn source-linked,
context-specific behavior from James's interactions. Separate desired assistant behavior
from inferred personal conduct. A style/preference profile never grants authority or
certifies facts; no profile is active merely because a model proposed it.

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
