/** Single frozen synthetic screen. Fake Slack delivery; real intake, stores and core probe answers. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { TeachingStore } from '../src/slack/teaching-store.js';
import { SlackTeaching } from '../src/slack/teaching.js';
import { SlackStore } from '../src/slack/store.js';
import { SlackWorker } from '../src/slack/worker.js';
import { makeSlackGenerator, SLACK_PROMPT_VERSION } from '../src/slack/model.js';
import core from '../src/config.js';
import { validateSlackCoreConfig } from '../src/slack/core-config.js';

const [fixturePath, outputPath] = process.argv.slice(2);
if (!fixturePath || !outputPath) throw new Error('fixture_and_output_required');
const fixtureBytes = readFileSync(fixturePath), fixture = JSON.parse(fixtureBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(fixtureBytes) !== '264efd746717964d9f7528095e3970ce72eb5d3f870df5a0dbfa57c24eb35eee') throw new Error('frozen_fixture_changed');
const directory = resolve(outputPath + '.stores');
if (existsSync(outputPath) || existsSync(directory)) throw new Error('trial_already_started_no_rerun');
mkdirSync(directory, { mode: 0o700 });
const cfg = { teamId: fixture.defaultFixture.teamId, channelId: fixture.defaultFixture.channelId,
  ownerId: fixture.defaultFixture.ownerId, botUserId: fixture.defaultFixture.botId,
  modelUrl: core.evoLlmUrl, modelId: core.evoChatModel, policy: { mode: 'open' } };
validateSlackCoreConfig(core, cfg);
if (core.evoMemoryEnabled || existsSync(resolve('data/knowledge/knowledge.sqlite')) ||
    [core.googleClientId, core.googleClientSecret, core.googleRefreshToken, core.tavilyApiKey,
      core.anthropicApiKey, core.minimaxApiKey, core.braveApiKey, core.perplexityApiKey].some(Boolean)) {
  throw new Error('trial_requires_isolated_archive_and_connectors');
}
const report = { trialId: fixture.trialId, startedAt: new Date().toISOString(), fixtureSha256: hash(fixtureBytes),
  model: cfg.modelId, promptVersion: SLACK_PROMPT_VERSION, slackMessagesSent: false, privateArchiveUsed: false,
  scope: 'One bounded transfer screen; not general deep learning or model weight training.',
  retirementLimitation: 'Retirement excludes all earlier ordinary context, including unrelated feedback; explicit unrelated teachings remain.',
  cases: [] };
const persist = () => writeFileSync(outputPath, JSON.stringify(report, null, 2));
persist();
let sequence = 0;
const stamp = () => String(1789420000 + sequence).padStart(10, '0') + '.000001';
for (const item of fixture.cases) {
  const caseDir = join(directory, item.id);
  let db = new TeachingStore(caseDir, { now: () => (1789420000 + sequence) * 1000 });
  let inbox = new SlackStore(caseDir), teaching = new SlackTeaching({ store: db, config: cfg });
  let generate = makeSlackGenerator(cfg);
  const result = { id: item.id, name: item.name, events: [], probes: [] };
  report.cases.push(result); persist();
  const ns = `${cfg.teamId}:${cfg.channelId}:${cfg.ownerId}`;
  const thread = '1789419999.000001';
  async function intake(text, { answerFixture = null, probe = null, sameThread = true } = {}) {
    sequence++;
    const event = { id: `EvSYNTHETIC${sequence}`, team: cfg.teamId, channel: cfg.channelId, owner: cfg.ownerId,
      ts: stamp(), thread: sameThread ? thread : String(1789420000 + sequence) + '.000000', text };
    const entry = { event, assistantFixture: answerFixture, generated: [], delivered: [], workerEvents: [] };
    result.events.push(entry);
    const web = { conversations: {
      info: async () => ({ ok: true, channel: { id: cfg.channelId, is_private: true, is_member: true,
        is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }),
      members: async () => ({ ok: true, members: fixture.defaultFixture.members }),
    }, chat: { postMessage: async payload => {
      entry.delivered.push({ payload, text: payload.blocks.map(block => block.text?.text || '').join('\n') });
      return { ok: true, channel: cfg.channelId, ts: event.ts };
    } } };
    inbox.enqueue(event, Date.now());
    await new SlackWorker({ store: inbox, teaching, config: cfg, web,
      report: (...values) => entry.workerEvents.push(values),
      generate: async (current, history, context) => {
        const attempt = { history, teachingContext: context, sourceIds: context.activeTeachings.map(row => row.id),
          episodeSourceIds: context.ownerEpisodes.map(row => row.source.event), actualCore: answerFixture === null };
        entry.generated.push(attempt); persist();
        attempt.answer = answerFixture ?? await generate(current, history, context);
        return attempt.answer;
      },
    }).drain();
    entry.finalState = inbox.db.prepare('SELECT state,error FROM events WHERE id=?').get(event.id);
    if (probe) result.probes.push({ id: probe, eventId: event.id });
    persist();
    if (entry.finalState.state !== 'sent') throw new Error(`trial_intake_failed_${item.id}_${sequence}`);
    return event;
  }
  const restart = () => {
    inbox.close(); db.close();
    db = new TeachingStore(caseDir, { now: () => (1789420000 + sequence) * 1000 });
    inbox = new SlackStore(caseDir); inbox.recover();
    teaching = new SlackTeaching({ store: db, config: cfg }); generate = makeSlackGenerator(cfg);
    result.restarted = true;
  };
  try {
    for (const text of item.setupMessages || []) await intake(text);
    if (item.setupExchange) {
      await intake(item.setupExchange[0].content, { answerFixture: item.setupExchange[1].content });
      await intake(item.setupExchange[2].content, { answerFixture: 'Feedback received for this synthetic fixture.' });
    }
    if (item.preRetirementExchange) await intake(item.preRetirementExchange[0].content,
      { answerFixture: item.preRetirementExchange[1].content });
    const rows = db.db.prepare('SELECT * FROM teachings WHERE namespace=? ORDER BY source_ts').all(ns);
    for (const text of item.retirementMessages || []) await intake(text.replace('{{first_teaching_id}}', rows[0].id));
    restart();
    for (const probe of item.probes || [{ id: item.id, message: item.probe }]) {
      if (item.id === 'T3' && probe.id !== 'T3a') restart();
      await intake(probe.message, { probe: probe.id, sameThread: item.id === 'T6' });
    }
    result.storedTeachings = db.db.prepare('SELECT * FROM teachings WHERE namespace=? ORDER BY source_ts').all(ns);
    result.storedEpisodes = db.db.prepare('SELECT * FROM owner_episodes WHERE namespace=? ORDER BY source_ts').all(ns);
    result.retirementActions = db.db.prepare("SELECT * FROM teaching_actions WHERE namespace=? AND action='retire'").all(ns);
  } catch (error) { result.executionError = error.message; report.executionFailed = true; }
  finally { inbox.close(); db.close(); persist(); }
  if (report.executionFailed) break;
}
report.finishedAt = new Date().toISOString(); persist();
console.log(JSON.stringify({ trialId: report.trialId, cases: report.cases.length, executionFailed: !!report.executionFailed }));
if (report.executionFailed) process.exitCode = 1;
