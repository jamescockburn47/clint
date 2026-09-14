// src/overnight/improve-replay.ts — rolling replay regression check (spec §5.1).
//
// Samples 20 real exchanges stratified across channels + categories, runs
// each input through BOTH the main bot and the worktree bot, grades the
// diff with EVO 30B, and produces a verdict:
//   - any "worse" → reject
//   - ≥2 "better" and zero "worse" → pass
//   - all neutral → pass_with_warning
//
// Near-identical responses (Levenshtein ratio > 0.9) are recorded as
// neutral without calling the grader — saves EVO calls and honest.

import type { HistoricalExchange } from './probe-drift.js';

/** Categories to stratify across (spec §5.1). */
export const STRATA = [
  'conversational',
  'planning',
  'recall',
  'system',
  'general_knowledge',
] as const;

export type Stratum = (typeof STRATA)[number];

/**
 * Sensitive-term skip list (spec §5.1 privacy note). Any exchange whose
 * input contains one of these terms is skipped and not replayed. Populate
 * with real client names and confidential identifiers before deploy.
 */
export const SENSITIVE_TERMS: readonly string[] = [
  // Add real client identifiers here before Phase 4 runs in production
];

export interface StratifiedSample extends HistoricalExchange {
  category: Stratum;
}

export interface SampleOptions {
  targetSize: number;
  /** Override the sensitive-term skip list. Defaults to SENSITIVE_TERMS. */
  sensitiveTerms?: readonly string[];
}

export interface ReplayPairClient {
  /** Run the input through the main (baseline) bot, return response or null. */
  replayAgainstMain(userInput: string): Promise<string | null>;
  /** Run the input through the worktree (candidate) bot, return response or null. */
  replayAgainstWorktree(userInput: string): Promise<string | null>;
}

export interface StratifiedGrader {
  /**
   * Grade response B vs A per the rubric in spec §5.1.
   * Returns better/worse/neutral plus a one-sentence reason.
   */
  grade(
    original: string,
    worktreeResponse: string,
    userInput: string,
    context?: string,
  ): Promise<{ judged: 'better' | 'worse' | 'neutral'; reason: string }>;
}

export interface RollingReplayOptions {
  samples: StratifiedSample[];
  replayPair: ReplayPairClient;
  grader: StratifiedGrader;
}

export interface RollingReplayResult {
  verdict: 'pass' | 'pass_with_warning' | 'reject' | 'skipped' | 'blocked';
  betterCount: number;
  worseCount: number;
  neutralCount: number;
  worseExchanges: StratifiedSample[];
  warning?: string;
  perSampleResults: Array<{
    sample: StratifiedSample;
    judged: 'better' | 'worse' | 'neutral' | 'unverifiable';
    reason: string;
  }>;
}

function hasSensitiveTerm(input: string, terms: readonly string[]): boolean {
  const lower = input.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

/**
 * Stratified sample across STRATA. For each stratum, pick up to
 * `targetSize / STRATA.length` exchanges. If a stratum has too few, its
 * quota overflows into other strata.
 */
export function stratifiedSample<
  T extends HistoricalExchange & { category?: string },
>(exchanges: T[], opts: SampleOptions): StratifiedSample[] {
  const terms = opts.sensitiveTerms ?? SENSITIVE_TERMS;
  const filtered = exchanges.filter((e) => !hasSensitiveTerm(e.userInput, terms));

  const byStratum = new Map<Stratum, T[]>();
  for (const s of STRATA) byStratum.set(s, []);
  for (const ex of filtered) {
    const cat = (ex.category ?? 'conversational') as Stratum;
    if (STRATA.includes(cat)) {
      byStratum.get(cat)!.push(ex);
    } else {
      byStratum.get('conversational')!.push(ex);
    }
  }

  const perStratum = Math.floor(opts.targetSize / STRATA.length);
  const result: StratifiedSample[] = [];
  let deficit = 0;

  for (const stratum of STRATA) {
    const list = byStratum.get(stratum)!;
    const take = Math.min(list.length, perStratum);
    for (let i = 0; i < take; i++) {
      const ex = list[i]!;
      result.push({ ...(ex as HistoricalExchange), category: stratum });
    }
    if (take < perStratum) deficit += perStratum - take;
  }

  // Fill deficit with extras from strata that have overflow
  if (deficit > 0) {
    for (const stratum of STRATA) {
      if (deficit === 0) break;
      const list = byStratum.get(stratum)!;
      for (let i = perStratum; i < list.length && deficit > 0; i++) {
        result.push({ ...(list[i]! as HistoricalExchange), category: stratum });
        deficit--;
      }
    }
  }

  return result.slice(0, opts.targetSize);
}

/**
 * Run the rolling replay regression check. Replays each sample through
 * both main and worktree bots, grades the diff, and produces a verdict
 * per spec §5.1 rules.
 */
export async function runRollingReplay(
  opts: RollingReplayOptions,
): Promise<RollingReplayResult> {
  const perSample: RollingReplayResult['perSampleResults'] = [];
  let betterCount = 0;
  let worseCount = 0;
  let neutralCount = 0;
  const worseExchanges: StratifiedSample[] = [];
  let unavailable = 0;

  for (const sample of opts.samples) {
    let mainResp: string | null;
    let wtResp: string | null;
    try { [mainResp, wtResp] = await Promise.all([
      opts.replayPair.replayAgainstMain(sample.userInput),
      opts.replayPair.replayAgainstWorktree(sample.userInput),
    ]); } catch {
      mainResp = null; wtResp = null;
    }

    if (!mainResp?.trim() || !wtResp?.trim()) {
      // Missing replay → count as neutral, don't grade
      perSample.push({
        sample,
        judged: 'unverifiable',
        reason: 'replay unavailable',
      });
      unavailable++;
      continue;
    }

    // Near-identical shortcut
    if (mainResp === wtResp) {
      perSample.push({
        sample,
        judged: 'neutral',
        reason: 'responses near-identical, no grading needed',
      });
      neutralCount++;
      continue;
    }

    let verdict;
    try {
      verdict = await opts.grader.grade(mainResp, wtResp, sample.userInput);
      if (!['better', 'worse', 'neutral'].includes(verdict.judged) || !verdict.reason) throw new Error('invalid grade');
    } catch {
      unavailable++;
      perSample.push({ sample, judged: 'unverifiable', reason: 'grader unavailable or invalid' });
      continue;
    }
    perSample.push({ sample, judged: verdict.judged, reason: verdict.reason });

    switch (verdict.judged) {
      case 'better':
        betterCount++;
        break;
      case 'worse':
        worseCount++;
        worseExchanges.push(sample);
        break;
      case 'neutral':
        neutralCount++;
        break;
    }
  }

  // Verdict rules (spec §5.1)
  let verdict: RollingReplayResult['verdict'];
  let warning: string | undefined;
  if (worseCount > 0) {
    verdict = 'reject';
  } else if (unavailable > 0 || perSample.length === 0) {
    verdict = 'blocked';
    warning = 'replay evidence incomplete';
  } else if (betterCount >= 2) {
    verdict = 'pass';
  } else if (neutralCount === perSample.length && perSample.length > 0) {
    verdict = 'pass_with_warning';
    warning = 'change had no material effect on real conversations — why was it proposed?';
  } else if (perSample.length === 0) {
    verdict = 'skipped';
  } else {
    verdict = 'pass_with_warning';
    warning = `only ${betterCount} better judgment, spec requires ≥2 for a clean pass`;
  }

  return {
    verdict,
    betterCount,
    worseCount,
    neutralCount,
    worseExchanges,
    warning,
    perSampleResults: perSample,
  };
}
