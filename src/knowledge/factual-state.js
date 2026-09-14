import { z } from 'zod';

// Experimental, disconnected from ingestion, prompts and transports.
export const Source = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  speaker: z.enum(['james', 'other', 'unknown']),
  origin: z.enum(['message', 'assistant', 'observation', 'document']),
  text: z.string().min(1).max(12000),
  statedDate: z.string().max(100).nullable(),
}).strict();
export const Question = z.object({
  // Trusted caller assertion for this owner-only prototype; never infer/default it.
  requester: z.literal('james'),
  text: z.string().min(1).max(1000),
  target: z.enum(['completed_action', 'observation', 'decision']),
}).strict();
export const Candidate = z.object({
  kind: z.enum(['completed_action', 'observation', 'decision', 'instruction', 'unknown']),
  sourceId: z.string().max(80).nullable(),
  quote: z.string().max(12000).nullable(),
}).strict();
export const Assessment = z.object({
  answerability: z.enum(['direct_answer', 'not_answered', 'conflicting']),
  attribution: z.enum(['matches_question', 'different_subject', 'unresolved']),
  polarity: z.enum(['affirmative', 'negative', 'value', 'unresolved']),
}).strict();
export const assessmentSchema = z.toJSONSchema(Assessment);
const eligible = source => (source.origin === 'message' && source.speaker === 'james')
  || (source.origin === 'observation' && source.speaker === 'unknown');

export function validateBundle(input) {
  const bundle = z.object({ question: Question, sources: z.array(Source).min(1).max(20) }).strict().parse(input);
  if (new Set(bundle.sources.map(s => s.id)).size !== bundle.sources.length) throw new Error('duplicate_source_id');
  return bundle;
}

export function bindCandidate(bundle, input) {
  if (bundle.question.requester !== 'james') return { accepted: false, reason: 'unsupported_requester' };
  const parsed = Candidate.safeParse(input);
  if (!parsed.success) return { accepted: false, reason: 'invalid_candidate' };
  const candidate = parsed.data;
  if (candidate.kind === 'unknown') return { accepted: false, reason: 'missing_evidence' };
  const source = bundle.sources.find(s => s.id === candidate.sourceId);
  if (!source || !candidate.quote || source.text !== candidate.quote) {
    return { accepted: false, reason: 'source_mismatch' };
  }
  // Archives and model prose cannot manufacture an owner identity or an observation adapter.
  if (!eligible(source)) return { accepted: false, reason: 'untrusted_attribution' };
  if (candidate.kind !== bundle.question.target) return { accepted: false, reason: 'wrong_state' };
  return { accepted: true, candidate, source };
}

export function decideState(bundle, candidate, assessment) {
  const bound = bindCandidate(bundle, candidate);
  const unknown = reason => ({ state: 'unknown', quote: null, provenance: null, reason });
  if (!bound.accepted) return unknown(bound.reason);
  const checked = Assessment.safeParse(assessment);
  if (!checked.success) return unknown('invalid_assessment');
  if (checked.data.answerability !== 'direct_answer' || checked.data.attribution !== 'matches_question'
    || checked.data.polarity === 'unresolved') {
    return unknown('not_verified');
  }
  // This certifies neither external truth nor population reliability. The model's
  // entailment judgment is retained explicitly and must pass output-level evals.
  return { state: 'supported_attribution', quote: bound.candidate.quote,
    answerPolarity: checked.data.polarity,
    provenance: { sourceId: bound.source.id, speaker: bound.source.speaker,
      origin: bound.source.origin, statedDate: bound.source.statedDate,
      start: 0, end: bound.source.text.length },
    reason: 'model_checked_source_support' };
}

export function prepareCandidates(bundle) {
  if (bundle.question.requester !== 'james') return [];
  return bundle.sources.filter(eligible).map(source => ({
    kind: bundle.question.target, sourceId: source.id, quote: source.text,
  }));
}

export function decideBundle(bundle, assessed) {
  const expected = prepareCandidates(bundle);
  const unknown = reason => ({ state: 'unknown', quote: null, provenance: null, reason });
  if (assessed.length !== expected.length) return unknown('incomplete_assessment');
  const states = [];
  for (const [index, candidate] of expected.entries()) {
    const entry = assessed[index];
    if (!entry || JSON.stringify(entry.candidate) !== JSON.stringify(candidate)
      || !Assessment.safeParse(entry.assessment).success) return unknown('invalid_assessment');
    states.push(decideState(bundle, candidate, entry.assessment));
  }
  const accepted = states.filter(state => state.state === 'supported_attribution');
  if (accepted.length !== 1) return unknown(accepted.length ? 'ambiguous_support' : 'missing_evidence');
  return accepted[0];
}

export function renderState(state) {
  if (state.state !== 'supported_attribution') {
    return 'I could not verify an answer from these sources. This check leaves the result unknown.';
  }
  const attribution = state.provenance.origin === 'message' ? 'James reported' : 'The observation records';
  const date = state.provenance.statedDate === null ? '' : ` Source date: ${state.provenance.statedDate}.`;
  return `${attribution}: “${state.quote}” [${state.provenance.sourceId}].${date}`;
}
