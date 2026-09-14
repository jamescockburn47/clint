// src/overnight/improve.ts — IMPROVE stage composer (spec §4.4 full pipeline).
//
// Orchestrates the weekly Saturday forge successor:
//   1. Read current week's observations
//   2. Groom (dedupe, cluster, decay, drift surface)         — free
//   3. Synthesise 5-8 final candidates via EVO 30B          — free
//   4. Opus selection (1 Opus session, NULL allowed)        — 1 Opus
//   5. If NULL → log and skip
//   6. Run implement in fresh worktree via Claude Code CLI   — 1 Opus
//   7. Run rolling replay regression check                   — free (EVO)
//   8. Run branch-first deploy → merge or proposal           — free
//   9. Write events at every step for the next morning report

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StageContext, StageFn } from './runner.js';
import { isoWeekOf, queryObservations } from './probe-observations.js';
import { groomObservations } from './improve-grooming.js';
import {
  synthesiseFinalCandidates,
  type FinalCandidate,
  type SynthesisDiagnostics,
} from './improve-synthesis.js';
import { selectCandidate, type OpusClient } from './improve-opus-select.js';
import {
  runRollingReplay,
  stratifiedSample,
  type ReplayPairClient,
  type StratifiedGrader,
} from './improve-replay.js';
import {
  runImplementStage,
  type ClaudeCliClient,
  type ImplementResult,
} from './improve-implement.js';
import { runDeployStage, type DeployClient } from './improve-deploy.js';
import { sampleHistoricalExchanges } from './probe-drift.js';
import type { EvoChatClient } from './probe-patterns.js';

export interface ImproveStageDeps {
  overnightDir: string;
  logDir: string;
  repoRoot: string;
  evoChatClient: EvoChatClient;
  opusClient: OpusClient;
  claudeCliClient: ClaudeCliClient;
  replayPairClient: ReplayPairClient;
  replayGrader: StratifiedGrader;
  deployClient: DeployClient;
}

export interface ImproveStageOptions {
  /** Emergency mode: triggered on-demand outside the Saturday window. */
  emergencyMode?: boolean;
  /** Test seam: override the code implementation boundary. */
  runImplement?: typeof runImplementStage;
  /** Test seam: override historical replay sampling. */
  sampleHistoricalExchanges?: typeof sampleHistoricalExchanges;
  /** Test seam: override branch deploy/proposal handling. */
  runDeploy?: typeof runDeployStage;
}

/**
 * Build the improve stage function. All external dependencies are injected
 * so the stage is fully testable with mocked clients. Production wiring
 * lives in improve-task.ts.
 */
function summariseRejections(d: SynthesisDiagnostics): string {
  if (d.rejections.length === 0) return '0';
  const byReason = new Map<string, number>();
  for (const r of d.rejections) {
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  }
  return Array.from(byReason.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

async function persistSynthesisDebug(
  overnightDir: string,
  date: string,
  diagnostics: SynthesisDiagnostics,
  source: { candidates: number; clusters: number; worse_drifts: number },
): Promise<void> {
  try {
    await mkdir(overnightDir, { recursive: true });
    const file = join(overnightDir, `synthesis-debug-${date}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      source,
      diagnostics,
    };
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Intentional: debug-file failure must not mask the synthesis event.
    // The event still carries a summary via its outputs[] field.
  }
}

export function makeImproveStage(
  deps: ImproveStageDeps,
  opts: ImproveStageOptions = {},
): StageFn {
  return async function runImproveStage(ctx: StageContext): Promise<void> {
    const now = new Date(ctx.date + 'T12:00:00Z');
    const currentWeek = isoWeekOf(now);
    const mode = opts.emergencyMode ? 'emergency' : 'deep';
    const implementStage = opts.runImplement ?? runImplementStage;
    const sampleExchanges = opts.sampleHistoricalExchanges ?? sampleHistoricalExchanges;
    const deployStage = opts.runDeploy ?? runDeployStage;

    // --- Step 1: Read this week's observations -------------------------
    let observations: Awaited<ReturnType<typeof queryObservations>> = [];
    try {
      observations = await queryObservations({
        isoWeek: currentWeek,
        overnightDir: deps.overnightDir,
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'read-observations',
        inputs: [`observations-${currentWeek}.jsonl`],
        outputs: [],
        verdict: 'failed',
        reason: `read failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    // Spec §4.4 trigger: skip if fewer than 5 observations
    if (observations.length < 5) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'skip',
        inputs: [`observations-${currentWeek}.jsonl:${observations.length}`],
        outputs: [],
        verdict: 'skipped',
        reason: `only ${observations.length} observations this week — minimum 5 required (${mode})`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    // --- Step 2: Groom ------------------------------------------------
    const groomed = groomObservations(observations, { now });
    await ctx.appendEvent({
      stage: 'improve',
      phase: 'groom',
      inputs: [`observations:${observations.length}`],
      outputs: [
        `candidates:${groomed.candidates.length}`,
        `clusters:${groomed.patternClusters.length}`,
        `worse_drifts:${groomed.worseDriftAlerts.length}`,
      ],
      verdict: 'ok',
      reason: `groomed ${observations.length} observations`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    // --- Step 3: Synthesise final candidates --------------------------
    let finalCandidates: FinalCandidate[] = [];
    let synthesisDiagnostics: SynthesisDiagnostics | null = null;
    try {
      const synthesisResult = await synthesiseFinalCandidates({
        client: deps.evoChatClient,
        source: {
          candidates: groomed.candidates,
          patternClusters: groomed.patternClusters,
          worseDriftAlerts: groomed.worseDriftAlerts,
        },
      });
      finalCandidates = synthesisResult.candidates;
      synthesisDiagnostics = synthesisResult.diagnostics;
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'synthesis',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `synthesis failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    // When synthesis keeps zero candidates, persist the raw exchange +
    // rejection breakdown to data/overnight/synthesis-debug-<date>.jsonl so
    // we can diagnose later without retriggering the full run.
    if (finalCandidates.length === 0) {
      await persistSynthesisDebug(deps.overnightDir, ctx.date, synthesisDiagnostics, {
        candidates: groomed.candidates.length,
        clusters: groomed.patternClusters.length,
        worse_drifts: groomed.worseDriftAlerts.length,
      });
    }

    const rejectionSummary = summariseRejections(synthesisDiagnostics);
    await ctx.appendEvent({
      stage: 'improve',
      phase: 'synthesis',
      inputs: [`candidates:${groomed.candidates.length}`],
      outputs: [
        `final:${finalCandidates.length}`,
        `raw_bytes:${synthesisDiagnostics.rawResponseBytes ?? 0}`,
        `parsed:${synthesisDiagnostics.parsedCount}`,
        `rejected:${rejectionSummary}`,
      ],
      verdict: 'ok',
      reason: `${finalCandidates.length} final candidates synthesised (${mode})`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    if (finalCandidates.length === 0) {
      return;
    }

    // --- Step 4: Opus selection (1 session) ---------------------------
    let selection;
    try {
      selection = await selectCandidate({
        client: deps.opusClient,
        candidates: finalCandidates,
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'opus-select',
        inputs: [`final:${finalCandidates.length}`],
        outputs: [],
        verdict: 'failed',
        reason: `opus selection failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 1, tokens: 0 },
      });
      return;
    }

    await ctx.appendEvent({
      stage: 'improve',
      phase: 'opus-select',
      inputs: [`final:${finalCandidates.length}`],
      outputs: [selection.selected_id ?? 'null'],
      verdict: selection.selected_id ? 'ok' : 'null',
      reason: selection.selected_id
        ? `selected ${selection.selected_id}: ${selection.rationale}`
        : `null: ${selection.null_reason ?? 'no candidate met the bar'}`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 1, tokens: 0 },
    });

    // --- Step 5: Skip if NULL -----------------------------------------
    if (!selection.selected_id) {
      return;
    }

    const selected = finalCandidates.find((c) => c.id === selection.selected_id)!;

    // --- Step 6: Implement in worktree (1 Opus) -----------------------
    let implementResult: ImplementResult;
    try {
      implementResult = await implementStage({
        candidate: selected,
        repoRoot: deps.repoRoot,
        client: deps.claudeCliClient,
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'implement',
        inputs: [selected.id],
        outputs: [],
        verdict: 'failed',
        reason: `implement threw: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 1, tokens: 0 },
      });
      return;
    }

    await ctx.appendEvent({
      stage: 'improve',
      phase: 'implement',
      inputs: [selected.id],
      outputs: [
        `branch:${implementResult.artifacts.branch ?? 'none'}`,
        `test_exit:${implementResult.artifacts.testExitCode}`,
      ],
      verdict: implementResult.verdict,
      reason: implementResult.reason,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 1, tokens: 0 },
    });

    if (implementResult.verdict !== 'ok') {
      // Debug breadcrumb: persist the captured Claude session output
      // so the morning report has something concrete to pivot on,
      // instead of "git log capture failed — no commits made".
      // Best-effort; ignore write errors.
      try {
        const fsp = await import('node:fs/promises');
        const path = await import('node:path');
        await fsp.mkdir(ctx.overnightDir, { recursive: true });
        const debugFile = path.join(ctx.overnightDir, `implement-debug-${ctx.date}.jsonl`);
        const sample = (str: string, n = 4000) => (str ?? '').slice(0, n);
        const entry = {
          timestamp: new Date().toISOString(),
          candidate_id: selected.id,
          candidate_title: selected.title,
          candidate_scope: selected.scope,
          reason: implementResult.reason,
          claudeStdout: sample(implementResult.artifacts.claudeStdout),
          claudeStderr: sample(implementResult.artifacts.claudeStderr),
          gitLog: implementResult.artifacts.gitLog,
          gitDiff: sample(implementResult.artifacts.gitDiff, 2000),
          testExitCode: implementResult.artifacts.testExitCode,
          testStdoutTail: sample(implementResult.artifacts.testStdout, 2000),
        };
        const NL = String.fromCharCode(10);
        await fsp.appendFile(debugFile, JSON.stringify(entry) + NL, 'utf8');
      } catch {
        // intentional: debug log failures must not cascade
      }
      return;
    }

    // --- Step 7: Rolling replay regression check ----------------------
    let replayResult: Awaited<ReturnType<typeof runRollingReplay>>;
    try {
      const exchanges = await sampleExchanges({
        logDir: deps.logDir,
        referenceDate: ctx.date,
        windowDays: 7,
        sampleSize: 25, // Oversample so stratification can hit 20
      });
      // Attach category via a category extractor — stub as 'conversational'
      // until we wire a real category lookup from trace-analysis.
      const withCategory = exchanges.map((e) => ({ ...e, category: 'conversational' }));
      const samples = stratifiedSample(withCategory, { targetSize: 20 });
      replayResult = await runRollingReplay({
        samples,
        replayPair: deps.replayPairClient,
        grader: deps.replayGrader,
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'replay',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `replay failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    await ctx.appendEvent({
      stage: 'improve',
      phase: 'replay',
      inputs: [`samples:${replayResult.perSampleResults.length}`],
      outputs: [
        `better:${replayResult.betterCount}`,
        `worse:${replayResult.worseCount}`,
        `neutral:${replayResult.neutralCount}`,
      ],
      verdict: replayResult.verdict === 'reject' ? 'rejected' : ['blocked', 'skipped'].includes(replayResult.verdict) ? 'failed' : 'ok',
      reason: `replay verdict: ${replayResult.verdict}${replayResult.warning ? ` (${replayResult.warning})` : ''}`,
      evidence_refs: replayResult.worseExchanges.map((e) => e.inputHash),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    if (['reject', 'blocked', 'skipped'].includes(replayResult.verdict)) {
      return;
    }

    // --- Step 8: Branch-first deploy ---------------------------------
    let deployResult;
    try {
      deployResult = await deployStage({
        candidate: selected,
        artifacts: implementResult.artifacts,
        replay: replayResult,
        client: deps.deployClient,
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'deploy',
        inputs: [selected.id],
        outputs: [],
        verdict: 'failed',
        reason: `deploy failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    await ctx.appendEvent({
      stage: 'improve',
      phase: 'deploy',
      inputs: [selected.id, `tier:${deployResult.tier}`],
      outputs: [deployResult.branchRef ?? 'none'],
      verdict: deployResult.verdict === 'rejected' || deployResult.verdict === 'ci_failed'
        ? 'rejected'
        : 'ok',
      reason: deployResult.reason,
      evidence_refs: [],
      rollback_ref: deployResult.branchRef,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  };
}
