import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLearningWorker } from '../learning-worker.js';
import { appendEvent } from '../events.js';
import { buildLearningReview } from '../learning-review.js';
import { runRollingReplay } from '../improve-replay.js';

test('nightly execution is independent, exclusive, durable and reports real failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clint-worker-'));
  try {
    const date = '2026-09-13';
    let runs = 0;
    const consolidate = async () => {
      runs++;
      await appendEvent({ stage: 'consolidate', phase: 'extract', inputs: [], outputs: [],
        verdict: 'ok', reason: 'fixture source verified', evidence_refs: [], rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 } }, { date, overnightDir: dir });
    };
    const record = async (stage: 'improve' | 'report') => {
      await appendEvent({ stage, phase: 'fixture', inputs: [], outputs: [], verdict: 'ok',
        reason: 'fixture', evidence_refs: [], rollback_ref: null, budget: { opus_sessions: 0, tokens: 0 } }, { date, overnightDir: dir });
    };
    const opts = { date, overnightDir: dir, consolidate, review: () => record('improve'), report: () => record('report') };
    assert.equal(await runLearningWorker(opts), 'completed');
    assert.equal(await runLearningWorker(opts), 'already_completed');
    assert.equal(runs, 1);
    assert.equal(JSON.parse(await readFile(join(dir, `learning-run-${date}.json`), 'utf8')).status, 'completed');
    assert.equal(await runLearningWorker({ ...opts, date: '2026-09-14', consolidate: async () => {} }), 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('overlapping workers cannot repeat the same source mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clint-worker-race-'));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const opts = { date: '2026-09-13', overnightDir: dir,
    consolidate: async () => { calls++; started(); await pause; }, review: async () => {}, report: async () => {} };
  try {
    const first = runLearningWorker(opts);
    await entered;
    await assert.rejects(runLearningWorker(opts), { code: 'EEXIST' });
    release();
    assert.equal(await first, 'failed');
    assert.equal(calls, 1);
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test('improvement task cites observed failures, not invented suggestions', () => {
  const review = buildLearningReview('2026-09-13', [], [{ id: 'real-event', timestamp: '', stage: 'consolidate',
    phase: 'extract', inputs: [], outputs: [], verdict: 'failed', reason: 'extractor_unavailable',
    evidence_refs: [], rollback_ref: null, budget: { opus_sessions: 0, tokens: 0 } }]);
  assert.deepEqual(review.improvements[0]?.evidence_refs, ['real-event']);
  assert.equal(review.improvements[0]?.implementation, 'not_started');
  assert.deepEqual(review.dream, []);
});

test('unavailable and empty replay cannot pass', async () => {
  const sample = { userInput: 'fixture', botResponse: 'baseline', original_timestamp: '', inputHash: 'fixture', category: 'conversational' as const };
  const opts = { samples: [sample], replayPair: { replayAgainstMain: async () => null, replayAgainstWorktree: async () => null },
    grader: { grade: async () => ({ judged: 'neutral' as const, reason: 'fixture' }) } };
  assert.equal((await runRollingReplay(opts)).verdict, 'blocked');
  assert.equal((await runRollingReplay({ ...opts, samples: [] })).verdict, 'blocked');
});

test('a small negation change still reaches the evaluator', async () => {
  let graded = 0;
  const result = await runRollingReplay({ samples: [{ userInput: 'Can I send?', botResponse: '', original_timestamp: '', inputHash: 'a', category: 'conversational' }],
    replayPair: { replayAgainstMain: async () => 'You are not authorised to send this document to the recipient.',
      replayAgainstWorktree: async () => 'You are authorised to send this document to the recipient.' },
    grader: { grade: async () => { graded++; return { judged: 'worse', reason: 'negation removed' }; } } });
  assert.equal(graded, 1); assert.equal(result.verdict, 'reject');
});
