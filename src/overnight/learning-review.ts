/** Durable review packets from actual source statements and actual failed events. */
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MemoryCandidate } from './consolidate-validate.js';
import type { OvernightEvent } from './events.js';
import type { DreamHypothesis } from './dream-reflection.js';

export interface LearningReview {
  schema_version: 1;
  date: string;
  status: 'review_required';
  dream: Array<{ category: string; interpretation: 'extractive_recollection'; statements: MemoryCandidate[] }>;
  hypotheses: DreamHypothesis[];
  input_digest?: string;
  generation_status?: 'completed' | 'failed';
  improvements: Array<{ id: string; problem: string; evidence_refs: string[]; verification: 'observed_failure';
    implementation: 'not_started'; acceptance: string }>;
  code_execution: 'isolated_proposals_require_candidate_specific_acceptance_and_review';
}

/** Dream recollections require two distinct source messages; neither inference nor soul mutation. */
export function buildLearningReview(date: string, memories: MemoryCandidate[], events: OvernightEvent[]): LearningReview {
  const groups = new Map<string, MemoryCandidate[]>();
  for (const memory of memories) {
    if (memory.verification !== 'source_verified') continue;
    const entries = groups.get(memory.category) ?? [];
    if (!entries.some(e => e.sources[0]?.hash === memory.sources[0]?.hash)) entries.push(memory);
    groups.set(memory.category, entries);
  }
  const failures = new Map<string, OvernightEvent[]>();
  for (const event of events) {
    if (event.verdict !== 'failed' && event.verdict !== 'rejected') continue;
    const key = `${event.stage}/${event.phase}`;
    failures.set(key, [...(failures.get(key) ?? []), event]);
  }
  return {
    schema_version: 1, date, status: 'review_required', hypotheses: [],
    dream: [...groups].filter(([, entries]) => entries.length >= 2).map(([category, statements]) =>
      ({ category, interpretation: 'extractive_recollection', statements })),
    improvements: [...failures].map(([phase, entries]) => ({
      id: createHash('sha256').update(`${date}:${phase}`).digest('hex'),
      problem: `${phase}: ${entries.at(-1)!.reason}`,
      evidence_refs: entries.map(e => e.id), verification: 'observed_failure', implementation: 'not_started',
      acceptance: `Reproduce the recorded ${phase} failure, add a regression test, then demonstrate the corrected outcome on the actual implementation.`,
    })),
    code_execution: 'isolated_proposals_require_candidate_specific_acceptance_and_review',
  };
}

/** Persist locally; no external publication, messages or generated code execution. */
export async function writeLearningReview(dir: string, review: LearningReview): Promise<string> {
  const folder = join(dir, 'proposals');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `learning-${review.date}.json`);
  const attempt = join(folder, `learning-${review.date}-${randomUUID()}.json`);
  const text = JSON.stringify(review, null, 2);
  await writeFile(attempt, text, { encoding: 'utf8', flag: 'wx' });
  const pending = `${attempt}.pending`;
  await writeFile(pending, text, { encoding: 'utf8', flag: 'wx' });
  await rename(pending, file);
  return file;
}

/** Read this run's extracted statements, treating absence as empty and malformed data as failure. */
export async function readLearningCandidates(dir: string, date: string): Promise<MemoryCandidate[]> {
  try {
    const text = await readFile(join(dir, `shadow-candidates-${date}.jsonl`), 'utf8');
    return text.split('\n').filter(Boolean).map(line => {
      const value = JSON.parse(line);
      return (value.candidate ?? value) as MemoryCandidate;
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
