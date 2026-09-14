import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidateExtractor, type ExtractClient } from '../consolidate-extract.js';

describe('overnight/consolidate-extract.ConsolidateExtractor', () => {
  let tmpRoot: string;
  let logDir: string;
  let mockClient: ExtractClient;
  let capturedCalls: Array<{ conversation: string; source: string }>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-extract-'));
    logDir = join(tmpRoot, 'logs');
    mkdirSync(logDir);
    capturedCalls = [];
    mockClient = {
      extractCandidates: async (conversation: string, source: string) => {
        capturedCalls.push({ conversation, source });
        return {
          candidates: [{ message_id: JSON.parse(conversation)[0].id, category: 'general' }],
        };
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('extracts candidates from each log file matching the date', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'hello world, this is a long enough message to pass the min length check' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'hi James', isBot: true }) + '\n',
    );
    writeFileSync(
      join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'another conversation here with enough content' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'noted', isBot: true }) + '\n',
    );
    // Also a log from a different date that should be ignored.
    writeFileSync(
      join(logDir, '2026-04-08.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'old stuff' }) + '\n',
    );

    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');

    assert.equal(result.filesProcessed, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(capturedCalls.length, 2);
    assert.ok(capturedCalls[0]!.conversation.includes('hello world'));
    assert.ok(capturedCalls[1]!.conversation.includes('another conversation'));
  });

  it('returns empty result when no logs exist for the date', async () => {
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2099-01-01');
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.candidates.length, 0);
    assert.equal(capturedCalls.length, 0);
  });

  it('processes a single human statement without requiring a bot reply', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-tiny.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'hi' }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.candidates.length, 1);
  });

  it('processes short statements without discarding meaningful preferences', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-short.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'hi' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'ok', isBot: true }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
  });

  it('continues when one file fails to parse', async () => {
    writeFileSync(join(logDir, '2026-04-09-ok.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-bad.jsonl'), 'not json at all\nnope\n');
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.file, /2026-04-09-bad\.jsonl/);
  });

  it('propagates EVO extract errors into the errors array and continues', async () => {
    writeFileSync(join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', isBot: false, text: 'another valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'response', isBot: true }) + '\n',
    );
    const failingClient: ExtractClient = {
      extractCandidates: async (_conversation, source) => {
        if (source.endsWith('-b.jsonl')) throw new Error('evo timeout');
        return { candidates: [{ message_id: JSON.parse(_conversation)[0].id, category: 'general' }] };
      },
    };
    const extractor = new ConsolidateExtractor({ client: failingClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.reason, /evo timeout/);
  });
});
