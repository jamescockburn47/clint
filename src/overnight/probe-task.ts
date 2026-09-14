// src/overnight/probe-task.ts — scheduler-invoked PROBE task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2.
//
// Runs at 03:15 London (45 min after consolidate-shadow at 02:30, 15 min after
// trace-analyser at 03:00 so trace-analysis.json is fresh). In-process, memory
// client is warm, uses real EVO 30B + evoSimpleChat + getClawdResponse for
// production drift replay. Lazy-imports heavy bot modules so tests that inject
// deps don't trigger config validation.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { OvernightRunner } from './runner.js';
import { makeProbeStage, type ProbeStageDeps } from './probe.js';
import type { TraceAnalysisClient } from './probe-quality.js';
import type { EvoChatClient } from './probe-patterns.js';
import type { ReplayClient, GraderClient } from './probe-drift.js';

export const PROBE_TASK_HOUR = 3;
export const PROBE_TASK_MINUTE = 15;
export const DRIFT_WINDOW_DAYS = 3;
export const DRIFT_SAMPLE_SIZE = 5;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');
const DEFAULT_LOG_DIR = join(DEFAULT_REPO_ROOT, 'data', 'conversation-logs');
const DEFAULT_TRACE_ANALYSIS_FILE = join(DEFAULT_REPO_ROOT, 'data', 'trace-analysis.json');

/** Module-level idempotency guard: one run per YYYY-MM-DD. */
let lastProbeDate: string | null = null;

/** Reset guard state. Test-only. */
export function resetProbeTaskStateForTests(): void {
  lastProbeDate = null;
}

async function buildDefaultDeps(): Promise<ProbeStageDeps> {
  const { evoSimpleChat } = await import('../evo-llm.js');

  const traceAnalysisClient: TraceAnalysisClient = {
    readAnalysis: async () => {
      if (!existsSync(DEFAULT_TRACE_ANALYSIS_FILE)) return null;
      try {
        const raw = await readFile(DEFAULT_TRACE_ANALYSIS_FILE, 'utf8');
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };

  const evoChatClient: EvoChatClient = {
    chat: async (systemPrompt, userMessage) => {
      const r = await evoSimpleChat(systemPrompt, userMessage, 1500);
      return typeof r === 'string' ? r : null;
    },
  };

  // Replay: use evoSimpleChat as a standalone response generator for historical
  // inputs. This is not the full bot pipeline (no memory retrieval, no tools),
  // but it IS the model layer for roughly 85% of responses, and drift here is
  // meaningful signal. A stricter replay that calls getClawdResponse would
  // require reconstructing the full context (group metadata, socket, memory
  // snapshot), which is out of scope for a nightly probe.
  const replayClient: ReplayClient = {
    replayInput: async (userInput) => {
      const systemPrompt =
        'You are Clint, a WhatsApp assistant for James (a senior commercial litigation solicitor). ' +
        'Respond naturally in plain English, under 200 words. No emojis. No markdown headings. ' +
        'If you do not have enough context, say so briefly.';
      return await evoSimpleChat(systemPrompt, userInput, 400);
    },
  };

  const graderClient: GraderClient = {
    grade: async (originalResponse, newResponse, userInput) => {
      const systemPrompt = `You are judging whether a bot response has drifted.
Given the same user input, compare Response A (what was sent at the time) to
Response B (what the bot would say now). Judge Response B as "better", "worse",
or "neutral" vs Response A. Base your judgment on accuracy, relevance,
completeness, and alignment with James's terse communication style (no fluff,
no hedging, direct, factual).

Output STRICT JSON: {"judged": "better"|"worse"|"neutral", "reason": "one sentence"}
Return ONLY the JSON object.`;
      const userMessage =
        `User input:\n${userInput}\n\n` +
        `Response A (sent at the time):\n${originalResponse}\n\n` +
        `Response B (what the bot would say now):\n${newResponse}`;
      const raw = await evoSimpleChat(systemPrompt, userMessage, 200);
      if (!raw) throw new Error('probe_grader_unavailable');
      try {
        const text = raw.trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1) {
          throw new Error('probe_grader_invalid_json');
        }
        const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        if (!['better', 'worse', 'neutral'].includes(parsed.judged)) throw new Error('probe_grader_invalid_verdict');
        const judged = parsed.judged;
        const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
        return { judged, reason };
      } catch {
        throw new Error('probe_grader_invalid_contract');
      }
    },
  };

  return {
    overnightDir: DEFAULT_OVERNIGHT_DIR,
    logDir: DEFAULT_LOG_DIR,
    traceAnalysisClient,
    evoChatClient,
    replayClient,
    graderClient,
    driftWindowDays: DRIFT_WINDOW_DAYS,
    driftSampleSize: DRIFT_SAMPLE_SIZE,
  };
}

/**
 * Scheduler-invoked PROBE task. Fires once per day at 03:15 London.
 * Composes the probe stage with real clients (or mocks if deps passed).
 */
export async function checkProbe(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ProbeStageDeps,
): Promise<void> {
  if (hours !== PROBE_TASK_HOUR || minutes !== PROBE_TASK_MINUTE) return;
  if (lastProbeDate === todayStr) return;
  lastProbeDate = todayStr;

  const resolvedDeps = deps ?? (await buildDefaultDeps());
  const stage = makeProbeStage(resolvedDeps);

  const runner = new OvernightRunner({
    mode: 'cheap',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: DEFAULT_REPO_ROOT,
    skipJanitor: true,
  });
  runner.register('probe', stage);
  await runner.run(['probe']);
}
