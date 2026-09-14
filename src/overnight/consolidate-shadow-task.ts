// src/overnight/consolidate-shadow-task.ts — scheduler-invoked shadow consolidate task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.3.
//
// Top-level task function called by src/scheduler.js on its 60-second tick.
// Gates on 02:30 London and a per-day `lastShadowDate` guard so the stage
// runs exactly once per night even if the scheduler tick lands on 02:30
// multiple times (unlikely) or the bot restarts mid-minute.
//
// Dependency injection: the function accepts a `deps` parameter with all
// external clients. In production the factory builds real clients from
// memory.js / topic-index.js. In tests, mocks are passed directly.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';
import { OvernightRunner } from './runner.js';
import { makeConsolidateStage } from './consolidate.js';
import { ShadowSink } from './consolidate-shadow-sink.js';
import { PromotedSink, type PromotedSinkDeps } from './consolidate-promoted-sink.js';
import { EXTRACTION_PROMPT, parseExtractionResponse } from './grounded-memory.js';
import type { StoreClient } from './consolidate-store.js';
import type { ExtractClient } from './consolidate-extract.js';
import type { MaintenanceClient, TopicIndexClient } from './consolidate-maintenance.js';
import config from '../config.js';
import { z } from 'zod';

/** London hour the task fires. */
export const SHADOW_TASK_HOUR = 2;
/** London minute the task fires (30 min after old 2 AM task). */
export const SHADOW_TASK_MINUTE = 30;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');
const DEFAULT_LOG_DIR = join(DEFAULT_REPO_ROOT, 'data', 'conversation-logs');

/** Module-level idempotency guard: one run per YYYY-MM-DD. */
let lastShadowDate: string | null = null;

/**
 * Per-run counter for extract-debug file writes. Caps disk usage on a
 * completely broken extractor that would otherwise produce one debug entry
 * per conversation. Reset at the start of each run in checkConsolidateShadow.
 */
let extractDebugWritesThisRun = 0;
const EXTRACT_DEBUG_MAX_PER_RUN = 5;

/** Reset guard state. Test-only. */
export function resetShadowTaskStateForTests(): void {
  lastShadowDate = null;
  extractDebugWritesThisRun = 0;
}

/**
 * Wrap an ExtractClient so that zero-candidate responses get logged with
 * input/output context and (for the first N per run) persisted to
 * data/overnight/extract-debug-<date>.jsonl for root-cause analysis.
 * Exported for testing. Does not alter the happy path at all — a non-empty
 * candidates array is returned unchanged.
 */
export function withExtractDebug(
  inner: ExtractClient,
  overnightDir: string,
  todayStr: string,
): ExtractClient {
  return {
    extractCandidates: async (conversation, source) => {
      const result = await inner.extractCandidates(conversation, source);
      if (result.candidates.length > 0) return result;

      const conversationLength = conversation.length;

      logger.info(
        {
          source,
          conversation_length: conversationLength,
        },
        'consolidate extract returned zero candidates',
      );

      if (extractDebugWritesThisRun < EXTRACT_DEBUG_MAX_PER_RUN) {
        extractDebugWritesThisRun++;
        try {
          await mkdir(overnightDir, { recursive: true });
          const file = join(overnightDir, `extract-debug-${todayStr}.jsonl`);
          const entry = {
            timestamp: new Date().toISOString(),
            source,
            conversation_length: conversationLength,
          };
          await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            'failed to write extract-debug entry',
          );
        }
      }

      return result;
    },
  };
}

export interface ShadowTaskDeps {
  mode?: 'shadow' | 'promoted';
  overnightDir: string;
  logDir: string;
  repoRoot: string;
  extractClient: ExtractClient;
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
  /**
   * Optional PromotedSink deps. When supplied AND CONSOLIDATE_MODE !=
   * 'shadow', the promoted sink is used instead of ShadowSink so
   * validated candidates are written to EVO memory directly.
   */
  promotedSinkDeps?: PromotedSinkDeps;
}

/**
 * Select the store client for a given task invocation based on the
 * CONSOLIDATE_MODE env var. Exposed for tests.
 *   - `shadow` (legacy): ShadowSink → shadow-candidates-<date>.jsonl.
 *   - `promoted` (default): PromotedSink → EVO memory.
 * Falls back to ShadowSink if promoted is requested but promotedSinkDeps
 * is missing, so a misconfigured environment does not break the task.
 */
export function selectStoreClient(
  deps: ShadowTaskDeps,
  todayStr: string,
): StoreClient {
  const mode = deps.mode ?? config.consolidateMode;
  if (mode === 'shadow') {
    return new ShadowSink({ overnightDir: deps.overnightDir, todayStr });
  }
  if (!deps.promotedSinkDeps) {
    logger.warn(
      { mode },
      'consolidate: CONSOLIDATE_MODE=promoted but promotedSinkDeps missing — falling back to ShadowSink',
    );
    return new ShadowSink({ overnightDir: deps.overnightDir, todayStr });
  }
  const archive = new ShadowSink({ overnightDir: deps.overnightDir, todayStr });
  const promoted = new PromotedSink({ deps: deps.promotedSinkDeps });
  return { storeValidated: async candidate => {
    await archive.storeValidated(candidate);
    // The legacy remote store has no enforced read scopes. Private/unknown sources stay local.
    if (candidate.sources.length && candidate.sources.every(source => source.chatJid?.endsWith('@g.us'))) {
      await promoted.storeValidated(candidate);
    }
  } };
}

/**
 * Build a default deps object for production use. Imports memory.js and
 * topic-index.js lazily so tests that inject deps don't pay the cost of
 * loading them (and don't trip config validation on missing env vars).
 */
export async function buildConsolidateDeps(): Promise<ShadowTaskDeps> {
  const { triggerMaintenance, storeMemory, checkEvoHealth } = await import('../memory.js');
  const { evoSimpleChat } = await import('../evo-llm.js');
  const { indexDayTopics, pruneTopicIndex } = await import('../topic-index.js');
  await checkEvoHealth({ recover: false });

  // The model selects IDs; the extractor resolves each against the original log.
  const extractClient: ExtractClient = {
    extractCandidates: async (conversation, source) => {
      const raw = await evoSimpleChat(EXTRACTION_PROMPT, conversation, 2000, 120_000);
      return { candidates: parseExtractionResponse(raw) };
    },
  };

  const memoryClient: MaintenanceClient = {
    triggerMaintenance: async () => {
      const r = z.object({ expired: z.number().int().nonnegative(),
        deduplicated: z.number().int().nonnegative(), total_after: z.number().int().nonnegative(),
      }).parse(await triggerMaintenance());
      return {
        expired: r.expired ?? 0,
        deduplicated: r.deduplicated ?? 0,
        total_after: r.total_after ?? 0,
      };
    },
  };

  const topicClient: TopicIndexClient = {
    indexDayTopics: async (d) => indexDayTopics(d),
    pruneTopicIndex: async (days) => {
      const n = pruneTopicIndex(days);
      return typeof n === 'number' ? n : 0;
    },
  };

  const promotedSinkDeps: PromotedSinkDeps = {
    storeMemory: async (fact, category, tags, confidence, source) => {
      return z.object({ stored: z.boolean().optional(), queued: z.boolean().optional(),
        offline: z.boolean().optional(), error: z.string().optional(),
        // The nightly worker retries a failed night itself; a local queue would store the statement twice.
      }).parse(await storeMemory(fact, category, tags, confidence, source, { queueOnFailure: false }));
    },
  };

  return {
    overnightDir: DEFAULT_OVERNIGHT_DIR,
    logDir: DEFAULT_LOG_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    extractClient,
    memoryClient,
    topicClient,
    promotedSinkDeps,
  };
}

/** Given today's YYYY-MM-DD, return yesterday's. UTC noon anchor avoids DST drift. */
function yesterdayFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Scheduler-invoked shadow consolidate task. Runs once per day at 02:30 London.
 * Writes events to data/overnight/events-<todayStr>.jsonl and validated
 * candidates to data/overnight/shadow-candidates-<todayStr>.jsonl.
 */
export async function checkConsolidateShadow(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ShadowTaskDeps,
): Promise<void> {
  if (hours !== SHADOW_TASK_HOUR || minutes !== SHADOW_TASK_MINUTE) return;
  if (lastShadowDate === todayStr) return;
  lastShadowDate = todayStr;
  extractDebugWritesThisRun = 0;

  const resolvedDeps = deps ?? (await buildConsolidateDeps());

  const storeClient = selectStoreClient(resolvedDeps, todayStr);

  // Wrap extract client with debug layer (outermost) → source synthesis (inner).
  // Debug observes the raw zero-candidate result before synthesis attaches sources,
  // which is the state we actually need to diagnose.
  const debugWrapped = withExtractDebug(
    resolvedDeps.extractClient,
    resolvedDeps.overnightDir,
    todayStr,
  );

  const stage = makeConsolidateStage({
    logDir: resolvedDeps.logDir,
    extractClient: debugWrapped,
    storeClient,
    memoryClient: resolvedDeps.memoryClient,
    topicClient: resolvedDeps.topicClient,
    yesterdayFor,
  });

  const runner = new OvernightRunner({
    mode: 'cheap',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: resolvedDeps.repoRoot,
    skipJanitor: true, // in-process: nothing to clean
  });
  runner.register('consolidate', stage);
  await runner.run(['consolidate']);
}
