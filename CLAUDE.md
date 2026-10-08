> Historical document. September 2026 behavior and operational policy are defined in
> [README](README.md), [AGENTS.md](AGENTS.md) and [the overhaul report](docs/clint-overhaul-2026-09-13.md).
> Earlier AGI, model, deployment and autonomous source-change claims are not current guarantees.
>
> **14 September 2026: WhatsApp is decommissioned.** `clawdbot.service`, `llama-server-main.service`
> (port 8080) and the WhatsApp pairing state are gone from the EVO. The "Deploying — BINDING" flow
> below targeted the WhatsApp checkout and is retired. Clint's only conversational transport is the
> Slack adapter (`src/slack/`), deployed under `/opt/clint-slack/releases/<id>`; the scripts that
> shipped the current release are in [tools/release/](tools/release/README.md) and the process is
> described in [docs/clint-slack-release.md](docs/clint-slack-release.md). Local model gateway: llama-swap on
> `127.0.0.1:11435` (`qwen3.8-27b`) or the Flash controller on `127.0.0.1:11437`.
>
> **8 October 2026: one repository.** The GitHub repo was renamed `jamescockburn47/clint` (old
> `clawd-admin` URLs redirect). `main` carries every installed release as a commit, tagged
> `clint-vNN` and byte-equal to its `/opt/clint-slack/releases/<id>` directory; the ledger is
> `/opt/clint-slack/RELEASES.json` on EVO. The only development checkout is `C:\Users\James\Desktop\Clint`.
> The per-topic candidate folders, reviews and deployment receipts stay in
> `C:\Users\James\Documents\ChatGPT\Clint\evidence\` (private, not in git). The old WhatsApp-era
> checkouts were archived to branches `archive/clawdbot-whatsapp-final-20260805` and
> `archive/windows-clint-moorstead-phase1-20260708`, then deleted. PR #62 is merged.

# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.
> See also: [Data Flows](docs/data-flows.md) | [API Reference](docs/api-reference.md) | [Deployment](docs/deployment.md) | [EVO X2 Reference](docs/evo-x2-reference.md)
> Archived/superseded decisions: [docs/archived-decisions.md](docs/archived-decisions.md)

## Quick Reference

| Key | Value |
|-----|-------|
| **Primary host** | **EVO X2** — bot, memory, models, voice, forge all run here |
| **EVO X2 IP** | `10.0.0.2` direct ethernet (prefer) / `192.168.1.230` WiFi / `100.90.66.54` Tailscale |
| **EVO user** | `james` (NOT `pi`) |
| **EVO project path** | `/opt/clint-slack/current` (release directory; `~/clawdbot` was removed 2026-10-08) |
| **Pi (backup/screen)** | `192.168.1.211` LAN / `100.104.92.87` Tailscale (`cnc`), user `pi` |
| **Local project path** | `C:\Users\James\Desktop\Clint` (clone of `github.com/jamescockburn47/clint`, branch `main`) |
| **SSH key** | `C:\Users\James\.ssh\id_ed25519` |
| **Node** | v20+, ESM (migrating to TypeScript with `tsx`), `node --env-file=.env src/index.js` |
| **Pi dashboard** | Rust native app `clawd-dashboard` on Pi (NOT Chromium), 10.1" touchscreen 1024x600 |
| **Clawd Console** | Next.js 16.2.2 app `clawd-console/` — runs on James's **Legion 9 Pro laptop**, not EVO, not Pi. `npm run dev` on port 3100. Talks to the bot on EVO via `PI_URL=http://100.90.66.54:3000` and `EVO_URL=http://100.90.66.54:5100` with `DASHBOARD_TOKEN` auth. Has an `(console)/overnight` page already rendering overnight data via `fetchPi`. **Next.js 16 has breaking changes vs 15** — see `clawd-console/AGENTS.md`; read `node_modules/next/dist/docs/` before writing console code. Key changes: async Request APIs (params are Promises), middleware renamed to proxy, Turbopack default, next/image defaults changed. |
| **Bot HTTP API** | `src/http-server.js` (~427 lines) on EVO port 3000. Plain `http.createServer` with manual `if (path === '/api/x')` routing — NOT Express. `checkAuth(req)` at top guards every route with `DASHBOARD_TOKEN`. Add new routes by matching the existing pattern. |

For EVO services/ports/models, see [EVO X2 Reference](docs/evo-x2-reference.md).
For deploy commands and SSH patterns, see [Deployment](docs/deployment.md).

## Session Protocol — MANDATORY

1. **Read `CLAUDE.md` and `architecture.md`** at start of every session.
2. **Deploy target is EVO.** See "Deploying — BINDING" below. **James does not deploy manually.** Any change that lands on `main` must be deployed by the agent in the same session.
3. **Never use `-uall` flag** with `git status` (can OOM).

## Deploying — BINDING

The canonical deploy flow, set up 2026-04-19 (deploy key id 149013361 on `jamescockburn47/clawd-admin`, EVO remote is SSH form):

```bash
# from Windows, after the PR has merged to main:
ssh james@100.90.66.54 '~/clawdbot/scripts/deploy-clawdbot.sh'
```

That script:
- Auto-stashes tracked-file modifications on EVO (James sometimes edits directly there; the stash keeps WIP safe and is popped after the pull).
- Does **not** stash untracked files — `data/overnight/*.jsonl` and similar are written live by the service; snapshotting them mid-write risks corruption on pop.
- `git fetch` + `git pull --ff-only origin main`.
- `git stash pop` — if it hits conflicts, WIP stays in `git stash list` and the script exits non-zero. Investigate manually, do not `--force`.
- Syncs `evo-system/clawdbot.service` → `/etc/systemd/system/clawdbot.service` (copy + `daemon-reload`) if the tracked file differs from live. The tracked unit is the source of truth — edit it there, not in `/etc/systemd/`.
- Pre-flight-warns if a non-systemd process holds `:3000` (PID / etime / cgroup logged). The unit's `ExecStartPre=fuser -k -TERM 3000/tcp` reclaims the port automatically, but the warning still fires so the orphan's origin can be diagnosed.
- `sudo systemctl restart clawdbot`.
- Verifies `systemctl is-active clawdbot` and prints the last few journal lines.

**Never start clawdbot outside systemd.** Use only `sudo systemctl restart clawdbot` or this script. Do **not** run `ssh james@... 'nohup node ... src/index.js &'` or any equivalent manual-background start. Orphans reparent to init, survive SSH session close, and block the next deploy with `EADDRINUSE :::3000` (2026-04-19 incident). The `ExecStartPre` is a safety net, not a licence.

Variants:

- `ssh james@100.90.66.54 'DRY_RUN=1 ~/clawdbot/scripts/deploy-clawdbot.sh'` — pull only, skip restart. Use when you want to confirm a pull will succeed without disturbing the service.
- The script is idempotent — running it when main is already at tip is a no-op except for the service restart. If you only want the restart, `ssh james@100.90.66.54 'sudo systemctl restart clawdbot'`.

**When to deploy:**

- Immediately after any PR is squash-merged to `main`.
- After `gh pr merge --squash --delete-branch` succeeds.
- Do **not** deploy half-merged work, unmerged branches, or scp'd files. The flow is: commit → push → PR → merge → deploy. Nothing else.

**Emergency fallback (only when SSH pull is broken):**

- The `scp` pattern used before 2026-04-19 still works for emergencies. Example:
  ```bash
  scp src/tools/handler.js james@100.90.66.54:~/clawdbot/src/tools/
  ssh james@100.90.66.54 'sudo systemctl restart clawdbot'
  ```
  This leaves EVO's git tree dirty and requires a follow-up cleanup. Only use when you've exhausted normal options; document in the PR why.

**If the deploy script itself is the change:** bootstrap with one manual SSH pull:
```bash
ssh james@100.90.66.54 'cd ~/clawdbot && git stash && git pull --ff-only origin main && git stash pop'
```
then subsequent deploys use the script.

**Known EVO WIP to preserve** (as of 2026-04-19):
- `src/http-server.js` — modified, adds `/debate` endpoint pending formalisation.
- `src/debate-handler.js` — untracked new file, ~12 KB, companion to the above.
Neither is committed yet; the auto-stash handles them transparently on every pull.

## Research Protocol — MANDATORY

- **ALWAYS search online** for hardware compatibility, driver support, library versions, benchmarks. Never rely on training data for version-specific info.
- EVO X2 runs AMD Ryzen AI MAX+ 395 with Radeon 8060S (gfx1151, RDNA 3.5). Training data will be stale.
- When researching models, cast a **wide net** — check current leaderboards, not just Qwen.

## Project Overview

WhatsApp admin assistant bot ("Clint", previously "Clawd") running on EVO X2, with Rust dashboard on Pi 5 touchscreen and a Next.js Clint Console on James's Legion 9 Pro laptop. Personal assistant for James Cockburn: calendar, email, travel, todos, soul/personality system.

**Who uses it:** James (owner, full access) and MG (wife — calendar reading, todos, travel, web search only).

**Tech:** Node.js 20+ ESM (migrating to TypeScript file-by-file, `tsx` runner), Baileys (WhatsApp), Qwen3.6-27B-Q8_0 local on EVO as default chat model (language + coding) with MiniMax as cloud fallback + vision path, Rust dashboard on Pi, JSON file persistence. No database.

## Architectural Invariants — BINDING

These are constraints the agent cannot infer from code. Do not revisit, reverse, or work around them.

### Hardware & Network
- **EVO X2 is the primary host.** Bot, memory service, models, voice, forge — all run on EVO. Pi is backup and dashboard screen only.
- **All EVO local services use localhost** (bot runs on EVO alongside models). `evo-client.js` wraps all HTTP to local EVO services.
- **Pi dashboard connects to EVO** via direct ethernet (`10.0.0.2`) for API and SSE.
- **Dashboard is Rust/egui native app** on Pi. Not Chromium, not HTML.
- **Tailscale on all machines.** Pi `cnc`, EVO `james-nucbox-evo-x2`.
- **All EVO servers run 24/7.** No sleep/wake timers.

### Model Routing (2026-04-23 Qwen3.6-27B swap)
- **Qwen3.6-27B-Q8_0 local on EVO `:8080` is the DEFAULT chat model.** Handles every non-image chat response — language AND coding. Dense 27B, Apache 2.0, ~28 GB weights on GPU + ~4 GB KV cache, Q8_0 quant for near-reference quality. Replaces the previous "MiniMax default" + day/night swap scheme. One always-on model, no scheduled model swaps.
- **MiniMax M2.7 is the FALLBACK path.** Invoked automatically when Qwen local is unreachable (llama-server crash, GPU hang, model-load failure) AND on every image-bearing message (dense 27B has no vision head; MiniMax's vision endpoint handles photos).
- **Claude / Opus is OPTIONAL and dormant.** `ANTHROPIC_API_KEY` is no longer set by default. If re-added it only fires on explicit "ask claude" / "use opus" invocation. No automatic cascade.
- **4B classifier on `:8085` is the primary routing layer (restored 2026-04-24).** Qwen3-4B-Instruct Q4_K_M. Hot-path classification in <1 s — the 27B was taking 6–7 s per message which became the floor on every reply. The 4B decides category + needsPlan; the 27B then generates the actual response. Most messages still end up on the 27B for the body, so the quality-vs-latency trade-off is only on the routing layer.
- **Keywords remain the fallback when EVO is down.** Unchanged semantics.
- **EVO llama-server inventory (post-2026-04-24 speed tune).** `:8080` Qwen3.6-27B-**Q6_K** (chat + tools + coding, default chat path) with **speculative decoding** against a Qwen3.5-0.8B-Q4_K_M draft for 50-80% tg speedup on the dense target. `--parallel 1 -c 32768`, batch/ubatch `512/128` (chat-workload tuning, not llama-bench throughput). `:8085` Qwen3-4B-Instruct-2507 Q4_K_M (classifier + planner hot-path). `:8083` Qwen3-Embedding-8B (memory). `:8084` granite-docling (PDF/doc parsing). `:8086` gemma-4-31B (bot-council rollback, not Clint's concern). Retired services — do not re-enable without cause: `:8081` 0.6B classifier, `llama-server-coder.service`, `llama-swap-{main,coder}.{service,timer}`.

### Voice Pipeline
- **Piper TTS for everything.** Every voice command MUST produce audible output.
- **Mic flush after ALL TTS.** Wait `audio_duration + 0.5s` before reopening mic.
- **Follow-up mode after ALL spoken responses** (10s listening window).
- **Wake phrase ack is "Yes?"** via Piper. Single-word only.

### Group Behaviour
- **Groups are @mention/prefix only.** No passive engagement, no ambient/unsolicited participation in any group — including LQCore and SOVREN. `clawd ...` or `@clawd` for advisory mode, `clawdsec` for secretary/admin mode (skips planner). Native replies to Clint's own messages and the short follow-up window after he replies also count as direct address.
- **Three security modes: open, project, colleague.** Unregistered groups default to colleague (most restrictive). James sets modes in-group.
- **Project-scoped groups are allowed.** A group may be bound to specific project IDs (for example `sovren`) with `single_project_only` scope and `soft_redirect` off-topic behaviour; in those groups, Clint prioritises allowed project knowledge ahead of general memories.
- **Project knowledge sync supports git sources.** Nightly `project-sync` can pull a project mirror from its configured Git repo (for example SOVREN) and ingest changed docs into memory.
- **Three-layer defense: prompt + output filter + canary.** Cannot be prompt-injected. Output filter is deterministic regex.
- **Anti-prompt-injection hardening.** Identity lock, instruction hierarchy, anti-extraction, anti-role-play.
- **ALL groups block personal admin tools.** Calendar, email, travel, todos — DMs to James only. Memories/dreams/insights are NOT blocked.
- **No emojis.** Global rule.

### Dream Mode & Soul
- **Dream mode runs overnight on EVO (22:05).** Extractive only — no inference, no extrapolation.
- **Insights must be evidence-grounded.** Each must cite 2+ specific messages.
- **Owner authority is absolute.** James overrides all learned behaviours.
- **Identity memories are immutable.** Never expired, never superseded.
- **Intellectual backbone: adapt volume, never adapt accuracy.**
- **Soul proposals via DM only.** Only James can approve personality changes.
- **Confidence decays for volatile categories only.** Stable categories (identity, preference, person, legal, insight) never decay.

### Overnight Pipeline — Four Stages (Compound Dream, Phases 2-5 complete)
Authoritative spec: `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md`.

- **CONSOLIDATE (every night ~02:30).** Memory extraction with evidence-chain invariant: every new memory cites `sources: [{hash, excerpt}]` or gets rejected to `data/overnight/rejected-<date>.jsonl`. Phase 1 is currently in shadow mode writing to `shadow-candidates-<date>.jsonl`; cutover is a separate follow-up. 0 Opus sessions.
- **PROBE (every night ~03:15).** Four observation types accumulated to `data/overnight/observations-<iso-week>.jsonl`: pattern observations (EVO 30B over traces), candidate proposals (EVO 30B with mission-alignment filter), drift checks (sample + replay + grade), quality-gate enrichment (from trace-analysis.json anomalies). Monday rollover to `archive/`. Weight decay: half every week past 14 days, zero past 12 weeks. 0 Opus sessions.
- **REPORT (every morning ~06:50, before briefing).** Structured morning report generated from the event log + current-week observations. **ATLAS staleness guard** (hard): no candidate surfaces unless at least one evidence_ref points to a current-ISO-week observation. Sections: overnight summary, NEW this week, CONTINUING, DRIFT alerts, DEFERRED, ARCHIVE, Budget. Persists `data/overnight/report-<date>.json` and `.txt`. Read by `briefing.js` for the morning WhatsApp DM. 0 Opus sessions.
- **IMPROVE (Saturday 22:00 London, or on-demand via `POST /api/forge-now`).** Weekly forge successor. 8-step pipeline:
  1. read this week's observations (skip if <5)
  2. groom (dedupe/cluster/decay/drift-surface)
  3. synthesise 5-8 final candidates via EVO 30B (≥2 evidence refs per candidate)
  4. Opus selection (1 session, NULL allowed)
  5. skip on NULL
  6. implement in fresh worktree via Claude Code CLI (1 Opus, 2-hour wall-clock timeout)
  7. rolling replay regression check (20 stratified samples, grade via EVO 30B, any "worse" → reject)
 8. branch-first CI via `scripts/forge-ci.sh`, Tier A/B/C classification, then **proposal-only** approval
  - Hard budget: 2 Opus sessions per deep night.
  - Proposal cards written to `data/overnight/proposals/` for morning report pickup.
 - **No overnight code auto-merge.** Successful forge branches must wait for James's explicit approval before merge/deploy.
  - Banned files (`src/overnight/tiering.ts` BANNED_FILES): `src/router.js`, `src/cortex.js`, `src/memory.js`, `src/message-handler.js`, `CLAUDE.md`, `docs/superpowers/**`, `data/runtime/**`.

### Event log + morning briefing
- **`data/overnight/events-<date>.jsonl`** is the single source of truth for what ran overnight. Every stage appends structured events. The morning report and the Clint Console `/overnight` page both read from here. "No event = did not happen" — the OvernightRunner writes a synthetic `verdict: failed` event if a stage completes silently.
- **Four retrofitted operational tasks also write events:** `daily-backup`, `trace-analyser`, `system-refresh`, `ground-truth`. Stage is `'operations'`.
- **Morning briefing** (07:00 London via `src/tasks/briefing.js`) reads the structured report and replaces the old 4-bullet "Overnight insights" block with plain-English per-section paragraphs. No LLM calls in the report path.
- **Morning briefing must include one clear "Overnight research and self-improvement" section.** It should state what research ran, sources/findings, whether self-code created a branch/proposal, and that nothing merged automatically unless James approved it.
- **Overnight research uses SearXNG-first.** The scheduled research task should use self-hosted SearXNG + no-credit web fallback + page fetch + local EVO synthesis before any credit-limited research provider.

### Task Planner
- **Goal reasoning, not mechanical decomposition.** Understand the goal first, then decompose.
- **Adaptive re-planning between steps.** Skip redundant, add new if gaps emerge.

### Group Analysis
- **Devil's advocate uses Nemeth/Klein framework.** CIA assumptions, Klein pre-mortem, steelman opposition.
- **Aristotle mode is single-step.** Quoted messages take priority as focal point. Anyone can trigger.
- **Output filter applies to all group mode responses.**

## Code Standards — BINDING ON ALL AGENTS

### Structure Rules
- **Maximum file size: 300 lines (JS/TS) / 500 lines (Python).** Split before adding.
- **One file, one job.** Single responsibility.
- **No duplicate functions.** Search before writing. Import, don't copy.
- **All constants in `constants.ts` or `config.ts`.** Zero `process.env` outside config.
- **New scheduled tasks get their own file in `src/tasks/`.**
- **Clean up after yourself.** Delete old files in the same commit.
- **Refactoring is mandatory.** Fix violations when touching a file.
- **Fix general before specific.** Fix the class of bug, not the instance.

### Architecture & Design
- **Classes for stateful services.** If it has module-level `let` variables, it should be a class. Pure utility functions stay as functions.
- **Manual dependency injection.** Constructor params, not imported singletons. No DI container. Factory functions create configured instances.
- **Single entrypoint per feature.** One main public method per service class.
- **Dispatch over if/else chains.** Map/object lookup, polymorphism, or registry patterns.
- **Repository pattern for I/O.** Business logic never touches files/APIs directly.

### Type Safety
- **TypeScript for all new and touched files.** Rename `.js` → `.ts` when refactoring. Use `tsx` for execution. Strict mode, no `any`. This is an AI-coded project — types are the spec the AI reads before generating.
- **Pydantic at API boundaries only (Python).** Dataclasses internally. Pydantic adds 6.5x overhead.
- **Enums for fixed values.** Frozen objects (JS) or Enums (Python). No raw strings for defined meanings.

### Error Handling
- **No silent failures — strictly enforced.** Every catch: (a) handles with recovery, (b) logs with context and re-raises, or (c) has `// intentional: [reason]` comment. Bare `catch {}` is banned.
- **Log errors with context, not exception types.** What failed, what the input was, why it matters.
- **No magic numbers or strings.** Every meaningful value gets a name in constants/config.
- **Config validation on startup.** Fast-fail if critical env vars are missing or malformed.

### Async, Logging & Testing
- **Concurrent operations where independent.** `Promise.all` / `asyncio.gather`. Never await sequentially when tasks don't depend on each other.
- **Errors + diagnostics only.** Log errors with context. Keep structured diagnostics for trace analysis. Remove routine info noise.
- **Unit tests for all new code.** `node:test` with `mock.fn()`/`mock.method()` + `esmock` for ESM module mocking. Python: pytest + pytest-mock.
- **Docstrings/JSDoc on all public methods.** One line: what and why.

## Process Rules

- **Update CLAUDE.md in real-time.** Every decision, immediately. Not at end of session.
- **Use superpowers skills.** Brainstorming, systematic-debugging, verification — not optional.
- **Memory categories must match between Pi and EVO.** All categories in code registered in config.py with correct TTLs.
- **System self-awareness** lives in `data/system-knowledge/` (modular sub-files, seeded into EVO memory nightly).

## Known Gotchas

- **Google Calendar all-day events use exclusive end dates.** Subtract 1 day for display.
- **Multiple scheduler starts**: Guard (`schedulerStarted`) prevents duplicates on reconnect.
- **Owner detection uses two formats**: `OWNER_JID` (phone) and `OWNER_LID` (linked ID).
- **Widget cache TTL is 5 minutes.** Scheduler reads cached data.
- **Todo tools are NOT owner-restricted** — MG should be able to use them.
- **Google OAuth dead flag** in config stops retry spam on invalid_grant.

## Adding New Design Decisions

When a decision is made during a session, **add it to the relevant section above**. Implementation details that live in code should NOT be added here — only non-inferable constraints and invariants. See [docs/archived-decisions.md](docs/archived-decisions.md) for historical decisions.
