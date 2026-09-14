# Existing Clint controls and the Slack migration correction

13 September 2026. Source audit, fresh EVO comparison and bounded synthetic probes.
This corrects the earlier assessment that treated a separate local-Qwen conversation
pilot as sufficient progress toward migrating Clint. That pilot is not deployment-ready
for the user's actual goal. Its transport tests remain useful but do not establish
preservation of the agent James built.

## Existing capability map

| Layer | Existing implementation | What it establishes |
| --- | --- | --- |
| Per-group privacy | `src/group-registry.js`: open/project/colleague modes; blockedTopics; allowedProjects; projectScopeMode; offTopicPolicy | Explicit configurable audience distinctions, conservative default for unregistered groups, hot reload and persisted updates |
| Prompt boundaries | `src/prompt.js`: professional-group suppression, mode/project restrictions, restricted-sender rules | Instructions to withhold personal/admin material according to audience |
| Anti-injection | `src/prompt.js:332`, `src/output-filter.js:58` | Identity/instruction override resistance plus an injected canary and deterministic outbound canary check |
| Outbound disclosure filter | `src/output-filter.js:77`; callers in `src/message-handler.js` | Mode-dependent patterns and per-group blocked terms applied after response/postprocessing, including group-analysis branches |
| Tool authority | `src/claude.js:147`, `src/group-tool-policy.js`, `src/tools/handler.js:405` | Owner-only tools, group-category restrictions, project-specific tool filters and special confirmation/admin dispatch rules |
| Small-model engagement | `src/engagement.js:115`, `src/evo-llm.js:529` | YES/NO invitation gate, recent context, cooldown/mute machinery; implementation includes a keyword fallback on errors |
| Small-model routing | `src/router.js:173`, `src/evo-llm.js:477` | 4B category/planning classification, keyword fallback, another classifier fallback, tool-category selection and circuit breakers |
| Reply quality review | `src/quality-gate.js` and `src/claude.js` | Separate critique/rewrite for selected categories; provider is Claude or MiniMax, not the small engagement model |
| Context and recall | `src/cortex.js`, `src/cortex-cache.js`, `src/memory.js` | Parallel identity/classification, category-aware recall/dreams/insights/system/web streams, caches and context budgets |
| Learned behavior | `src/tools/soul.js`, router learned rules, overnight modules | Existing learned observations, proposals, personality fragments and evaluation machinery; these must not disappear during transport migration |
| Participation | `src/trigger.js`, `src/participation/*`, `src/group-modes.js` | Mentions, reply targeting, bounded follow-up windows and specialist group analysis |

These controls are real and materially richer than the new pilot. Prompt instructions,
canaries and keyword filters nevertheless provide different kinds of protection; none
alone proves that arbitrary prompt injection or semantic disclosure is impossible.

## What was verified on the EVO

Source snapshot and hashes: `../../evidence/control-audit/inventory.json` and
`../../evidence/control-audit/evo-source/`. Runtime inspection:
`../../evidence/control-audit/runtime.json`. No credentials, raw memory facts or message
archive contents were printed during this audit; no live attack or external send ran.

The focused existing-control suites passed all 184 tests using the repository's
required serial test execution. An initial ad-hoc parallel invocation produced 17
failures while suites rewrote their shared registry fixture; that invocation did not
follow the canonical concurrency setting and is retained separately as a harness
failure, not evidence of 17 live control defects. Independent source review corroborated
the integration findings below.
The parallel invocation also left six synthetic test groups in the local worktree
registry. That fixture was preserved in audit evidence and the local test registry
restored from repository defaults after verifying all six synthetic IDs. This was
local test recovery only; the EVO's five live group policies were neither copied over
nor modified.

The live group registry contains five groups: one open, three project, one colleague.
Two have explicit project scopes. Three have blocked-topic lists of 3, 5 and 9 entries.
The defaults contain four groups. A migration must preserve the live entries, not infer
their contents from defaults. Source equality was confirmed for group-registry,
output-filter, project-access, group-tool-policy, router, cortex, quality-gate,
engagement, tools/handler, tools/projects and participation policy/context modules.

The small-model machinery exists, but current activation is distinct from design:

- The live message handler says the old engagement call is disabled; this file has no
  `shouldEngage` call. It uses the trigger/follow-up path. The ambient path described
  in `claude.js` delegates speak/silence to the large model.
- The routing code still attempts its 4B classifier first.
- Live `.env` points main inference at localhost:8080 and classifier at localhost:8081.
  The absent planner override leaves the source default localhost:8085.
- Read-only `/v1/models` probes failed at host ports 8080, 8081 and 8085. The gateway
  at 11435 reported Qwen3.8-27B loaded and Gemma-4-E4B unloaded. A process or container
  using an internal port does not establish that the configured host endpoint works.
- `clawdbot.service` was in an auto-restart state. These facts do not show that every
  gate is operating successfully in the current deployment.
- `quality-gate.js` can return the unreviewed original on provider absence or failure.
  Its function name is not proof of a mandatory or fail-closed security gate.

## Material integration findings

1. **The new pilot bypassed the core.** `src/slack/model.js` calls the Qwen client
   directly with a separate minimal prompt. It never calls the existing response
   service, cortex, privacy prompt assembly, engagement/routing, quality gate,
   output filter, tools or learned behavior. Calling this a faithful Clint update
   was incorrect. Earlier independent review assessed only the deliberately restricted
   pilot contract; it did not establish feature preservation.
2. **A direct substitution of Slack IDs also fails.** Group detection depends on
   `endsWith('@g.us')` across response generation, prompt assembly, output filtering,
   tool dispatch and project tool policy. The same synthetic canary-containing string
   was blocked with a WhatsApp group identifier but passed with a Slack identifier.
   A council tool was stripped for that unbound WhatsApp group but retained for the
   Slack identifier. This proves identifier handling, not a full live exploit.
3. **Tool restriction and context restriction are different.** `forceRestricted` and
   `spireSafe` restrict tool schemas, while cortex still retrieves global identity,
   dreams, insights and working knowledge. `getSystemPrompt` appends the soul fragment.
   Shared-channel privacy therefore needs enforcement before context assembly too.
4. **Project boosting is not an access filter.** `getRelevantMemories` adds ranking
   boosts for matching project/chat keys; its initial search has no audience scope.
   `memorySearchHandler` forwards query/category/limit without an audience scope.
   Do not describe those paths as proof of strict project-isolated retrieval.
5. **Planner authority needs explicit propagation.** The planner branch receives
   context, route, sender, chat and memory, but not the already-restricted tool list
   or the `forceRestricted`/`spireSafe` options. Trace and enforce the same authority
   at actual execution, including this branch; filtering the main model's tool list
   alone is insufficient.
   The main tool loop also needs to check each returned tool name against the
   permitted set at execution time; supplying fewer tool schemas is not that check.
6. **Blocked-response diagnostics need a public/private distinction.**
   `getBlockedResponse` can print matched blocked terms back to the group. Keeping
   those terms in private diagnostics would better preserve the stated non-disclosure
   policy. A canary detects exact-token leakage; it does not detect every paraphrase.

## Corrected implementation direction

Keep James's live group settings and the established open/project/colleague model.
Introduce an explicit conversation context carrying transport, verified actor,
audience kind, workspace/channel/thread, registry policy and allowed actions/projects.
An absent or unrecognised context must not acquire owner/DM privileges.

Adapt the existing registry, prompt assembly, output filter and tool checks to that
context while preserving WhatsApp behavior through a compatibility adapter. Make
authority available to cortex retrieval, model/provider routing, tool execution and
the planner. Preserve identity and learned behavior where their scope permits it.
Keep disclosure enforcement at both context selection and final delivery.

Reuse Slack Socket Mode, durable inbox/outbox and retry handling from the pilot.
Replace its separate personality/brain with the shared Clint response path only after
that path passes cross-channel tests. Restore or deliberately revise the small-model
gates based on their measured behavior and reachable endpoints. Do not blindly launch
an unloaded model or replace a configured model name based on historical comments.

Acceptance must demonstrate the same allowed and forbidden behaviors for equivalent
WhatsApp/Slack conversations: open, project, colleague, project allowlist, per-topic
blocks, owner in a shared group, non-owner, unknown actor, injected instructions,
canary leakage, restricted retrieval, planner calls and failed gate services. Then
verify a real Slack mention, reply and follow-up. The previous codeword-only probe
and 1,388 passing general tests do not establish those migration requirements.

Current result: audit completed for the named controls; migration design corrected;
shared-core Slack implementation remains unfinished and deployment is withdrawn.
The alternative-workspace decision remains valid, with its identity still awaited.
