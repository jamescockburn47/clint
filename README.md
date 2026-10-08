# Clawd (Clawd Monet)

A self-improving WhatsApp AI assistant running on a Raspberry Pi 5 with a touchscreen dashboard, backed by a mini PC running local AI models. Designed as a reference architecture for persistent, self-modifying AI agents.

## What Makes This Different

Most AI assistants are stateless API wrappers. Clawd is not.

**Clawd remembers.** Every conversation is logged. Every night, a local model reviews the day from Clawd's first-person perspective, extracts durable facts, identifies cross-conversation insights, and stores verbatim quotes worth preserving. Clawd wakes up the next morning with yesterday already digested.

**Clawd evolves.** A soul system tracks personality observations from group interactions. Only the owner can approve changes. A self-improvement cycle probes for weaknesses in message routing, proposes fixes, validates them against an eval suite, and applies improvements autonomously. An evolution pipeline lets Clawd modify its own source code via Claude Code CLI, with every change requiring human approval before deployment.

**Clawd plans.** Multi-step requests are decomposed into dependency-aware plans, executed in parallel where possible, with adaptive replanning between steps. A 4B classifier detects when planning is needed. Every routing and model selection decision is logged as a reasoning trace.

**Clawd analyses itself.** Overnight trace analysis identifies routing anomalies, plan failure patterns, and classifier drift. A weekly retrospective uses a 30B model to reason about improvement priorities and auto-create coding tasks. The only human gate is deployment approval.

**Clawd reads the room.** An engagement classifier (0.6B parameter model) decides whether to respond to group messages. A mute system enforces silence when told to shut up. Negative reactions trigger private proposals to the owner, not public apologies.

## Architecture

Two machines connected via direct ethernet (sub-millisecond latency):

**Raspberry Pi 5** — orchestrator, WhatsApp client, HTTP server, dashboard
- Node.js 20+ (ESM), Baileys WhatsApp Web API
- Three-tier AI: EVO local (free) -> MiniMax M2.7 (cheap cloud) -> Claude Opus 4.6 (premium, explicit request only)
- 58 tools: calendar, email, travel, todos, soul, memory, projects, web search, evolution
- Task planner with goal reasoning, dependency tracking, parallel execution
- Pino structured logging, circuit breakers, audit trail

**GMKTec NucBox EVO X2** (AMD Ryzen AI MAX+ 395, Radeon 8060S, 128GB unified RAM) — local AI, memory, voice
- Qwen3-30B-A3B (tool calling, decomposition, ~60-70 tok/s via Vulkan)
- Qwen3-4B (category + needsPlan classifier, port 8085)
- Qwen3-0.6B (engagement gating, fast binary YES/NO)
- nomic-embed-text-v1.5 (embeddings, always-on)
- Granite-Docling (document parsing)
- FastAPI memory service (vector search, fact extraction, dream storage)
- SearXNG (self-hosted web search, no API key)
- Claude Code CLI (headless self-coding)
- Whisper STT + Piper TTS (voice interface)

**Dashboard** — Rust native app (eframe/egui), not Chromium
- 3-column touchscreen layout (1024x600)
- Real-time SSE updates
- Voice overlay (listening/processing/response states)

## Key Subsystems

### Memory & Dreams
- **Vector memory service** — hybrid search (keyword 35% + vector 40% + recency 15% + frequency 10%)
- **Dream mode** runs nightly at 22:05 — diary generation, fact extraction, insight synthesis, verbatim quote storage, soul observations
- **Orientation phase** — reads existing memories before writing new ones (prevents duplicates)
- **Pre-store dedup** — checks semantic similarity before storing (skips duplicates, supersedes contradictions)
- **Stale pruning** — removes machine-extracted memories older than 30 days with low access count
- **Identity memories** — immutable category, never expired or deduplicated
- **Dream chaining** — last 2-3 days' dreams as context, today's conversations take priority

### Engagement & Groups
- **Classifier gate** — 0.6B model decides YES/NO for every passive group message
- **Mute system** — "shut up" triggers 10-minute per-group silence, only @mention breaks through
- **2-minute response cooldown per group** — prevents spam, @mention bypasses
- **Negative signal detection** — mocking, corrections, told-off patterns trigger private owner DM
- **Professional group filtering** — personal admin (calendar, email, travel, todos) blocked in all groups
- **Working memory** — LQuorum passive keyword scanning across 18 topic domains, 15-minute decay

### Task Planner (Phase 1 AGI)
- **Goal reasoning** — two-phase: understand the goal first, then decompose into steps
- **Dependency-aware parallel execution** — topological sort, independent steps run concurrently
- **Template variable resolution** — `{{step1.result.field}}` links step outputs
- **Adaptive replanning** — evaluates results after each level, skips redundant steps, adds new ones
- **4B classifier** detects `needsPlan` — supplements keyword heuristics
- **EVO 30B for reasoning** with MiniMax M2.7 fallback

### Self-Improvement
- **Router optimisation** — nightly cycle probes for missed keyword rules, validates against eval suite, applies improvements with rollback on accuracy drop
- **needsPlan probing** — 23 synthetic test cases evaluate 4B classifier accuracy overnight
- **Quality gate** — Claude Opus 4.6 reviews PLANNING, LEGAL, and long EMAIL responses
- **Anti-slop rules** — banned phrases, banned structures, substance requirements in system prompt

### Trace Analysis & Autonomous Improvement (Phase 2 AGI)
- **Reasoning traces** — every routing, classification, model selection, and planning decision logged to JSONL
- **Trace analyser** (daily, 3 AM) — routing layer breakdown, plan success rates, needsPlan F1 score, timing percentiles, anomaly detection
- **Weekly retrospective** (Sunday, 4 AM) — EVO 30B reasons about top 3 improvement priorities from trace data, auto-creates evolution tasks for high/medium severity
- **API endpoints** — `/api/traces` (nightly), `/api/traces/live` (on-demand), `/api/retrospective` (weekly)
- **Closed feedback loop** — traces -> analysis -> retrospective -> evolution task -> code change -> approval -> deploy -> traces measure improvement

### Evolution Pipeline
- **Chat trigger** — owner creates coding tasks via WhatsApp tool
- **Claude Code CLI** — runs headless in a git branch (never main)
- **Owner approval** — diff sent via WhatsApp DM, must reply "approve" before deployment
- **Auto-deploy** — merge branch, rsync to Pi, restart service, health check, auto-rollback on failure
- **Dream integration** — overnight analysis can create coding tasks autonomously
- **Weekly retrospective integration** — auto-creates evolution tasks from trace analysis
- **Rate limited** — max 3 tasks/day, 1 concurrent, 1-hour cooldown
- **Scope guard** — max 5 files, 150 lines per change, banned files list

### Response Pipeline

```
WhatsApp message
  -> Dedup (last 200 message IDs)
  -> Trigger engine (direct mention, prefix, reply, random probability)
  -> Group: engagement classifier (YES/NO/fallback)
  -> Classification: keywords -> complexity -> 4B classifier -> 0.6B fallback
  -> needsPlan check (4B classifier + heuristic)
  -> Route: task planner OR single-shot tool call
  -> Model: EVO local -> MiniMax M2.7 -> Claude Opus 4.6 (escalation)
  -> Tool loop (up to 5 iterations, audit each call)
  -> Quality gate (substantive responses reviewed by Opus)
  -> Response sent
  -> Reasoning trace logged, interaction logged, SSE broadcast
```

## AGI Roadmap

Clawd is scored against a 10-pillar "minimum viable AGI-like stack". Current score: **81/100**.

| # | Pillar | Score | Status |
|---|--------|-------|--------|
| 1 | Multi-model orchestration | 9/10 | Three-tier (EVO free -> MiniMax cheap -> Claude premium), dynamic routing, circuit breakers |
| 2 | Memory system | 8/10 | Working memory (LQuorum), episodic (logs), semantic (embeddings, dream consolidation) |
| 3 | Tool use | 9/10 | 58 tools, audit logging, owner gating, read/write safety classification |
| 4 | Planning & reasoning | 7/10 | Task decomposition, dependency tracking, parallel execution, adaptive replanning |
| 5 | Multi-agent system | 6/10 | Engagement classifier + router + quality gate + task planner as distinct agents |
| 6 | Control layer | 8/10 | Reasoning traces, overnight analysis, anomaly detection, circuit breakers |
| 7 | Self-improvement | 8/10 | Keyword improvement, dream consolidation, evolution pipeline, trace analysis |
| 8 | Local + cloud hybrid | 9/10 | EVO X2 (30B/4B/0.6B local) + MiniMax (cheap cloud) + Claude (premium cloud) |
| 9 | Interface layer | 8/10 | WhatsApp, Rust dashboard, voice (Piper TTS + Whisper STT), HTTP API, SSE |
| 10 | Safety & constraints | 8/10 | Evolution scope guards, banned files, manifest validation, owner authority |

**Phases:**
| Phase | Description | Status | Score |
|-------|-------------|--------|-------|
| 1 | Task Planner + Reasoning Traces | Complete | 75 -> 81 |
| 2 | Autonomous Goal Generation + Trace Analysis | In progress | 81 -> 85 (projected) |
| 3 | Predictive Scheduler + Inference Critique | Not started | 85 -> 89 (projected) |
| 4 | World Model + Persistent Identity | Conceptual | 89 -> 93 (projected) |

See `PLAN-agi-roadmap.md` for the full roadmap with detailed deliverables and expected impact per pillar.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ (ESM, no TypeScript, no build step) |
| WhatsApp | @whiskeysockets/baileys v6.x |
| Local AI | llama.cpp (Vulkan) — Qwen3.6-27B default chat, Qwen3-4B classifier/planner, Granite-Docling, embeddings |
| Cloud AI | MiniMax M2.7 fallback, Claude Opus 4.6 premium/explicit/last-resort |
| Google | googleapis — Calendar v3, Gmail v1 |
| Weather | Open-Meteo (free, no API key) |
| Travel | Darwin (UK trains), BR Fares (tickets), Amadeus (hotels) |
| Search | SearXNG (self-hosted, Docker, no API key) |
| Documents | pdf-parse (PDFs), mammoth (DOCX), Granite-Docling (local) |
| Dashboard | Rust native app (eframe/egui) |
| Memory | FastAPI + JSON persistence + nomic embeddings |
| Voice | faster-whisper (STT) + Piper (TTS) |
| Logging | Pino (structured JSON) |
| Self-coding | Claude Code CLI (headless) |
| Networking | Direct ethernet (Pi <-> EVO), Tailscale (remote access) |

## Setup

Requires a `.env` file with API keys and OAuth credentials. See `src/config.js` for all environment variables.

```bash
# Start via systemd (recommended)
sudo systemctl start clawdbot

# Or manually
node --env-file=.env src/index.js
```

## Project Structure

See `architecture.md` for the complete file tree, data flows, API endpoints, and deployment commands. See `CLAUDE.md` for design decisions, session protocol, and technical reference.

## License

Private project.
