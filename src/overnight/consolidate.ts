// src/overnight/consolidate.ts — CONSOLIDATE stage entry point.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// Composes extract → store → maintenance sub-modules into a single stage function
// suitable for registration with OvernightRunner. Factory-pattern builder lets
// tests inject mock clients while production code uses a thin wrapper that
// supplies real clients from src/memory.js and src/topic-index.js (see
// run-consolidate-manual.ts for the production wiring).

import type { StageContext, StageFn } from './runner.js';
import { ConsolidateExtractor, type ExtractClient } from './consolidate-extract.js';
import { ConsolidateStore, type StoreClient } from './consolidate-store.js';
import {
  ConsolidateMaintenance,
  type MaintenanceClient,
  type TopicIndexClient,
} from './consolidate-maintenance.js';

export interface ConsolidateStageOptions {
  logDir: string;
  extractClient: ExtractClient;
  storeClient: StoreClient;
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
  /** Given today's YYYY-MM-DD, return yesterday's. */
  yesterdayFor: (date: string) => string;
}

/**
 * Build a consolidate stage function from injected clients. The returned
 * function is ready to hand to `runner.register('consolidate', ...)`.
 */
export function makeConsolidateStage(opts: ConsolidateStageOptions): StageFn {
  const extractor = new ConsolidateExtractor({ client: opts.extractClient, logDir: opts.logDir });
  const maintenance = new ConsolidateMaintenance({
    memoryClient: opts.memoryClient,
    topicClient: opts.topicClient,
  });

  return async function runConsolidateStage(ctx: StageContext): Promise<void> {
    const store = new ConsolidateStore({
      client: opts.storeClient,
      overnightDir: ctx.overnightDir,
    });

    const yesterday = opts.yesterdayFor(ctx.date);

    // --- 1. Extract ---------------------------------------------------------
    const extractResult = await extractor.extractForDate(yesterday);
    // A run with files processed but zero candidates extracted is a silent
    // failure mode of the extractor (e.g. EVO /extract offline or prompt
    // broken). Surface it as 'failed' so the health-check and morning report
    // can see it — 10 consecutive nights of candidates=0 previously showed ok.
    const extractFailed = extractResult.errors.length > 0;
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'extract',
      inputs: [`data/conversation-logs/${yesterday}*.jsonl`],
      outputs: [],
      verdict: extractFailed ? 'failed' : extractResult.candidates.length ? 'ok' : 'skipped',
      reason: `files=${extractResult.filesProcessed} candidates=${extractResult.candidates.length} rejected=${extractResult.rejected} errors=${extractResult.errors.length}`,
      evidence_refs: extractResult.errors.map((e) => `extract_error:${e.file}:${e.reason}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    // --- 2. Store (validated) + rejected log -------------------------------
    const storeResult = await store.process({
      candidates: extractResult.candidates,
      date: ctx.date,
    });
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'store',
      inputs: [`extract:${extractResult.candidates.length}`],
      outputs: [
        `memory_store:${storeResult.stored}`,
        `rejected_log:data/overnight/rejected-${ctx.date}.jsonl`,
      ],
      verdict: storeResult.storeErrors.length > 0 || storeResult.rejected > 0 ? 'failed' : storeResult.stored ? 'ok' : 'skipped',
      reason: `stored=${storeResult.stored} rejected=${storeResult.rejected} store_errors=${storeResult.storeErrors.length}`,
      evidence_refs: storeResult.storeErrors.map((e) => `store_error:${e.reason}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    // --- 3. Maintenance + topic index ---------------------------------------
    const maintResult = await maintenance.run(yesterday);
    const maintVerdict: 'ok' | 'failed' = maintResult.errors.length > 0 ? 'failed' : 'ok';
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'maintenance',
      inputs: ['memory:*', `topic-index:${yesterday}`],
      outputs: [
        `expired:${maintResult.maintenance?.expired ?? 0}`,
        `deduped:${maintResult.maintenance?.deduplicated ?? 0}`,
        `topics_indexed:${maintResult.topicsIndexed ?? 0}`,
        `topics_pruned:${maintResult.topicsPruned ?? 0}`,
      ],
      verdict: maintVerdict,
      reason: maintResult.errors.length > 0
        ? `maintenance errors: ${maintResult.errors.join('; ')}`
        : 'maintenance ok',
      evidence_refs: maintResult.errors,
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  };
}
