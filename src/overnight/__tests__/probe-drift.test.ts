import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sampleHistoricalExchanges,
  hashInput,
  runDriftChecks,
  type ReplayClient,
  type GraderClient,
  type HistoricalExchange,
} from '../probe-drift.js';

describe('overnight/probe-drift.hashInput', () => {
  it('produces a stable sha256 hash for the same input', () => {
    const a = hashInput('hello');
    const b = hashInput('hello');
    assert.equal(a, b);
    assert.match(a, /^sha256:[0-9a-f]{12}$/);
  });

  it('produces different hashes for different inputs', () => {
    assert.notEqual(hashInput('hello'), hashInput('world'));
  });
});

describe('overnight/probe-drift.sampleHistoricalExchanges', () => {
  let tmpRoot: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-drift-'));
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('returns empty array when log dir is missing or empty', async () => {
    const result = await sampleHistoricalExchanges({
      logDir: join(tmpRoot, 'nope'),
      referenceDate: '2026-04-11',
      windowDays: 3,
      sampleSize: 5,
    });
    assert.deepEqual(result, []);
  });

  it('picks exchanges (user input followed by bot response) from within the window', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'what is on tomorrow?', timestamp: '2026-04-09T14:30:00Z' },
      { sender: 'Clint', text: 'A meeting at 10am and lunch at 12pm.', isBot: true, timestamp: '2026-04-09T14:30:05Z' },
      { sender: 'James', text: 'thanks', timestamp: '2026-04-09T14:31:00Z' },
      { sender: 'Clint', text: 'Any time.', isBot: true, timestamp: '2026-04-09T14:31:02Z' },
    ]);

    const result = await sampleHistoricalExchanges({
      logDir,
      referenceDate: '2026-04-11',
      windowDays: 3,
      sampleSize: 5,
    });

    assert.ok(result.length >= 1);
    assert.ok(result[0]!.userInput.length > 0);
    assert.ok(result[0]!.botResponse.length > 0);
    assert.ok(result[0]!.inputHash.startsWith('sha256:'));
  });

  it('excludes logs outside the window', async () => {
    // Date outside 3-day window from 2026-04-11 (would be anything before 2026-04-08)
    writeLog('2026-04-01-1.jsonl', [
      { sender: 'James', text: 'old message', timestamp: '2026-04-01T10:00:00Z' },
      { sender: 'Clint', text: 'old reply', isBot: true, timestamp: '2026-04-01T10:00:02Z' },
    ]);

    const result = await sampleHistoricalExchanges({
      logDir,
      referenceDate: '2026-04-11',
      windowDays: 3,
      sampleSize: 5,
    });
    assert.equal(result.length, 0);
  });

  it('caps the returned sample at sampleSize', async () => {
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i++) {
      lines.push({ sender: 'James', text: `question ${i} about something`, timestamp: `2026-04-09T${String(i % 24).padStart(2, '0')}:00:00Z` });
      lines.push({ sender: 'Clint', text: `answer ${i}`, isBot: true, timestamp: `2026-04-09T${String(i % 24).padStart(2, '0')}:00:02Z` });
    }
    writeLog('2026-04-09-1.jsonl', lines);

    const result = await sampleHistoricalExchanges({
      logDir,
      referenceDate: '2026-04-11',
      windowDays: 3,
      sampleSize: 5,
    });
    assert.equal(result.length, 5);
  });
});

describe('overnight/probe-drift.runDriftChecks', () => {
  function makeReplay(response: string | null): ReplayClient {
    return {
      replayInput: async () => response,
    };
  }

  function makeGrader(judgement: 'better' | 'worse' | 'neutral', reason = 'test'): GraderClient {
    return {
      grade: async () => ({ judged: judgement, reason }),
    };
  }

  function makeExchanges(n: number): HistoricalExchange[] {
    const ex: HistoricalExchange[] = [];
    for (let i = 0; i < n; i++) {
      ex.push({
        userInput: `input ${i}`,
        botResponse: `original response ${i}`,
        original_timestamp: `2026-04-09T${String(i).padStart(2, '0')}:00:00Z`,
        inputHash: `sha256:h${i}`,
      });
    }
    return ex;
  }

  it('returns only non-neutral drift observations (neutrals filtered)', async () => {
    let call = 0;
    const grader: GraderClient = {
      grade: async () => {
        call++;
        if (call === 1) return { judged: 'worse', reason: 'missed context' };
        if (call === 2) return { judged: 'neutral', reason: 'same' };
        return { judged: 'better', reason: 'improved' };
      },
    };
    const result = await runDriftChecks({
      exchanges: makeExchanges(3),
      replay: makeReplay('new response'),
      grader,
      date: '2026-04-11',
    });
    // Only 2 non-neutral results
    assert.equal(result.length, 2);
    assert.equal(result[0]!.judged, 'worse');
    assert.equal(result[1]!.judged, 'better');
  });

  it('gives higher weight to "worse" than "better"', async () => {
    const resultWorse = await runDriftChecks({
      exchanges: makeExchanges(1),
      replay: makeReplay('new'),
      grader: makeGrader('worse'),
      date: '2026-04-11',
    });
    const resultBetter = await runDriftChecks({
      exchanges: makeExchanges(1),
      replay: makeReplay('new'),
      grader: makeGrader('better'),
      date: '2026-04-11',
    });
    assert.ok(resultWorse[0]!.weight > resultBetter[0]!.weight);
  });

  it('reports unavailable replay as failure rather than absence of drift', async () => {
    await assert.rejects(runDriftChecks({
      exchanges: makeExchanges(2),
      replay: makeReplay(null),
      grader: makeGrader('worse'),
      date: '2026-04-11',
    }), /probe_replay_unavailable/);
  });

  it('records diff summary reflecting the text change', async () => {
    const result = await runDriftChecks({
      exchanges: makeExchanges(1),
      replay: makeReplay('a very different response'),
      grader: makeGrader('worse', 'lost the concise style'),
      date: '2026-04-11',
    });
    assert.equal(result.length, 1);
    assert.ok(result[0]!.diff_summary.length > 0);
    assert.match(result[0]!.reason, /lost the concise/);
  });
});
