# Overnight Simplification — Design Spec

> Supersedes: `2026-04-10-compound-dream-overnight-design.md`, `2026-04-10-compound-dream-phase1-shadow-mode-design.md`

## Problem

The overnight pipeline has grown to 9+ separately scheduled tasks with overlapping concerns. Memory retrieval uses 6 category-gated streams. Consolidate silently extracts nothing due to a `max_tokens` bug. Dream, insight, and diary categories create retrieval paths nobody benefits from. The system is diffuse and overcomplicated.

Clint should have personality, opinions, and accumulated experience — but that doesn't require this much machinery.

## Design Principles

1. **Memories are memories.** One store, one retrieval path. No category-gated streams. If a memory is relevant to the conversation, it surfaces — whether it's a fact, an opinion, a reflection, or a document reference.
2. **Soul is pinned personality.** Always injected. People, patterns, lessons, boundaries, interests, opinions. Shaped by overnight reflection.
3. **Observations are operational.** Weekly accumulation for the improve cycle. Not memories, not personality.
4. **Overnight is one job.** Extract, reflect, observe, maintain — sequentially, in one task.

## §1 Memory Architecture

### §1.1 Single retrieval path

Replace the 6-stream cortex with 2 streams:

| Stream | Trigger | Budget |
|--------|---------|--------|
| **Identity** | Always (cached 5 min) | 2,000 chars |
| **Relevant** | `searchMemory(context, null, 12)` — no category filter | 8,000 chars |

Keep **lquorum** (1,500 chars) and **webPrefetch** unchanged — different concerns.

Total budget: ~12K chars, same as today.

**What this removes:**
- `dreams` stream (category-gated `searchMemory(..., 'dream', ...)`)
- `insights` stream (category-gated `getInsightMemories(...)`)
- `system` stream (`getLiveSystemSnapshot()` — system knowledge is already in SELF_AWARENESS prompt)
- `DREAM_CATEGORIES`, `INSIGHT_CATEGORIES`, `MEMORY_CATEGORIES` gate sets
- `needsMemories()` predicate — all categories get relevant memories
- `getDreamMemories()`, `getOvernightInsights()`, `getInsightMemories()` methods

**What stays:**
- `getIdentityMemories()` with 5-min TTL cache
- `getRelevantMemories()` but without category restrictions — fires for CONVERSATIONAL, RECALL, PLANNING, GENERAL_KNOWLEDGE, SYSTEM, TRAVEL. Deterministic categories (EMAIL, CALENDAR, TASK) remain exempt — they're tool calls, memory adds latency for no benefit.
- `getSoulPromptFragment()` — always injected into system prompt
- `formatMemoriesForPrompt()` — formats whatever comes back from search

### §1.2 Memory categories simplify

Stop using category for retrieval gating. Categories remain as metadata for maintenance (TTL, deduplication) but not for retrieval. Overnight reflections are stored as regular memories — no special `dream` or `insight` category needed. They surface when semantically relevant.

Identity memories (`category: identity`) remain special — they're cached and always injected. Soul entries remain separate (file-based, always injected). Everything else: one search, one format, one injection.

### §1.3 Soul expansion

Add two sections to the soul structure:

- **interests** — topics Clint is curious about, finds engaging (e.g. "I find the intersection of AI governance and legal practice genuinely interesting")
- **opinions** — positions Clint holds from accumulated experience (e.g. "Firms that resist AI tooling will lose panel status within 3 years")

These get injected via `getSoulPromptFragment()` alongside people/patterns/lessons/boundaries. They shape Clint's tone and engagement more actively than retrieved memories.

Threshold promotion unchanged: routine (3 days), corrective (2), critical (immediate). Decay at 14 days without repetition.

## §2 Overnight DREAM Job

One scheduled task at **02:30 London**, replacing consolidate-shadow + probe + trace-analyser + ground-truth.

### §2.1 Phase 1: EXTRACT

1. Read yesterday's conversation logs from `data/conversation-logs/`
2. Chunk into windows of ~30 messages
3. Send each chunk to EVO `/extract` endpoint with `max_tokens: 4000`
4. Validate evidence chains (hash + excerpt per candidate) via existing `consolidate-validate.ts`
5. Store valid candidates directly to EVO memory (`store_results: true`) — **no shadow mode**
6. Write event: `stage: 'dream', phase: 'extract'`

### §2.2 Phase 2: REFLECT

1. Feed yesterday's conversations + extracted memories to EVO 30B
2. Prompt asks Clint to write as himself — first person, subjective:
   - What interested him and why
   - What opinions he formed
   - What he found tedious or unproductive
   - Who he connected with and impressions of them
   - What he's curious about and wants to explore
   - What he'd push back on or do differently next time
3. Store reflection as regular memories (no special category — they surface by relevance)
4. Extract soul observations with severity tags from the reflection:
   - People observations → soul `people` section
   - Behavioural patterns → soul `patterns` section
   - Interests/curiosity → soul `interests` section (new)
   - Opinions formed → soul `opinions` section (new)
5. Feed observations into existing `addObservation()` threshold system
6. Write event: `stage: 'dream', phase: 'reflect'`

### §2.3 Phase 3: OBSERVE

1. Run pattern extraction from yesterday's conversations (existing `probe-patterns.ts` logic)
2. Run drift check: sample recent exchanges, replay against current bot, grade (existing `probe-drift.ts`)
3. If weekly quality check results are available, enrich with quality-failure observations
4. Propose improvement candidates if patterns are strong enough (≥2 evidence refs)
5. Append to `data/overnight/observations-<iso-week>.jsonl`
6. Monday: roll over prior week's observations to `data/overnight/archive/`
7. Write event: `stage: 'dream', phase: 'observe'`

### §2.4 Phase 4: MAINTAIN

1. Trigger EVO memory maintenance (expire volatile categories, deduplicate)
2. Update topic index for yesterday's conversations
3. Write event: `stage: 'dream', phase: 'maintain'`

## §3 Trace Analysis → Weekly Quality Check

Replace per-message reasoning traces with a weekly quality check.

**Schedule:** Weekly (e.g. Wednesday 03:00) — gives OBSERVE phase data mid-week.

**Process:**
1. Select ~10 representative test inputs spanning categories (conversational, recall, planning, tool-use, group advisory)
2. Send each to Clint via internal API (or the existing `getClawdResponse` path)
3. Grade each response: routing correctness, response quality, tool usage, style alignment
4. Write results to `data/quality-check-<date>.json`
5. Write event: `stage: 'operations', phase: 'quality-check'`

**What this replaces:**
- `src/tasks/trace-analyser.js` (nightly 7-day trace analysis)
- `src/tasks/ground-truth.js` (claim verification — not providing value)

Per-message trace logging (`data/reasoning-traces.jsonl`) is kept — it's lightweight (one append per message) and feeds the console traces tab. The nightly analysis job that reads it is what gets replaced.

**What the OBSERVE phase reads:** Yesterday's conversation logs for patterns/drift (nightly), plus the most recent quality check file when available (weekly).

## §4 Retained Tasks

These stay as separate scheduled tasks — they're operational, not part of Clint's experience:

| Task | Time | Purpose |
|------|------|---------|
| `system-refresh` | 02:00 | Seed system knowledge to EVO memory |
| `project-sync` | 02:00 | Sync project docs to memory |
| `daily-backup` | 03:00 | Back up critical files |
| `sovren-cross-reference` | 03:30 | Project-specific cross-reference |
| **DREAM** | **02:30** | **Extract → Reflect → Observe → Maintain** |
| `report` | 06:50 | Render morning report from events + observations |
| `briefing` | 07:00 | Send WhatsApp morning summary |
| `quality-check` | Wed 03:00 | Weekly representative test + grade |
| `improve` | Sat 22:00 | Weekly forge: groom → select → implement → replay → deploy |

## §5 Files Removed

| File | Reason |
|------|--------|
| `src/overnight/consolidate-shadow-task.ts` | Replaced by dream task |
| `src/overnight/consolidate-shadow-sink.ts` | No more shadow mode |
| `src/overnight/consolidate-source-synthesizer.ts` | Shadow mode artefact |
| `src/overnight/probe-task.ts` | Folded into dream OBSERVE phase |
| `src/overnight/probe.ts` | Folded into dream OBSERVE phase |
| `src/overnight/probe-quality.ts` | Reads trace-analysis.json — replaced by quality check |
| `src/tasks/trace-analyser.js` | Replaced by weekly quality check |
| `src/tasks/ground-truth.js` | Not providing value — dropped |

Probe sub-modules retained (used by dream OBSERVE phase):
- `probe-patterns.ts`, `probe-candidates.ts`, `probe-drift.ts`, `probe-observations.ts`

## §6 Files Modified

| File | Change |
|------|--------|
| `src/scheduler.js` | Remove `checkProbe`, `checkTraceAnalysis`, `checkGroundTruth`. Add `checkDream`. |
| `src/cortex.js` | Collapse to 2 streams (identity + relevant). Remove category gating. |
| `src/memory.js` | Remove `getDreamMemories`, `getOvernightInsights`, `getInsightMemories`. Keep `getRelevantMemories` without category restriction. |
| `src/tools/soul.js` | Add `interests` and `opinions` sections. Update `getSoulPromptFragment()`. |
| `src/overnight/morning-report-text.ts` | Update for dream stage events. Fix SOVREN undefined bug. |
| `src/overnight/events.ts` | Add `'dream'` to `OVERNIGHT_STAGES`. |
| `~/clawdbot-memory/memory-service/llm_client.py` | `max_tokens: 1000` → `4000`. Add explicit `JSONDecodeError` logging. |
| `src/tasks/sovren-contribution-cross-reference.js` | Use `phase`/`reason` instead of `type`. Use shared `appendEvent`. |

## §7 Files Created

| File | Purpose |
|------|--------|
| `src/overnight/dream-task.ts` | Scheduler entry: fires at 02:30, runs dream stage |
| `src/overnight/dream.ts` | Dream stage composer: extract → reflect → observe → maintain |
| `src/overnight/dream-reflect.ts` | EVO 30B reflection with soul observation extraction |
| `src/overnight/dream-extract.ts` | Chunked extraction with `max_tokens: 4000` |
| `src/tasks/quality-check.ts` | Weekly quality check: test messages → grade → write results |

## §8 Contracts Preserved

- `OvernightEvent` schema unchanged (stage adds `'dream'`)
- `queryEvents()` / `appendEvent()` unchanged
- Morning report reads events by stage — dream events render naturally
- Console `/api/overnight-events/:date` unchanged (events are events)
- Console `/api/morning-report/:date` unchanged (report reads events)
- Console `/api/soul` — add `interests` and `opinions` arrays to response
- `getIdentityMemories()` — unchanged
- `getSoulPromptFragment()` — extended with interests/opinions
- `buildAndRenderReport()` — updated to handle dream stage events

## §9 Migration

1. Deploy EVO memory service fix (`max_tokens: 4000`) immediately
2. Deploy cortex simplification (collapse to 2 streams)
3. Deploy dream task + remove old tasks
4. Deploy soul expansion (interests, opinions)
5. Deploy weekly quality check
6. Verify: first dream run produces >0 extracted memories, reflection stored, observations appended
7. Saturday improve sees accumulated observations
