/** Channel-independent nightly execution with durable completion and exclusive ownership. */
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { queryEvents, appendEvent } from './events.js';

export interface LearningWorkerOptions {
  date: string;
  overnightDir: string;
  consolidate: () => Promise<void>;
  review: () => Promise<void>;
  report: () => Promise<void>;
  adapt?: () => Promise<void>;
  explore?: () => Promise<void>;
}

/** Run once for a date. Interrupted locks require inspection, never automatic deletion. */
export async function runLearningWorker(opts: LearningWorkerOptions): Promise<'completed' | 'failed' | 'already_completed'> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('invalid run date');
  await mkdir(opts.overnightDir, { recursive: true });
  const marker = join(opts.overnightDir, `learning-run-${opts.date}.json`);
  const lock = join(opts.overnightDir, 'learning-worker.lock');
  const handle = await open(lock, 'wx');
  const save = (status: string) => writeFile(marker, JSON.stringify({ date: opts.date, status,
    timestamp: new Date().toISOString() }), 'utf8');
  try {
    try {
      const existing = JSON.parse(await readFile(marker, 'utf8'));
      if (existing.status === 'completed') return 'already_completed';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, date: opts.date }));
    await save('running');
    const before = new Set((await queryEvents({ date: opts.date, overnightDir: opts.overnightDir })).map(e => e.id));
    const run = async (stage: 'consolidate' | 'operations' | 'improve' | 'report', name: string, task?: () => Promise<void>) => {
      if (!task) return;
      try { await task(); }
      catch {
        await appendEvent({ stage, phase: name, inputs: [], outputs: [], verdict: 'failed',
          reason: `${name} failed; remaining independent stages continued.`, evidence_refs: [], rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 } }, { date: opts.date, overnightDir: opts.overnightDir });
      }
    };
    await run('consolidate', 'worker-consolidate', opts.consolidate);
    await run('operations', 'worker-explore', opts.explore);
    await run('improve', 'worker-adapt', opts.adapt);
    await run('improve', 'worker-review', opts.review);
    await run('report', 'worker-report', opts.report);
    const events = (await queryEvents({ date: opts.date, overnightDir: opts.overnightDir })).filter(e => !before.has(e.id));
    const allStagesRecorded = ['consolidate', 'improve', 'report'].every(stage => events.some(e => e.stage === stage));
    const status = !allStagesRecorded || events.some(e => e.verdict === 'failed' || e.verdict === 'rejected') ? 'failed' : 'completed';
    await save(status);
    return status;
  } catch (err) { await save('failed'); throw err; }
  finally { await handle.close(); await unlink(lock); }
}
