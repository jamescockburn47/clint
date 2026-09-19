import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePaper, paperHtml, savePaper } from '../src/overnight/paper.js';
import { researchPaper, selfReview } from '../src/overnight/paper-research.js';
import { nextPaperJob, paperSummaries } from '../src/slack/nightly-papers.js';
import { ProactiveStore } from '../src/slack/proactive-store.js';
import { proactiveRead } from '../src/slack/proactive-tools.js';
import { backgroundResponse } from '../src/overnight/model-response.js';
import { inspectOwnCode } from '../src/overnight/code-inspection.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const answer = refs => ({ title: 'Synthetic technical analysis', summary: 'An opportunity worth considering.',
  sections: ['Evidence', 'Mechanism', 'Limits'].map(heading => ({ heading, body: 'Synthetic supported discussion.', references: refs })),
  areas: [{ area: 'Evidence reuse', references: refs, relevance: 'Could reduce repeated reads.', questions: ['Would the workload benefit?'] }],
  uncertainties: ['Local performance is unknown.'] });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nightly-paper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('paper identity/references are checked and HTML cannot execute source or generated text', async t => {
  const directory = fixture(t), signal = new AbortController().signal;
  const args = { date: '2026-09-20', kind: 'paper', question: 'Original wording unchanged.',
    sources: [{ id: 's1', text: 'private complete source', url: '<script>secret()</script>' }], signal };
  await assert.rejects(composePaper({ ...args, chat: async () => JSON.stringify(answer(['invented'])) }), /unknown_reference/);
  const paper = await composePaper({ ...args, chat: async (_, input) => {
    assert.equal(JSON.parse(input).question, args.question);
    return JSON.stringify({ ...answer(['s1']), title: '<script>run()</script>' });
  } });
  const html = paperHtml(paper);
  assert.doesNotMatch(html, /<script>|private complete source/);
  assert.match(html, /&lt;script&gt;run/);
  const receipt = await savePaper(paper, directory);
  assert.equal(readFileSync(join(directory, receipt.htmlFile), 'utf8'), html);
  assert.equal(receipt.htmlSha256, createHash('sha256').update(html).digest('hex'));
  assert.equal(receipt.htmlBytes, Buffer.byteLength(html));
  await assert.rejects(savePaper({ ...paper, kind: '../outside' }, directory), /invalid_identity/);
  assert.equal(JSON.parse(readFileSync(join(directory, receipt.jsonFile))).sources[0].text, 'private complete source');
});

test('opportunity briefs need open questions, retain evidence, and do not require a completed design', async () => {
  const signal = new AbortController().signal;
  const inventory = [{ path: 'feature.js', lines: 4, symbols: ['feature'], bytes: 80, sha256: 'b'.repeat(64) }];
  const args = { date: '2026-09-20', kind: 'self_review', question: 'Explore plausible opportunities.', signal,
    sources: [{ id: 's1', type: 'installed_code', text: 'complete selected code', sha256: 'a'.repeat(64) },
      { id: 'index', type: 'installed_code_inventory', files: inventory }] };
  const paper = await composePaper({ ...args, chat: async (_, input) => {
    const data = JSON.parse(input);
    assert.equal(data.sources[0].text, 'complete selected code');
    assert.equal(data.sources[0].sha256, 'a'.repeat(64));
    assert.deepEqual(data.sources[1].files, [{ path: 'feature.js', lines: 4, symbols: ['feature'] }]);
    return JSON.stringify(answer(['s1']));
  } });
  assert.deepEqual(paper.sources[1].files, inventory);
  assert.equal(paper.areas[0].questions[0], 'Would the workload benefit?');
  assert.match(paperHtml(paper), /Areas worth considering|Questions to explore/);
  assert.doesNotMatch(paperHtml(paper), /Proposed experiments|Success criterion/);
  await assert.rejects(composePaper({ ...args, chat: async () => JSON.stringify({
    ...answer(['s1']), proposals: [{ change: 'Final design', experiment: 'Required plan', successCriterion: 'Required threshold' }],
  }) }));
  await assert.rejects(composePaper({ ...args, chat: async () => JSON.stringify({
    ...answer(['s1']), areas: [{ area: 'Unexplained claim', relevance: 'Could help', references: ['s1'], questions: [] }],
  }) }));
});

test('dynamic public discovery precedes all private inputs and no private material reaches outbound calls', async t => {
  const directory = fixture(t), calls = [];
  let privateStarted = false, generated = 0;
  const result = await researchPaper({ date: '2026-09-20', directory, signal: new AbortController().signal,
    history: [{ title: 'PRIVATE_HISTORY_CANARY', report: { summary: 'PRIVATE_SUMMARY',
      publicResearch: { question: 'Previous public technical question', searches: ['public prior method'] } } }],
    publicTool: async (name, input) => {
      assert.equal(privateStarted, false); assert.doesNotMatch(JSON.stringify(input), /PRIVATE_/);
      calls.push({ name, input });
      return name === 'web_search' ? '1. New method\n   https://example.org/paper\n   Abstract' : JSON.stringify({
        state: 'ready', content: 'A freshly discovered synthetic technical method.', nextOffset: null, sourceHash: 'a'.repeat(64) });
    }, privateTool: async name => {
      assert.equal(name, 'knowledge_search'); privateStarted = true;
      return JSON.stringify({ state: 'snapshot', records: [{ id: 'old-1', text: 'PRIVATE_ARCHIVE_CANARY', role: 'user' }] });
    }, chat: async (_, input) => {
      if (++generated === 1) {
        assert.doesNotMatch(input, /PRIVATE_/);
        assert.match(input, /Previous public technical question/);
        return JSON.stringify({ question: 'Discovered question', reason: 'New method evidence',
          searches: ['new method evidence'], archiveQueries: ['relevant old approach'] });
      }
      assert.match(input, /PRIVATE_ARCHIVE_CANARY/); assert.match(input, /PRIVATE_HISTORY_CANARY/);
      return JSON.stringify(answer(['web-0', 'archive-1']));
    } });
  assert.equal(result.kind, 'paper');
  assert.equal(calls.filter(row => row.name === 'web_search').length, 1);
  assert.equal(calls.find(row => row.name === 'web_search').input.query, 'new method evidence');
});

test('self review inspects its code and researches public discoveries without exporting code or private focus', async t => {
  const calls = []; let generation = 0;
  const result = await selfReview({ date: '2026-09-20', directory: fixture(t), signal: new AbortController().signal,
    statements: [{ id: 'feedback', text: 'Please improve reliability.' }], outcomes: [{ state: 'failed' }],
    inspect: async () => ({ inventory: [{ path: 'feature.js', lines: 1 }], read: async paths => paths.map(path => ({
      id: 'code-0', path, text: 'PRIVATE_CODE_CANARY', coverage: 'complete_file' })) }),
    publicTool: async (name, input) => {
      assert.doesNotMatch(JSON.stringify(input), /PRIVATE_/);
      return name === 'web_search' ? '1. New mechanism\n   https://example.org/method\n   Details' : JSON.stringify({
        state: 'ready', content: 'Public new mechanism', nextOffset: null });
    },
    privateTool: async name => { calls.push(name); return '{"state":"unavailable"}'; },
    chat: async (_, input) => {
      if (++generation === 1) return JSON.stringify({ focus: 'PRIVATE_FOCUS_CANARY', paths: ['feature.js'], sourceIds: ['discovery-0'] });
      if (generation === 2) {
        assert.doesNotMatch(input, /PRIVATE_|feature.js/);
        return JSON.stringify({ question: 'Public mechanism', reason: 'Technical evidence', searches: ['Public mechanism'], archiveQueries: ['mechanism'] });
      }
      assert.match(input, /PRIVATE_CODE_CANARY/); assert.match(input, /PRIVATE_FOCUS_CANARY/);
      assert.match(input, /failed/); assert.match(input, /unavailable/);
      return JSON.stringify(answer(['code-0', 'web-0']));
    } });
  assert.equal(result.kind, 'self_review');
  assert.deepEqual(calls, ['system_status']);
});

test('installed source inspection preserves complete files, rejects unindexed paths and excludes state', async t => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'data'));
  writeFileSync(join(directory, 'feature.js'), 'export function feature() { return 17; }');
  writeFileSync(join(directory, 'data', 'secret.js'), 'PRIVATE_STATE');
  const snapshot = await inspectOwnCode(directory);
  assert.deepEqual(snapshot.inventory.map(row => row.path), ['feature.js']);
  assert.deepEqual(snapshot.inventory[0].symbols, ['feature']);
  assert.equal((await snapshot.read(['feature.js']))[0].text, 'export function feature() { return 17; }');
  await assert.rejects(snapshot.read(['../outside.js']), /not_in_snapshot/);
  writeFileSync(join(directory, 'feature.js'), 'changed');
  await assert.rejects(snapshot.read(['feature.js']), /changed_during_inspection/);
});

test('background streaming spans chunks, excludes reasoning and rejects unfinished answers', async () => {
  const frames = [{ choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING' } }] },
    { choices: [{ delta: { content: 'Complete answer' }, finish_reason: 'stop' }] }];
  const text = frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream({ start(controller) {
    for (const piece of [text.slice(0, 13), text.slice(13, 99), text.slice(99)]) controller.enqueue(new TextEncoder().encode(piece));
    controller.close();
  } });
  assert.equal(await backgroundResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), 'Complete answer');
  await assert.rejects(backgroundResponse(new Response(text.replace('data: [DONE]', ': interrupted'),
    { headers: { 'content-type': 'text/event-stream' } })), /incomplete/);
});

test('separate jobs run daily, survive restart and cannot leak through public research reports', t => {
  const directory = fixture(t), scope = JSON.stringify(['T1', 'C1', 'U1']);
  let store = new ProactiveStore(directory);
  assert.equal(nextPaperJob(store, '2026-09-20', 29, scope, 1), null);
  assert.equal(nextPaperJob(store, '2026-09-20', 60, scope, 1), 'self_review');
  store.update('2026-09-20:self_review', 'complete', 2, { report: { summary: 'PRIVATE_SELF_CANARY' } });
  assert.equal(nextPaperJob(store, '2026-09-20', 60, scope, 2), 'paper');
  store.update('2026-09-20:paper', 'complete', 3, { report: { summary: 'PRIVATE_PAPER_CANARY' } });
  store.close(); store = new ProactiveStore(directory);
  t.after(() => store.close());
  assert.equal(nextPaperJob(store, '2026-09-20', 60, scope, 4), null);
  assert.equal(nextPaperJob(store, '2026-09-21', 60, scope, 4), 'self_review');
  const publicScope = { transport: 'slack', actorId: 'U2', conversationId: 'slack:T1:C2',
    privateContext: true, localOnly: true, policy: { workspaceShared: true, researchScope: scope } };
  const read = proactiveRead('proactive_report', {}, { scope: publicScope, path: join(directory, 'proactive.sqlite') });
  assert.doesNotMatch(read, /PRIVATE_|self_review|"paper"/);
  assert.equal(JSON.parse(proactiveRead('proactive_report', { kind: 'self_review' },
    { scope: publicScope, path: join(directory, 'proactive.sqlite') })).state, 'not_authorized');
  const ownerScope = { ...publicScope, actorId: 'U1', isOwner: true, conversationId: 'slack:T1:C1', policy: {} };
  assert.match(proactiveRead('proactive_report', { date: '2026-09-20', kind: 'self_review' },
    { scope: ownerScope, path: join(directory, 'proactive.sqlite') }), /PRIVATE_SELF_CANARY/);
  assert.equal(paperSummaries(store, '2026-09-20', 'different')[0].state, 'not_recorded');
});
