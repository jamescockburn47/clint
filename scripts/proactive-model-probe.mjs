/** Fresh synthetic end-to-end behaviour trial: local model, canned tools, no Slack or Google calls. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundChat } from '../src/slack/background-model.js';
import { researchAndReflect, morningBrief } from '../src/slack/proactive-research.js';

const signal = AbortSignal.timeout(600000);
const rawChat = backgroundChat({ modelUrl: 'http://127.0.0.1:11437', modelId: 'qwen3.8-flash-next' }, signal);
const calls = [], toolCalls = [];
const chat = async (...args) => {
  const start = performance.now();
  try {
    const output = await rawChat(...args);
    calls.push({ system: args[0], input: args[1], output, seconds: (performance.now() - start) / 1000 });
    return output;
  } catch (error) {
    calls.push({ system: args[0], input: args[1], output: null, errorType: error.name, seconds: (performance.now() - start) / 1000 });
    throw error;
  }
};
const directory = await mkdtemp(join(tmpdir(), 'clint-proactive-model-'));
const statements = [
  { id: 'synthetic-message-a', owner: 'synthetic-owner', timestamp: '2026-09-14T10:00:00Z',
    text: 'I want to understand whether lexical plus dense retrieval helps with paraphrased questions. This is a research question, not a decision to deploy it.' },
  { id: 'synthetic-message-b', owner: 'synthetic-owner', timestamp: '2026-09-14T10:10:00Z',
    text: 'Please also investigate how foreground conversation can interrupt background work. We have not measured whether extra inference slots help.' },
];
const fixtureTool = async (name, input) => {
  toolCalls.push({ name, input });
  if (name === 'web_search') return '1. Synthetic systems note\n   https://example.org/systems-note\n   This synthetic note describes experimental approaches, not measured results.';
  if (name === 'web_fetch') return JSON.stringify({ state: 'ready', url: input.url, finalUrl: input.url,
    content: 'SYNTHETIC FIXTURE. Combining lexical and semantic candidates is an experiment worth evaluating. ' +
      'Foreground work can cancel background requests. No speedup, accuracy gain or deployment is established by this note.',
    offset: 0, nextOffset: 8000, totalCharacters: 10000, observedAt: '2026-09-15T05:00:00Z',
    sourceHash: 'a'.repeat(64), limitations: ['Only the first page was read; later qualifications are unread.'] });
  if (name === 'calendar_read_events') return JSON.stringify({ source: 'live_google_api', observedAt: '2026-09-15T06:00:00Z',
    calendarId: 'primary', timeZone: 'Europe/London', nextPageToken: 'more-events', completeWindow: false,
    events: [
      { id: 'one', summary: 'Synthetic family day', status: 'confirmed', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } },
      { id: 'two', summary: 'Synthetic systems review', status: 'confirmed', start: { dateTime: '2026-09-15T14:30:00+01:00' }, end: { dateTime: '2026-09-15T15:00:00+01:00' } },
    ], endDatesExclusive: true });
  throw new Error('unexpected_probe_tool');
};
const args = { date: '2026-09-15', statements, chat, signal, directory, tool: fixtureTool,
  owner: 'synthetic-owner', conversationId: 'synthetic-probe' };
let research = null, briefing = null, errorType = null;
try {
  research = await researchAndReflect(args);
  briefing = await morningBrief({ ...args, research, now: Date.parse('2026-09-15T06:00:00Z') });
} catch (error) { errorType = error.name; }
const result = { research, briefing, errorType, calls, toolCalls,
  criteria: ['Research topics follow the supplied questions without treating them as decisions.',
    'No measured speedup or accuracy gain is invented.', 'Partial web-source coverage remains visible.',
    'Dreams remain hypotheses with the supplied source IDs.', 'Calendar date and 14:30 London time remain accurate.',
    'No complete-calendar or free-time claim when another page is unread.', 'Suggested actions remain proposals, with no claim that deployments or edits happened.'],
  boundary: 'Actual current local Flash inference; all source/tool content synthetic; no external search, Google or Slack posts.' };
await writeFile(process.argv[2], JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
await rm(directory, { recursive: true });
console.log(JSON.stringify({ state: errorType ? 'incomplete' : 'produced_for_review', modelCalls: calls.length,
  toolCalls: toolCalls.length, seconds: calls.reduce((sum, row) => sum + row.seconds, 0), errorType }));
