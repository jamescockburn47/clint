import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';
import { makeConsolidateStage } from '../consolidate.js';
import type { ExtractClient } from '../consolidate-extract.js';
import type { StoreClient } from '../consolidate-store.js';
import type { MaintenanceClient, TopicIndexClient } from '../consolidate-maintenance.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate.runConsolidateStage', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-consolidate-'));
    overnightDir = join(tmpRoot, 'overnight');
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function validCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: undefined as unknown as MemoryCandidate['sources'],
    };
  }

  function unsourcedCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: [] as MemoryCandidate['sources'],
    };
  }

  function makeExtractClient(candidates: MemoryCandidate[]): ExtractClient {
    return {
      extractCandidates: async () => ({ candidates }),
    };
  }

  function makeStoreClient(): StoreClient & { stored: MemoryCandidate[] } {
    const stored: MemoryCandidate[] = [];
    return {
      stored,
      storeValidated: async (c) => { stored.push(c); },
    };
  }

  function makeMaintenance(): MaintenanceClient {
    return { triggerMaintenance: async () => ({ expired: 1, deduplicated: 0, total_after: 99 }) };
  }

  function makeTopicIndex(): TopicIndexClient {
    return {
      indexDayTopics: async () => 3,
      pruneTopicIndex: async () => 1,
    };
  }

  it('runs extract → store → maintenance and writes three consolidate events', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'The Atlas case goes to hearing on Thursday this week' },
      { sender: 'Clint', text: 'Noted — I will prep the briefing for Thursday.', isBot: true },
    ]);

    const storeClient = makeStoreClient();
    const stage = makeConsolidateStage({
      logDir,
      extractClient: makeExtractClient([validCandidate('The Atlas case goes to hearing on Thursday this week'), unsourcedCandidate('no evidence here')]),
      storeClient,
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        // '2026-04-10' → '2026-04-09'
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    const phases = events.map((e) => e.phase).sort();
    assert.deepEqual(phases, ['extract', 'maintenance', 'store']);
    assert.equal(storeClient.stored.length, 1);

    const storeEvent = events.find((e) => e.phase === 'store');
    assert.ok(storeEvent);
    assert.match(storeEvent!.reason, /stored=1.*rejected=0/);
  });

  it('records a failed extract event when the log dir does not exist', async () => {
    const stage = makeConsolidateStage({
      logDir: join(tmpRoot, 'does-not-exist'),
      extractClient: makeExtractClient([]),
      storeClient: makeStoreClient(),
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    // Extract should report 0 files processed (not a failure — an empty day).
    const extractEvent = events.find((e) => e.phase === 'extract');
    assert.ok(extractEvent);
    assert.equal(extractEvent!.verdict, 'failed');
    assert.match(extractEvent!.reason, /files=0/);
  });

  it('rejects unsourced candidates before they reach storage', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', isBot: false, text: 'A valid conversation with enough content to be processed' },
      { sender: 'Clint', text: 'Responding to the valid conversation so it passes the length check', isBot: true },
    ]);

    const stage = makeConsolidateStage({
      logDir,
      extractClient: makeExtractClient([unsourcedCandidate('bad one'), unsourcedCandidate('bad two')]),
      storeClient: makeStoreClient(),
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    assert.equal(events.find(e => e.phase === 'extract')?.verdict, 'failed');
    assert.match(events.find(e => e.phase === 'extract')!.reason, /rejected=2/);
  });
});
