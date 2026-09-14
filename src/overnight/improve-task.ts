/** Improvement review entrypoint. Production proposals are local and evidence-derived. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OvernightRunner } from './runner.js';
import { makeImproveStage, type ImproveStageDeps } from './improve.js';
import { appendEvent, queryEvents } from './events.js';
import { buildLearningReview, readLearningCandidates, writeLearningReview } from './learning-review.js';
import { reflectOnStatements } from './dream-reflection.js';
import { failureCode } from './learning-worker.js';

export const IMPROVE_TASK_HOUR = 22;
export const IMPROVE_TASK_MINUTE = 0;
export const IMPROVE_TASK_DAY_OF_WEEK = 6;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let lastImproveDate: string | null = null;
export function resetImproveTaskStateForTests(): void { lastImproveDate = null; }

/** Generate reviewable improvement tasks from observed failures without executing model-written code. */
export async function createImprovementReview(date: string, dir: string): Promise<void> {
  const events = await queryEvents({ date, overnightDir: dir });
  const memories = await readLearningCandidates(dir, date);
  const digest = createHash('sha256').update(JSON.stringify({ memories,
    events: events.filter(event => event.stage !== 'improve' && event.stage !== 'report') })).digest('hex');
  let reused = false;
  try {
    const prior = JSON.parse(await readFile(join(dir, 'proposals', `learning-${date}.json`), 'utf8'));
    reused = prior.input_digest === digest && prior.generation_status === 'completed';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (reused) {
    await appendEvent({ stage: 'improve', phase: 'proposal-reused', inputs: [],
      outputs: [`proposals/learning-${date}.json`], verdict: 'skipped', reason: 'Successful review matches the current source inputs.',
      evidence_refs: [], rollback_ref: null, budget: { opus_sessions: 0, tokens: 0 } }, { date, overnightDir: dir });
    return;
  }
  const review = buildLearningReview(date, memories, events);
  review.input_digest = digest;
  let reflectionFailed = false;
  try {
    const { evoSimpleChat } = await import('../evo-llm.js');
    review.hypotheses = await reflectOnStatements(memories, (system, input) => evoSimpleChat(system, input, 2000, 120_000));
  } catch (err) {
    reflectionFailed = true;
    await appendEvent({ stage: 'improve', phase: 'dream', inputs: [], outputs: [], verdict: 'failed',
      reason: `Dream generation unavailable or failed its evidence contract (${failureCode(err)}); recollections preserved.`,
      evidence_refs: [], rollback_ref: null, budget: { opus_sessions: 0, tokens: 0 } }, { date, overnightDir: dir });
  }
  review.generation_status = reflectionFailed ? 'failed' : 'completed';
  await writeLearningReview(dir, review);
  await appendEvent({ stage: 'improve', phase: 'proposal', inputs: events.map(e => e.id),
    outputs: [`proposals/learning-${date}.json`, `improvements:${review.improvements.length}`, `recollections:${review.dream.length}`, `hypotheses:${review.hypotheses.length}`],
    verdict: reflectionFailed ? 'failed' : 'ok', reason: 'Local review packet persisted. Hypotheses require verification. Executable proposals require separate candidate-specific acceptance and review.',
    evidence_refs: events.filter(e => e.verdict === 'failed' || e.verdict === 'rejected').map(e => e.id),
    rollback_ref: null, budget: { opus_sessions: 0, tokens: 0 },
  }, { date, overnightDir: dir });
}

/** Scheduler compatibility plus explicit on-demand invocation. */
export async function checkImprove(todayStr: string, hours: number, minutes: number,
  deps?: ImproveStageDeps, options?: { emergencyMode?: boolean }): Promise<void> {
  const emergency = options?.emergencyMode === true;
  if (!emergency) {
    if (new Date(todayStr + 'T12:00:00Z').getUTCDay() !== IMPROVE_TASK_DAY_OF_WEEK ||
      hours !== IMPROVE_TASK_HOUR || minutes !== IMPROVE_TASK_MINUTE || lastImproveDate === todayStr) return;
    lastImproveDate = todayStr;
  }
  if (!deps) return createImprovementReview(todayStr, join(ROOT, 'data', 'overnight'));
  // Explicitly injected isolated implementations retain the composable pipeline.
  // No privileged host CLI, cloud billing, push or merge client is installed by default.
  const runner = new OvernightRunner({ mode: emergency ? 'emergency' : 'deep', date: todayStr,
    overnightDir: deps.overnightDir, repoRoot: deps.repoRoot, skipJanitor: true });
  runner.register('improve', makeImproveStage(deps, { emergencyMode: emergency }));
  await runner.run(['improve']);
}
