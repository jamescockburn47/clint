import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConsolidateShadow,
  resetShadowTaskStateForTests,
  SHADOW_TASK_HOUR,
  SHADOW_TASK_MINUTE,
  type ShadowTaskDeps,
} from '../consolidate-shadow-task.js';
import type { ExtractClient } from '../consolidate-extract.js';
import type { MaintenanceClient, TopicIndexClient } from '../consolidate-maintenance.js';
import { queryEvents } from '../events.js';

describe('overnight/consolidate-shadow-task.checkConsolidateShadow', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-shadow-task-'));
    overnightDir = join(tmpRoot, 'overnight');
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
    resetShadowTaskStateForTests();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function makeDeps(overrides: Partial<ShadowTaskDeps> = {}): ShadowTaskDeps {
    const extractClient: ExtractClient = {
      extractCandidates: async conversation => ({ candidates: [{ message_id: JSON.parse(conversation)[0].id, category: 'project' }] }),
    };
    const memoryClient: MaintenanceClient = {
      triggerMaintenance: async () => ({ expired: 1, deduplicated: 0, total_after: 42 }),
    };
    const topicClient: TopicIndexClient = {
      indexDayTopics: async () => 3,
      pruneTopicIndex: async () => 1,
    };
    return {
      overnightDir,
      logDir,
      repoRoot: tmpRoot,
      extractClient,
      memoryClient,
      topicClient,
      ...overrides,
    };
  }

  it('does nothing when the current time is not exactly 02:30', async () => {
    await checkConsolidateShadow('2026-04-10', 1, 59, makeDeps());
    await checkConsolidateShadow('2026-04-10', 2, 29, makeDeps());
    await checkConsolidateShadow('2026-04-10', 2, 31, makeDeps());
    await checkConsolidateShadow('2026-04-10', 3, 30, makeDeps());

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    assert.equal(events.length, 0);
    assert.ok(!existsSync(join(overnightDir, 'shadow-candidates-2026-04-10.jsonl')));
  });

  it('runs the stage when hours === 2 and minutes === 30', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'A valid conversation that is long enough to be processed by the stage' },
      { sender: 'Clint', text: 'Responding with something long enough to pass the length check', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    // Events written
    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    const phases = events.map((e) => e.phase).sort();
    assert.deepEqual(phases, ['extract', 'maintenance', 'store']);

    // Shadow file written with both candidates (sources were synthesized)
    const shadowFile = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    assert.ok(existsSync(shadowFile));
    const lines = readFileSync(shadowFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(JSON.parse(lines[0]!).candidate.text, /valid conversation/);
    // Synthesized source is present and well-formed
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.sources.length, 1);
    assert.ok(parsed.candidate.sources[0].hash.startsWith('sha256:'));
  });

  it('runs only once per day even if called at 02:30 multiple times', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'Conversation content long enough to pass the minimum length check' },
      { sender: 'Clint', text: 'Another line with enough text to keep the conversation going', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    // 3 events per run, should only see one run
    assert.equal(events.length, 3);

    const shadowFile = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    const lines = readFileSync(shadowFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('does not throw when the memory client is offline', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'A valid conversation that is long enough to be processed by the stage' },
      { sender: 'Clint', text: 'Responding with something long enough to pass the length check', isBot: true },
    ]);

    const failingExtract: ExtractClient = {
      extractCandidates: async () => { throw new Error('EVO X2 offline'); },
    };
    const failingMaintenance: MaintenanceClient = {
      triggerMaintenance: async () => { throw new Error('EVO X2 offline'); },
    };

    await assert.doesNotReject(
      checkConsolidateShadow(
        '2026-04-10',
        SHADOW_TASK_HOUR,
        SHADOW_TASK_MINUTE,
        makeDeps({ extractClient: failingExtract, memoryClient: failingMaintenance }),
      ),
    );

    // Events should still be recorded, extract should be 'failed' because errors>0 and files=0
    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    assert.equal(events.length, 3);
    const extract = events.find((e) => e.phase === 'extract');
    assert.ok(extract);
    assert.equal(extract!.verdict, 'failed');
  });

  it('records explicit empty output as skipped and excludes raw input from diagnostics', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'A real conversation that should produce candidates but extractor returns none' },
      { sender: 'Clint', text: 'Responding with something long enough to pass the length check', isBot: true },
    ]);

    const silentExtract: ExtractClient = {
      extractCandidates: async () => ({ candidates: [] }),
    };

    await checkConsolidateShadow(
      '2026-04-10',
      SHADOW_TASK_HOUR,
      SHADOW_TASK_MINUTE,
      makeDeps({ extractClient: silentExtract }),
    );

    // Silent-zero must surface as 'failed' so the health-check can see it.
    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    // Debug aid: print events if extract missing so we can see what actually ran.
    const extract = events.find((e) => e.phase === 'extract');
    assert.ok(extract, `expected extract event, got phases: ${events.map((e) => e.phase).join(',')} count=${events.length}`);
    assert.equal(extract!.verdict, 'skipped');
    assert.match(extract!.reason, /candidates=0/);

    // Debug file captures the failing input for later diagnosis.
    const debugFile = join(overnightDir, 'extract-debug-2026-04-10.jsonl');
    assert.ok(existsSync(debugFile), 'extract-debug file should exist');
    const lines = readFileSync(debugFile, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    const entry = JSON.parse(lines[0]!);
    assert.ok(typeof entry.timestamp === 'string');
    assert.ok(entry.conversation_length > 0);
    assert.equal(entry.sample, undefined);
  });

  it('runs again the next day after lastShadowDate rolls over', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'Day one conversation with enough content to pass the length check for real' },
      { sender: 'Clint', text: 'Day one response with enough content to keep it going', isBot: true },
    ]);
    writeLog('2026-04-10-1.jsonl', [
      { sender: 'James', isBot: false, text: 'Day two conversation with enough content to pass the length check for real' },
      { sender: 'Clint', text: 'Day two response with enough content to keep it going', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-11', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2026-04-10.jsonl')));
    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2026-04-11.jsonl')));
  });
});
