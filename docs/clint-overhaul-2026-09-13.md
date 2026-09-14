# Clint overhaul — 13 September 2026

**Superseded as the finished-overhaul recommendation:** see the
[architectural reset](clint-rethink-2026-09-13.md) and
[replacement acceptance trial](clint-next-acceptance.md). This document records
the stabilization baseline and its verification, not proof of transferable learning.

## Intended outcome and release state

Reliable personal assistance and autonomous technical/research assistance, sharing
attributed memory and a measurable improvement loop. Preserve existing integrations.

The stabilization changes are implemented in the isolated `agent` worktree on `codex/clint-overhaul`.
It is staged on the EVO at `/home/james/jobs/clint-overhaul-20260913/release-stage`.
Production is unchanged. No commit, push, credential reset or external message was made.

## Verified starting point

- Local primary source: `C:/Users/James/Downloads/clawd-admin-fresh`, HEAD `6bcd928`.
  Older checkout: `C:/Users/James/Downloads/clawdbot-claude-code`.
- EVO bot: `/home/james/clawdbot`, same HEAD, ten modified source files plus
  untracked Spire/Steads integrations. Source snapshot preserved outside this repo.
- Live memory service: `/home/james/clawdbot-memory`; additional legacy components
  in `/home/james/evo-overnight`, `/home/james/evo-evolve`, `/home/james/clint-graph`.
- Bot repeatedly exits on WhatsApp logged-out; approximately 94,771 restarts at
  inspection. Main model fails because its configured GGUF file is missing.
- Dream timer disabled. Latest overnight events: 5 August; latest report: 4 August.
- Repository review: extraction `fact`/`text` mismatch; fabricated conversation
  evidence; discarded provenance; deleted successful forge branches; replay of the
  same bare model instead of changed code; missing replay counted as neutral.
- Legacy dream script has an undefined pruning function and unverified quote writes.

## Architecture decision

Repairing service startup alone cannot establish a working agent. A complete rewrite
would discard functioning integrations. Retain the assistant/tool surface and replace
the unreliable learning and lifecycle boundaries incrementally.

1. Channel disconnection is a visible degraded state, not process death. HTTP remains
   available for diagnostics and authenticated interaction. Never delete auth state.
2. One extraction boundary consumes immutable message lines, resolves exact citations,
   preserves sender/date/conversation/full hashes and rejects unsupported output.
   Automatic memories are attributed source statements, not model-certified truths.
3. One nightly worker runs independently of WhatsApp. It records genuine empty,
   unavailable, rejected, queued and stored outcomes. Legacy dreaming cannot write
   alongside the replacement pipeline.
4. Self-improvement preserves local proposals and source branches. Failed or missing
   replay cannot certify them. Host-level arbitrary model execution is gated until an
   isolated executor and real candidate evaluation are configured and proved.
5. Verification exercises actual contracts and real temporary Git worktrees. Semantic
   eval uses synthetic examples and reports source attribution separately from truth.

## Final implementation

- Channel state keeps HTTP alive when WhatsApp needs pairing, with bounded reconnect
  attempts. Dashboard/debate/learning APIs reject absent or incorrect credentials.
- Extractive memories retain full raw-line hashes, exact text, speaker, date, chat and
  line provenance. Fabricated IDs, bot assertions and mismatched quotes fail. Attribution
  is distinct from factual verification. Private/unknown-scope material stays local;
  the remote sink independently rejects it. The old free-form group writer is retired.
- Learning health checks do not drain legacy queues. Unsafe queued extraction jobs are
  retained without executing the old writer.
- One channel-independent nightly worker records actual outcomes and excludes overlaps.
  Failed reviews can retry. UUID attempt files preserve history and the latest packet
  is atomically replaced. Missing replay and malformed model output cannot pass.
- Dreams contain sourced recollections plus unverified conflicts, open questions and
  patterns. Improvement tasks cite observed failure events. Neither rewrites identity,
  policy, executable code or facts automatically.
- Automatic policy v1 applies explicit owner requests for compact/spaced report layout,
  with a typed setting, source reference and previous-value backup. This is a small
  automatic policy; general automatic code application is not enabled.
- A separate code-proposal command generates one allowed source file and retains a
  worktree, patch and test results. Baseline and candidate snapshots run in a pinned,
  networkless container with read-only mounts, CPU/RAM/PID limits and a timeout. Passing
  tests still requires candidate-specific acceptance and independent review.
- Nightly research uses configured public topics rather than private transcript-derived
  outbound queries. Existing bare-model probes remain diagnostics, not code-improvement proof.
- All ten modified tracked EVO source files and ten new Spire/Steads integration files
  were reconciled into this worktree. The original live WIP remains untouched.
- Canonical verification discovers nested tests, checks TypeScript and enforces a file
  size gate with frozen legacy exceptions. Dependencies are locked and patched.
- The historical deploy script is retired: it changed unrelated model services, silently
  tolerated failures and used service activity as its principal acceptance test.

## Recorded evidence

Evidence lives in `C:/Users/James/Documents/ChatGPT/Clint/evidence`.

| Check | Observed result | Artifact |
|---|---|---|
| Windows `npm run verify` | 1,375 tests; 1,374 pass, 0 fail, 1 skipped | `verify-release.txt` |
| Fresh EVO `npm ci` + same verification | 1,375 tests; 1,374 pass, 0 fail, 1 skipped | `evo-npm-ci.log`, `evo-verification.log` |
| Production dependency audit | Zero reported vulnerabilities at inspection | `dependency-audit-final.json` |
| WhatsApp dependency compatibility | Signature/tamper and protobuf round-trip checks pass | `whatsapp-dependencies.txt` |
| Actual HTTP entry contract | Logged-out status remains visible; unauthenticated actions rejected | `http-entry.txt`, canonical suite |
| Staged real-model entry | Authenticated HTTP → existing Qwen model → exact `CLINT_READY`, 55.953 seconds, no external messages | `evo-entry-probe.txt` |
| EVO source preservation | Three-way source reconciliation retained WIP | `reconciliation.json` |

Bounded live-model trials used synthetic data and the existing Qwen3.8 model through
`evo-job`. Extraction selected exactly four supported statement IDs and excluded a
hypothetical, injection, greeting and assistant assertion. Dreaming identified the two
conflicting dates, cited both and asked which dated source governs, without inventing
a relationship between unrelated preferences/projects. These establish the tested
mechanism, not general factual accuracy. See `model-extraction-eval.txt`,
`model-dream-eval.txt` and `eval-verdict.md`.

An actual container trial rejected a broken synthetic baseline and passed the corrected
candidate, including network/readonly-source/absent-host-credential checks. It proves
execution confinement and changed-source testing, not arbitrary autonomous repair.
Pinned image: `node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e`.

Fresh independent review prompted fixes for private-memory promotion, stale failed
review packets, transport attribution, worker races, reconnect retries and side-effectful
health checks. The final recheck found no remaining material blockers in those changes.

The staged entry assertion passed; recurring application timers kept its one-shot probe
alive afterward. The probe harness now explicitly exits, the result was collected from
the runner log, and managed-job cleanup was confirmed. This is not a WhatsApp session test.

## Explicit limits

- Production requires owner deployment authorization and WhatsApp re-pairing. Protocol
  tests cannot establish a live authenticated WhatsApp session.
- Full private/conversation-scoped semantic retrieval is not implemented. Private DM
  statements are archived locally. Existing legacy/group memory has not been audited
  or migrated; first release uses shadow consolidation while actual group scopes are assessed.
- General automatic source repair is not enabled. Nightly review produces tasks;
  code proposals require an observed failure, selected allowed file and clean checkout.
- Independent classifier/planner endpoints and external integrations were not all live
  tested. The missing model file was not repaired; use the existing gateway. Configured
  MiniMax keys retain the existing cloud chat preference.
- Hard service termination can leave a worker lock. Check service/PID before moving an
  orphan lock aside. Interrupted status-marker JSON fails visibly and needs inspection.
- Container confinement does not make a malicious test process trustworthy. A passing
  sandbox run never authorizes source deployment.

## Acceptance and release

First bounded experiment: correct service `fact` output reaches supported extraction;
an invented quote/hash, bot assertion or unrelated quote fails; source metadata survives
the sink. Second: real Git work survives implementation; missing replay never passes.
Use one evidence-led revision per failed hypothesis before reassessing.

Release requires deterministic verification, independent review, source/WIP reconciliation,
and a live first-use probe. WhatsApp re-linking is an owner-only prerequisite. Loading or
replacing a model must respect existing EVO workloads and the bounded evo-job runner.
No deployment, messaging or source publication is implied by local verification.
The canonical deployment and recovery procedure is [release-runbook.md](release-runbook.md).
