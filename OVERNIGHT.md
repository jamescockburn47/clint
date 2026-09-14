> Historical document. September 2026 behavior and operational policy are defined in
> [README](README.md), [AGENTS.md](AGENTS.md) and [the overhaul report](docs/clint-overhaul-2026-09-13.md).
> Earlier AGI, model, deployment and autonomous source-change claims are not current guarantees.

# Overnight Coding System

The overnight coder is a self-improvement loop that runs the local 30B coding model against the Clawdbot codebase every night. It finds router misclassifications, generates unit tests, and audits code quality — all without human intervention or cloud API calls.

## How It Works

**Script:** `evo-overnight/overnight-coder.py` (runs on Pi, calls EVO via direct ethernet)

**Model:** Qwen3-Coder-30B-A3B Q4_K_M on EVO X2 (64K context, ~92 tokens/sec, non-GDN for stability)

**Schedule:** 22:30 → 05:15 nightly, with automatic model swap:
- 22:00 — `llama-swap-coder.timer` stops VL-30B, starts Coder-30B
- 22:05 — Dream mode runs (uses same port, script pauses if overlap)
- 22:30 — `overnight-coder.timer` starts the coding session
- 05:15 — Hard stop (script exits, saves partial results)
- 05:30 — Morning report generates
- 06:00 — `llama-swap-main.timer` stops Coder-30B, starts VL-30B

**Resilience:**
- Circuit breaker: 3 consecutive EVO connection failures → abort and save
- EVO liveness check before each router eval round
- Incremental results saved to disk after each task
- Pause windows: script yields port 8080 during dream mode (22:05-22:25) and knowledge refresh (01:50-02:20)
- Model swap is idempotent (no-op if target already active)

## The Three Tasks

### Task 1: Router Eval Adversarial Expansion

**What it does:** Generates tricky test messages designed to confuse the keyword router, runs them through the actual eval suite, and identifies misclassifications.

**Method:** Reflexion loop — each round:
1. Model identifies a gap in test coverage (e.g. "soul" keyword confusion)
2. Generates 15-20 adversarial messages with expected classifications
3. Runs them through `eval/router-eval.js`
4. Reflects on misclassifications to inform the next round
5. Proposes keyword rules to fix the gaps

**Outputs:**
- New test labels added to eval suite
- Proposed keyword rules (patterns + categories)
- Misclassification analysis
- Git branch: `overnight-eval-YYYY-MM-DD`

**Stops when:** 3 consecutive rounds with 0 misclassifications, time limit, or hard stop.

### Task 2: Unit Test Generation

**What it does:** Generates Node.js unit tests for every testable module in the codebase using `node:test` and `node:assert` (no framework). Uses Reflexion — runs the tests, sees failures, fixes them, repeats.

**Modules covered (27):**
- Core routing: `router.js`, `trigger.js`, `engagement.js`
- Message pipeline: `message-handler.js`, `document-handler.js`, `message-cache.js`
- Knowledge: `lquorum-rag.js`, `memory.js`, `system-knowledge.js`
- Prompt/quality: `prompt.js`, `quality-gate.js`
- Infrastructure: `constants.js`, `evo-client.js`, `circuit-breaker.js`, `usage-tracker.js`, `session-repair.js`
- Logging: `interaction-log.js`, `conversation-logger.js`, `widgets.js`
- Evolution: `evolution-gate.js`, `overnight-report.js`
- Scheduled tasks: `tasks/briefing.js`, `tasks/todo-reminders.js`, `tasks/meeting-alerts.js`

**Method:** Per module, up to 6 rounds:
1. Generate complete test file
2. Run with `node --env-file=.env eval/test-{module}.mjs`
3. If failures: feed output back, model fixes and regenerates
4. Track pass/fail progression across rounds

**Rules enforced in prompt:**
- ESM imports, dynamic `await import()`
- Mock all network calls (tests run offline)
- env vars set before imports
- No test framework dependency

**Outputs:**
- Test files in `eval/test-*.mjs`
- Per-module pass/fail and test count
- Git branch: `overnight-tests-YYYY-MM-DD`

### Task 3: Code Quality Deep Analysis

**What it does:** Feeds the entire codebase (all `src/*.js` + `src/tasks/*.js`) to the model and runs 6 analysis phases in a single conversation (so later phases benefit from context of earlier ones).

**Phases:**
1. **Bug Hunt** — Runtime errors, data loss, incorrect behavior
2. **Dead Code Detection** — Unused exports, unreachable paths, stale variables
3. **Error Handling Gaps** — Missing try/catch, unhandled promises, no timeout on network calls
4. **Performance Issues** — O(n^2) loops, unnecessary re-reads, memory leaks
5. **Security Review** — Injection risks, secrets in code, SSRF, auth bypass
6. **Structure Rules Compliance** — Checks against project rules:
   - Max 300 lines per JS file
   - One file, one job
   - No duplicate functions
   - All EVO comms through `evo-client.js`
   - All constants in `constants.js` / `config.js`
   - Every catch block logs or explains silence
   - Scheduled tasks in `src/tasks/`

**Outputs:**
- `data/overnight-results/code-quality.json` — All findings by category
- Findings in the morning briefing

## Results

All results go to `data/overnight-results/`:

| File | Contents |
|------|----------|
| `summary-YYYY-MM-DD.json` | Full structured results (all tasks, metrics, findings) |
| `briefing-YYYY-MM-DD.md` | Human-readable morning report |
| `code-quality.json` | Latest code quality findings by category |
| `overnight-partial-YYYY-MM-DD.json` | Incremental save (crash recovery) |

## Running Manually

### Full run (daytime, all tasks)
```bash
# From Pi — swaps model automatically, swaps back when done
ssh pi@192.168.1.211 "cd ~/clawdbot && nohup python3 -u evo-overnight/overnight-coder.py --task all --skip-review --force > /tmp/overnight-test.log 2>&1 &"
```

### Single task
```bash
ssh pi@192.168.1.211 "cd ~/clawdbot && python3 -u evo-overnight/overnight-coder.py --task router-eval --skip-review --force"
ssh pi@192.168.1.211 "cd ~/clawdbot && python3 -u evo-overnight/overnight-coder.py --task unit-tests --skip-review --force"
ssh pi@192.168.1.211 "cd ~/clawdbot && python3 -u evo-overnight/overnight-coder.py --task code-quality --skip-review --force"
```

### Monitor progress
```bash
tail -f /tmp/overnight-test.log          # From Pi
# Or from Windows:
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "tail -30 /tmp/overnight-test.log"
```

### Check EVO health during run
```bash
ssh pi@192.168.1.211 "ssh james@10.0.0.2 'sensors | grep -E \"edge|Tctl|PPT\"; echo ---; cat /sys/class/drm/card1/device/gpu_busy_percent'"
```

### Flags
| Flag | Effect |
|------|--------|
| `--force` | Bypass time guards (run during daytime). Auto-swaps model to coder and back. |
| `--skip-review` | Skip Opus 4.6 post-review of results (saves API cost on test runs) |
| `--task X` | Run only one task: `router-eval`, `unit-tests`, `code-quality`, or `all` |

## Acting on Results

### Router eval findings

The morning briefing shows misclassifications and proposed rules. To apply:

1. **Review misclassifications** — Are the expected categories correct? The model sometimes misjudges intent.
2. **Check proposed rules** — Each has a regex pattern, target category, and rationale.
3. **Apply selectively** — Add validated rules to `data/learned-rules.json`. The router loads these at startup.
4. **Run eval** — `node --env-file=.env eval/router-eval.js` to verify improvements.
5. **Merge branch** — `git merge overnight-eval-YYYY-MM-DD` if the new test labels are useful.

### Unit test findings

1. **Check branches** — `overnight-tests-YYYY-MM-DD` on Pi repo.
2. **Run locally** — `node --env-file=.env eval/test-router.mjs` etc.
3. **Cherry-pick passing tests** — Not all generated tests will be good. Review and keep the useful ones.
4. **Move to test/** — Production tests go in `test/`, overnight scratch in `eval/`.

### Code quality findings

1. **Read `data/overnight-results/code-quality.json`** or the briefing.
2. **Prioritise** — Critical bugs first, then high-severity structure violations.
3. **Structure rules** — Phase 6 findings are often actionable (file too long, duplicated function, constants scattered).
4. **Create evolution tasks** — For straightforward fixes, use the `evolution_task` WhatsApp tool.

## Architecture

```
                    ┌─────────────────────────┐
                    │   overnight-coder.timer  │
                    │   (Pi, 22:30 daily)      │
                    └────────┬────────────────┘
                             │
                    ┌────────▼────────────────┐
                    │  overnight-coder.py      │
                    │  (Pi, Python)            │
                    │                          │
                    │  1. Router Eval           │
                    │  2. Unit Tests            │
                    │  3. Code Quality          │
                    └────────┬────────────────┘
                             │ HTTP (10.0.0.2:8080)
                    ┌────────▼────────────────┐
                    │  Qwen3-Coder-30B-A3B    │
                    │  (EVO X2, llama.cpp)     │
                    │  64K ctx, ~92 t/s        │
                    └─────────────────────────┘

Model Swap Timeline (daily):
  06:00  ──▶  VL-30B (daytime, vision)  ──▶  22:00
  22:00  ──▶  Coder-30B (overnight)     ──▶  06:00

Services on EVO:
  llama-server-main   (VL-30B, port 8080, daytime)
  llama-server-coder  (Coder-30B, port 8080, overnight)
  Conflicts= directive prevents both running simultaneously

Timers:
  llama-swap-coder.timer  →  22:00 daily
  llama-swap-main.timer   →  06:00 daily
  overnight-coder.timer   →  22:30 daily (Pi)
```

## Troubleshooting

**Script exits immediately:** Check if `--force` flag is set (time guard blocks daytime runs without it).

**"EVO coder model not ready":** The model swap at 22:00 may have failed. Check `journalctl -u llama-swap-coder.service` on EVO.

**All rounds fail with connection errors:** Circuit breaker fires after 3 failures. Check EVO is reachable: `ping 10.0.0.2`. Check service: `systemctl status llama-server-coder` on EVO.

**Model swap didn't happen at 06:00:** Timers may not be started. Run on EVO: `sudo systemctl start llama-swap-coder.timer llama-swap-main.timer`. Verify: `systemctl status llama-swap-main.timer`.

**VL model still running during overnight:** Coder swap didn't fire. Manually: `ssh james@10.0.0.2 'sudo ~/llama-swap-coder.sh'`.

**GPU temps too high:** Check with `sensors` on EVO. GPU edge > 95C = add cooling. 88C sustained is fine but not ideal. The non-GDN Coder-30B draws less power (~99W) than the 80B GDN model (~120W).
