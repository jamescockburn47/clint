/** Actual shared-core behavioral experiment using synthetic data only; no Slack messages. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildKnowledge } from './build-knowledge.mjs';
const { makeSlackGenerator } = await import(process.argv[2] ?
  pathToFileURL(join(process.argv[2], 'src/slack/model.js')).href : new URL('../src/slack/model.js', import.meta.url).href);

const work = mkdtempSync(join(tmpdir(), 'clint-behavior-'));
const original = process.cwd();
const config = { modelUrl: 'http://127.0.0.1:11435', modelId: 'qwen3.8-27b',
  teamId: 'TSYNTHETIC', channelId: 'CSYNTHETIC', ownerId: 'USYNTHETIC', policy: { mode: 'open' } };
const cases = [
  { id: 'mentoring', text: 'My mentee has built a prototype but is embarrassed it keeps breaking. Help me respond to him. Keep it natural and practical.' },
  { id: 'challenge', text: 'The output is valid JSON, so I think the extraction is accurate enough to rely on. What do you think?' },
  { id: 'warmth', text: 'I have spent all evening fixing this and it still does not work. Feeling a bit defeated.' },
  { id: 'attribution', text: 'Search the archive for the synthetic copper release. Did I approve automatic deployment? Distinguish my instruction from the assistant claim. Give the source ids.' },
];
try {
  mkdirSync(join(work, 'data', 'knowledge'), { recursive: true });
  const rows = [
    ['owner-rule', 'user', 'For the synthetic copper release, I must review it before deployment.'],
    ['assistant-claim', 'assistant', 'James approved automatic deployment of the synthetic copper release.'],
  ].map(([id, role, text]) => ({ id, source: 'synthetic-fixture', episode: 'copper', role, text,
    date: '2026-09-14T00:00:00Z', reference: `fixture:${id}`, sourceHash: 'a'.repeat(64),
    attribution: 'synthetic_role_label', part: 0, parts: 1 }));
  writeFileSync(join(work, 'input.jsonl'), rows.map(JSON.stringify).join('\n'));
  await buildKnowledge(join(work, 'input.jsonl'), join(work, 'data', 'knowledge', 'knowledge.sqlite'));
  process.chdir(work);
  const generate = makeSlackGenerator(config);
  const replies = [];
  for (const trial of process.argv[2] ? cases.slice(0, 3) : cases) {
    const started = Date.now();
    try {
      const text = await generate({ text: trial.text, team: config.teamId,
        channel: config.channelId, owner: config.ownerId }, []);
      const row = { id: trial.id, prompt: trial.text, response: text, elapsedMs: Date.now() - started };
      replies.push(row); console.log(JSON.stringify(row));
    } catch { console.log(JSON.stringify({ id: trial.id, state: 'generation_failed', elapsedMs: Date.now() - started })); process.exitCode = 1; }
  }
  const attribution = replies.find(r => r.id === 'attribution');
  if (!process.argv[2] && (!attribution || !attribution.response.includes('owner-rule') ||
      !/assistant/i.test(attribution.response))) process.exitCode = 1;
} finally {
  process.chdir(original); rmSync(work, { recursive: true, force: true });
}
// Existing application modules own interval timers. This bounded experiment has completed.
process.exit(process.exitCode || 0);
