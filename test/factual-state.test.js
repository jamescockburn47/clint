import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindCandidate, decideState, decideBundle, prepareCandidates, renderState, validateBundle } from '../src/knowledge/factual-state.js';

const source = { id: 'S1', speaker: 'james', origin: 'message',
  text: 'I installed package B yesterday.', statedDate: null };
const bundle = () => validateBundle({ question: { requester: 'james', text: 'Did I install B?', target: 'completed_action' }, sources: [source] });
const candidate = { kind: 'completed_action', sourceId: 'S1', quote: source.text };
const yes = { answerability: 'direct_answer', attribution: 'matches_question', polarity: 'affirmative' };
const noAnswer = { answerability: 'not_answered', attribution: 'unresolved', polarity: 'unresolved' };

test('positive source survives with exact quote, source offsets and no invented date', () => {
  const state = decideState(bundle(), candidate, yes);
  assert.equal(state.state, 'supported_attribution');
  assert.equal(state.provenance.statedDate, null);
  assert.equal(source.text.slice(state.provenance.start, state.provenance.end), state.quote);
  assert.equal(Object.hasOwn(state, 'value'), false);
  assert.equal(renderState(state), 'James reported: “I installed package B yesterday.” [S1].');
});
test('a schema-valid wrong quote cannot pass even with a positive model assessment', () => {
  assert.equal(decideState(bundle(), { ...candidate, quote: 'I installed package C yesterday.' }, yes).reason, 'source_mismatch');
});
test('a fragment inside denial or another speaker quotation is rejected deterministically', () => {
  for (const text of ['I did not say "I contacted the client".', 'Daniel told me "I contacted the client".']) {
    const input = { ...bundle(), sources: [{ ...source, text }] };
    assert.equal(decideState(input, { ...candidate, quote: 'I contacted the client' }, yes).reason, 'source_mismatch');
  }
});
test('whole-record candidates preserve repeated passages and all their surrounding context', () => {
  const text = 'I installed B. Daniel quoted "I installed B". I corrected my first statement.';
  const input = { ...bundle(), sources: [{ ...source, text }] };
  assert.equal(prepareCandidates(input)[0].quote, text);
});
test('incomplete or ambiguous bundle assessments cannot silently select a winner', () => {
  const input = { ...bundle(), sources: [source, { ...source, id: 'S2' }] };
  const entries = prepareCandidates(input).map(c => ({ candidate: c, assessment: yes }));
  assert.equal(decideBundle(input, entries.slice(0, 1)).reason, 'incomplete_assessment');
  assert.equal(decideBundle(input, entries).reason, 'ambiguous_support');
  entries[1].assessment = noAnswer;
  assert.equal(decideBundle(input, entries).state, 'supported_attribution');
  entries[1].assessment = null;
  assert.equal(decideBundle(input, entries).reason, 'invalid_assessment');
});
test('unknown and other speakers, assistant prose and documents cannot become James', () => {
  for (const change of [{ speaker: 'unknown' }, { speaker: 'other' }, { origin: 'assistant' }, { origin: 'document' }]) {
    const input = { ...bundle(), sources: [{ ...source, ...change }] };
    assert.equal(decideState(input, candidate, yes).reason, 'untrusted_attribution');
  }
});
test('source instructions cannot answer completed action with their state intact', () => {
  assert.equal(decideState(bundle(), { ...candidate, kind: 'instruction' }, yes).reason, 'wrong_state');
});
test('all judgments are required and old verdict schema is rejected', () => {
  for (const assessment of [null, {}, { ...yes, answerability: 'conflicting' },
    { ...yes, attribution: 'different_subject' }, { ...yes, attribution: 'unresolved' },
    { ...yes, polarity: 'unresolved' }, { verdict: 'supported', reason: 'direct_evidence' }]) {
    const state = decideState(bundle(), candidate, assessment);
    assert.equal(state.quote, null);
    assert.match(renderState(state), /unknown/);
  }
});
test('unknown is never rendered as zero or false', () => {
  const result = decideState(bundle(), { kind: 'unknown', sourceId: null, quote: null }, yes);
  assert.equal(result.quote, null);
  assert.equal(result.provenance, null);
});
test('duplicate IDs are rejected before binding', () => {
  assert.throws(() => validateBundle({ ...bundle(), sources: [source, source] }), /duplicate_source_id/);
});
test('fabricated fields are rejected, not silently stripped', () => {
  assert.equal(bindCandidate(bundle(), { ...candidate, verified: true }).reason, 'invalid_candidate');
});
test('a false semantic classification is not claimed to be deterministically detectable', () => {
  const input = { ...bundle(), sources: [{ ...source, text: 'Install package B.' }] };
  const wrong = { ...candidate, quote: 'Install package B.' };
  // Explicit gap: an erroneous positive checker can admit a wrong kind. Live adversarial
  // evaluation must reject this counterexample before any promotion claim.
  assert.equal(decideState(input, wrong, yes).state, 'supported_attribution');
  assert.equal(decideState(input, wrong, noAnswer).state, 'unknown');
});
test('negative direct answers are admitted, missing answers are not turned into negatives', () => {
  const text = 'I did not install B.';
  const input = { ...bundle(), sources: [{ ...source, text }] };
  const selected = { ...candidate, quote: text };
  const state = decideState(input, selected, { ...yes, polarity: 'negative' });
  assert.equal(state.state, 'supported_attribution');
  assert.equal(state.answerPolarity, 'negative');
  assert.equal(state.quote, text);
  assert.equal(decideState(input, selected, { ...noAnswer, polarity: 'negative' }).state, 'unknown');
});
test('explicit nonselection is quotable without inventing a selected option', () => {
  const input = { question: { requester: 'james', text: 'Which queue did I choose?', target: 'decision' },
    sources: [{ ...source, text: 'I withdrew Elm and have not chosen a replacement.' }] };
  const state = decideState(input, prepareCandidates(input)[0], { ...yes, polarity: 'negative' });
  assert.equal(state.state, 'supported_attribution');
  assert.equal(Object.hasOwn(state, 'selectedQueue'), false);
});
test('verifier inability is not rendered as proven absence of source evidence', () => {
  const state = decideState(bundle(), candidate, noAnswer);
  assert.equal(state.quote, null);
  assert.match(renderState(state), /could not verify/);
  assert.doesNotMatch(renderState(state), /evidence does not establish|no evidence|zero/);
});
test('same source cannot acquire a missing, unknown or different question requester', () => {
  for (const requester of [undefined, 'unknown', 'other']) {
    const input = { ...bundle(), question: { ...bundle().question, requester } };
    assert.throws(() => validateBundle(input));
    assert.deepEqual(prepareCandidates(input), []);
    assert.equal(decideState(input, candidate, yes).reason, 'unsupported_requester');
  }
  assert.equal(decideState(bundle(), candidate, yes).state, 'supported_attribution');
});
