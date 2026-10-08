# Data Flows

## WhatsApp Message → Response

1. Baileys receives message via WebSocket
2. `trigger.js` decides whether to respond: always in DMs; in groups only on direct triggers such as prefix, @mention, reply-to-bot, or explicit group-analysis modes
3. If image: download via `downloadMediaMessage()`, base64 → EVO VL (Claude fallback). Follow-ups within 5 min reuse last image per chat
4. If document (PDF/DOCX): parse on Pi (pdf-parse/mammoth) → summarise via EVO 30B → Claude receives summary (85% token reduction). Raw text cached
5. `buffer.js` builds conversation context (last 10 messages, includes `[Current message]` section)
6. `router.js` classifies activity category (4B classifier first → keyword rules → 0.6B fallback → default)
7. `claude.js` gathers intelligence, scopes tools by category, and sends the main chat/tool request to local Qwen on EVO by default, with MiniMax and Claude as fallback/explicit paths
8. Local EVO models support default chat generation, classification/planning, image understanding, document parsing/summarisation, and embeddings
9. Tool execution loop (up to 5 iterations) — `handler.js` dispatches, `audit.js` logs
10. Final text response sent via Baileys
11. `interaction-log.js` records request/response with routing metadata
12. SSE broadcasts message to dashboard
13. Circuit breakers protect against cascading API failures

## Message Routing Architecture

```text
Message
  → 4B classifier (primary)
  → keywords / learned rules (fallback)
  → keyword/default fallback when classifier unavailable
  → default planning fallback
  → category-based tool scoping
  → local Qwen response path (MiniMax fallback, Claude explicit/premium)
```

Router telemetry logged to `data/router-stats.jsonl`. Learned rules can still be loaded from `data/learned-rules.json`, but the old self-improvement cycle has been retired in favor of the Phase 5 overnight pipeline.

## Response Pipeline — Model Allocation

| Model | Location | Port | Role |
|-------|----------|------|------|
| **Qwen3.6-27B** | EVO X2 | 8080 | Default chat/tool model via llama.cpp/Vulkan |
| **Qwen3-4B** | EVO X2 | 8085 | Primary classifier/planner signal |
| **MiniMax M2.7** | Cloud API | — | Cloud fallback when Qwen is unavailable or unsuitable |
| **Claude Opus 4.6** | Cloud API | — | Premium — explicit request, quality gate, or last resort |
| **Granite-Docling** | EVO X2 | 8084 | Structured document parsing |
| **Memory Service** | EVO X2 | 5100 | Dream storage, memory search, context injection |
| **SearXNG** | EVO X2 | 8888 | Self-hosted web search |

### Key Rules

- **Qwen3.6-27B on EVO is the default chat/tool model**
- **MiniMax M2.7 is cloud fallback when local Qwen is unavailable or unsuitable**
- **Claude Opus is reserved for explicit request, premium-quality paths, or last resort**
- **Images → EVO VL first** — Claude is fallback only
- **Documents are parsed/summarised via EVO** before being passed through the chat path
- **Web search uses SearXNG** on EVO — free, self-hosted
- **If Qwen is unavailable, cloud requests fall back to MiniMax**; Claude is the premium/last-resort path

## Dashboard Data Flow

1. `widgets.js` fetches from Google Calendar + Gmail + Open-Meteo every 5 minutes
2. Results cached in memory (`widgetCache`, 5-min TTL), circuit breakers return stale cache on failure
3. Dashboard loads via HTTP GET `/api/widgets`, `/api/todos`, `/api/soul`
4. Real-time updates via SSE (`/api/events`) for widgets, todos, soul, messages
5. Dashboard shows: weather in header, usage alerts (amber/red), 3-state status dot
6. Dashboard chat input → POST `/api/chat` → Claude → response

## Scheduler (Proactive Notifications)

Runs every 60 seconds (lightweight in-process check):

1. **Todo reminders** — finds items with past reminder times, sends WhatsApp, marks reminded
2. **Side gig meeting alerts** — reads widget cache (no API call), 25-35 min warning
3. **Morning briefing** at 07:00 London — weather + calendar + todos + Henry status + overnight summary
4. **CONSOLIDATE (shadow)** at 02:30 — evidence-chained overnight extraction to shadow candidates
5. **PROBE** at 03:15 — weekly observations, drift checks, candidate proposals
6. **REPORT** at 06:50 — structured morning report from the event log
7. **IMPROVE** Saturday 22:00 London — weekly improvement/proposal pass
8. **System knowledge refresh** — regenerates self-knowledge in EVO memory
9. **Trace analysis** — operational analysis retained alongside the new overnight stages
10. **Ground truth** — operational harvesting retained alongside the new overnight stages
11. **Daily backup** — todos, soul, soul history, and related runtime artifacts
12. **Widget cache refresh** every 5 min
13. **EVO model warm-keeping** every 10 min
14. **Memory cache sync** every 30 min

Zero token cost for routine checks — no Claude API calls.

## Voice Command Flow (EVO X2 → Pi)

1. Fifine USB mic captures audio at 44.1kHz via PyAudio
2. Resample to 16kHz, gain applied (configurable, default 6.0x)
3. RMS speech detection (threshold 3000 after gain)
4. Records until 1.2s silence or 12s max
5. Trims silence → faster-whisper (distil-small.en, CPU, int8)
6. Rejects Whisper hallucinations ("thank you", single short words, etc.)
7. Checks first 45 chars for wake phrase (clawd/claude/claud/clawed/klawd/cloud/claw)
8. Strips wake phrase, classifies command via classifier (port 8081)
9. Routes locally or to the bot HTTP API `/api/voice-command` on EVO for cloud handling
10. Response → Piper TTS → spoken output
11. Dashboard voice overlay: Listening → Processing → Response → auto-dismiss

**Tuning** (env vars, defaults in voice_listener.py): `MIC_GAIN=6.0`, `SPEECH_THRESHOLD=3000`, `SILENCE_DURATION=1.2`, `WHISPER_MODEL=distil-small.en`

## Improve Pipeline (Phase 5)

```
Current-week observations
    → Groom / dedupe / decay / drift surfacing
    → EVO synthesis of evidence-backed candidates
    → Opus selection (nullable)
    → If selected, implement in fresh worktree via Claude Code CLI
    → Rolling replay regression check
    → Branch-first deploy via forge CI or proposal card output
```

Safety: event-log evidence, weekly budget caps, worktree isolation, replay regression checks, banned files list, and proposal-card fallback when auto-merge is not safe.
