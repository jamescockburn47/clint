// src/overnight/probe-drift.ts — drift checker for PROBE.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2 item 3.
//
// Samples historical exchanges from the last N days, replays each input
// through today's bot, asks EVO 30B to judge whether the new response is
// better/worse/neutral vs the original, and writes drift observations
// for non-neutral judgments. Used by the Saturday IMPROVE grooming step
// to detect silent regressions.
//
// Contract boundaries:
//   - ReplayClient.replayInput(userInput, historyContext) → string | null
//     (production wiring calls getClawdResponse via a thin wrapper; tests mock)
//   - GraderClient.grade(a, b, context) → { judged, reason }
//     (production wiring calls evoSimpleChat with a grading prompt; tests mock)

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DriftObservation } from './probe-observations.js';

export interface ReplayClient {
  /**
   * Run the given user input through today's bot and return the response.
   * Return null if replay is unavailable or the input is unreplayable.
   */
  replayInput(userInput: string, historyContext: string): Promise<string | null>;
}

export interface GraderClient {
  /**
   * Grade response B vs response A for the same input. Returns better/worse/
   * neutral plus a one-sentence reason.
   */
  grade(
    originalResponse: string,
    newResponse: string,
    userInput: string,
  ): Promise<{ judged: 'better' | 'worse' | 'neutral'; reason: string }>;
}

export interface HistoricalExchange {
  userInput: string;
  botResponse: string;
  original_timestamp: string;
  inputHash: string;
}

export interface SampleOptions {
  logDir: string;
  referenceDate: string; // YYYY-MM-DD, usually today
  windowDays: number;
  sampleSize: number;
}

export interface DriftCheckOptions {
  exchanges: HistoricalExchange[];
  replay: ReplayClient;
  grader: GraderClient;
  date: string; // YYYY-MM-DD for the observation date field
}

/** SHA-256 hash of an input, truncated to 12 hex chars with prefix. */
export function hashInput(text: string): string {
  const full = createHash('sha256').update(text).digest('hex');
  return `sha256:${full.slice(0, 12)}`;
}

interface LogMessage {
  sender?: string;
  text?: string;
  isBot?: boolean;
  timestamp?: string;
}

/**
 * Walk back through a log file's lines and extract (userInput, botResponse)
 * pairs where a non-bot message is followed by a bot message.
 */
function parseExchangesFromLog(lines: string[]): HistoricalExchange[] {
  const parsed: LogMessage[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as LogMessage);
    } catch {
      // skip malformed
    }
  }

  const exchanges: HistoricalExchange[] = [];
  for (let i = 0; i < parsed.length - 1; i++) {
    const first = parsed[i]!;
    const second = parsed[i + 1]!;
    if (first.isBot || second.isBot !== true) continue;
    if (!first.text || !second.text) continue;
    exchanges.push({
      userInput: first.text,
      botResponse: second.text,
      original_timestamp: first.timestamp ?? '',
      inputHash: hashInput(first.text),
    });
  }
  return exchanges;
}

/**
 * Sample historical exchanges from conversation logs within the given
 * window. Returns at most `sampleSize` exchanges, drawn across the files
 * and skewed toward recent dates.
 */
export async function sampleHistoricalExchanges(
  opts: SampleOptions,
): Promise<HistoricalExchange[]> {
  if (!existsSync(opts.logDir)) return [];

  const refDate = new Date(opts.referenceDate + 'T12:00:00Z');
  const cutoff = new Date(refDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - opts.windowDays);
  const cutoffMs = cutoff.getTime();

  const all = await readdir(opts.logDir);
  const relevantFiles: string[] = [];
  for (const file of all) {
    if (!file.endsWith('.jsonl')) continue;
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const fileDate = new Date(dateMatch[1]! + 'T12:00:00Z');
    if (fileDate.getTime() >= cutoffMs && fileDate.getTime() <= refDate.getTime()) {
      relevantFiles.push(file);
    }
  }

  const allExchanges: HistoricalExchange[] = [];
  for (const file of relevantFiles) {
    try {
      const content = await readFile(join(opts.logDir, file), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const exchanges = parseExchangesFromLog(lines);
      allExchanges.push(...exchanges);
    } catch {
      // skip unreadable files
    }
  }

  if (allExchanges.length <= opts.sampleSize) return allExchanges;

  // Stratified sample: pick evenly across the array so we get a spread
  // over time rather than N from the most recent file.
  const step = allExchanges.length / opts.sampleSize;
  const sample: HistoricalExchange[] = [];
  for (let i = 0; i < opts.sampleSize; i++) {
    const idx = Math.floor(i * step);
    sample.push(allExchanges[idx]!);
  }
  return sample;
}

/**
 * Compact diff summary between two response strings. Shows length delta and
 * the first differing segment. Enough for morning review without being huge.
 */
function summariseDiff(original: string, now: string): string {
  const origLen = original.length;
  const nowLen = now.length;
  const lenDelta = nowLen - origLen;
  const sign = lenDelta >= 0 ? '+' : '';

  // Find first divergent character
  let divergeIdx = 0;
  const minLen = Math.min(origLen, nowLen);
  while (divergeIdx < minLen && original[divergeIdx] === now[divergeIdx]) {
    divergeIdx++;
  }

  const origSnippet = original.slice(Math.max(0, divergeIdx - 10), divergeIdx + 40).trim();
  const nowSnippet = now.slice(Math.max(0, divergeIdx - 10), divergeIdx + 40).trim();

  return `length ${sign}${lenDelta} chars; diverges at ~${divergeIdx}: was "${origSnippet}" now "${nowSnippet}"`;
}

const WEIGHT_BY_JUDGEMENT: Record<'better' | 'worse' | 'neutral', number> = {
  worse: 5,
  better: 3,
  neutral: 1,
};

/**
 * For each historical exchange, replay the input through today's bot,
 * grade the diff vs the original, and return DriftObservations for any
 * non-neutral judgments. Neutral results are discarded (not worth logging).
 */
export async function runDriftChecks(
  opts: DriftCheckOptions,
): Promise<DriftObservation[]> {
  const observations: DriftObservation[] = [];

  for (const exchange of opts.exchanges) {
    const newResponse = await opts.replay.replayInput(exchange.userInput, '');
    if (!newResponse?.trim()) throw new Error('probe_replay_unavailable');

    const verdict = await opts.grader.grade(
      exchange.botResponse,
      newResponse,
      exchange.userInput,
    );
    if (verdict.judged === 'neutral') continue;

    observations.push({
      kind: 'drift',
      date: opts.date,
      original_timestamp: exchange.original_timestamp,
      input_hash: exchange.inputHash,
      diff_summary: summariseDiff(exchange.botResponse, newResponse),
      judged: verdict.judged,
      reason: verdict.reason,
      evidence_refs: [exchange.inputHash],
      weight: WEIGHT_BY_JUDGEMENT[verdict.judged],
    });
  }

  return observations;
}
