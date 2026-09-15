import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightCandidates, selectResearchHighlights, renderMorningBrief } from '../src/slack/research-highlights.js';

const reads = [{ url: 'https://example.org/source', finalUrl: 'https://example.org/source',
  contentRead: true, sourceHash: 'a'.repeat(64), observedAt: '2026-09-15T05:00:00Z', coverage: 'partial_extracted_text',
  extractedText: 'The experiment looked promising initially. However, the final comparison showed no gain and the proposal was withdrawn.\n\n' +
    'A separate paragraph explains why the missing observations leave the result unresolved.' }];

test('selection can only publish exact whole source paragraphs, including the trailing qualification', async () => {
  const candidates = highlightCandidates(reads);
  const highlights = await selectResearchHighlights(reads, [], async () => JSON.stringify({ paragraph_ids: ['s0p0'] }));
  assert.equal(highlights[0].text, candidates[0].text);
  assert.match(highlights[0].text, /proposal was withdrawn/);
  assert.equal(highlights[0].sourceHash, 'a'.repeat(64));
  assert.equal(highlights[0].coverage, 'partial_extracted_text');
  await assert.rejects(selectResearchHighlights(reads, [], async () => JSON.stringify({ paragraph_ids: ['invented'] })));
  await assert.rejects(selectResearchHighlights(reads, [], async () => JSON.stringify({ paragraph_ids: ['s0p0'], findings: 'Invented conclusion' })));
});

test('free model conclusions never enter deterministic calendar and research publication', () => {
  const research = { topicReasons: [{ query: 'Question being investigated' }],
    research: { topics: [{ findings: 'No quantitative metrics exist anywhere. Meeting participants agreed to deploy.' }] },
    highlights: highlightCandidates(reads).slice(0, 1), hypotheses: [{ summary: 'An unverified guess.' }] };
  const calendar = { nextPageToken: 'more', events: [
    { summary: 'Review', status: 'tentative', start: { dateTime: '2026-09-15T14:30:00+01:00' }, end: { dateTime: '2026-09-15T15:00:00+01:00' } },
    { summary: 'Cancelled visit', status: 'cancelled', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } },
  ] };
  const result = renderMorningBrief('2026-09-15', calendar, research);
  assert.match(result, /Review \(tentative\)/); assert.match(result, /14:30:00\+01:00/);
  assert.match(result, /More calendar results remain unread/); assert.match(result, /proposal was withdrawn/);
  assert.doesNotMatch(result, /No quantitative metrics|participants|Cancelled visit|An unverified guess/);
});

test('failed source reads and oversized paragraphs never produce fabricated highlights', async () => {
  assert.deepEqual(highlightCandidates([{ ...reads[0], contentRead: false }]), []);
  assert.deepEqual(highlightCandidates([{ ...reads[0], extractedText: 'X'.repeat(1201) }]), []);
  assert.deepEqual(await selectResearchHighlights([], [], () => assert.fail('no model call without source paragraphs')), []);
  assert.match(renderMorningBrief('2026-09-15', null, null), /calendar read is unavailable/);
});
