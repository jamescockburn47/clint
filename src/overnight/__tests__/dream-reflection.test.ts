import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectOnStatements } from '../dream-reflection.js';
import { groundCandidate, readSourceLine } from '../grounded-memory.js';
const memories = ['The release date is 20 October.', 'My notes give 23 October.'].map((text, i) => {
  const source = readSourceLine(JSON.stringify({ text, isBot: false }), 'fixture.jsonl', i + 1);
  return groundCandidate({ message_id: source.id, category: 'project' }, [source]);
});
test('dream preserves a conflicting-date hypothesis without turning it into a fact', async () => {
  const output = { kind: 'conflict', summary: 'The two statements give different dates.',
    evidence_refs: ['fixture.jsonl:1', 'fixture.jsonl:2'], verification_question: 'Which dated project record governs?' };
  const [result] = await reflectOnStatements(memories, async () => JSON.stringify({ hypotheses: [output] }));
  assert.equal(result?.status, 'unverified_hypothesis');
  assert.deepEqual(result?.evidence_refs, output.evidence_refs);
});
test('well-formed dream with fabricated evidence fails, as do unavailable and malformed responses', async () => {
  for (const raw of [null, '{}', JSON.stringify({ hypotheses: [{ kind: 'pattern', summary: 'Plausible claim',
    evidence_refs: ['fixture.jsonl:1', 'invented'], verification_question: 'Check?' }] })]) {
    await assert.rejects(reflectOnStatements(memories, async () => raw), /dream_/);
  }
  assert.deepEqual(await reflectOnStatements(memories, async () => '{"hypotheses":[]}'), []);
});
