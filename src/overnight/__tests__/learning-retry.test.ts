import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLearningReview, writeLearningReview } from '../learning-review.js';

test('successful retry replaces the current packet while retaining the failed attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clint-retry-'));
  try {
    const failed = { ...buildLearningReview('2026-09-13', [], []), generation_status: 'failed' as const, input_digest: 'old-input' };
    await writeLearningReview(root, failed);
    const recovered = { ...failed, generation_status: 'completed' as const, input_digest: 'recovered-input',
      hypotheses: [{ kind: 'conflict' as const, summary: 'Recovered date conflict', evidence_refs: ['a', 'b'],
        verification_question: 'Which source governs?', status: 'unverified_hypothesis' as const, version: 'clint-dream-v1' as const }] };
    await writeLearningReview(root, recovered);
    const current = JSON.parse(await readFile(join(root, 'proposals', 'learning-2026-09-13.json'), 'utf8'));
    assert.equal(current.generation_status, 'completed');
    assert.equal(current.hypotheses[0].summary, 'Recovered date conflict');
    const archived = (await readdir(join(root, 'proposals'))).filter(name => name !== 'learning-2026-09-13.json');
    assert.equal(archived.length, 2);
    const attempts = await Promise.all(archived.map(name => readFile(join(root, 'proposals', name), 'utf8')));
    assert.ok(attempts.some(text => JSON.parse(text).generation_status === 'failed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
