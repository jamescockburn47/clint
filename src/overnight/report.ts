// src/overnight/report.ts — REPORT stage composer.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.3.
//
// Reads the night's event log + the current week's observation log, builds
// a structured MorningReport, and writes it to disk as JSON plus a plain-
// text rendering for the WhatsApp briefing. The stage also writes its own
// event(s) to the event log so its own run is visible in the next day's
// report.
//
// Zero LLM calls. Deterministic given the inputs. All the reasoning lives
// in report-grooming.ts (staleness classification) and morning-report.ts
// (structured + rendered output). This file is composition only.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { StageContext, StageFn } from './runner.js';
import { queryEvents } from './events.js';
import { isoWeekOf, queryObservations } from './probe-observations.js';
import { buildMorningReport, type MorningReport } from './morning-report.js';
import { loadReportStyle, styleReport } from './report-style.js';
import type { OvernightResearchReport } from '../tasks/overnight-research.js';

export interface ReportStageDeps {
  overnightDir: string;
  /** Override "now" for deterministic tests. */
  now?: () => Date;
}

export interface ReportStageResult {
  report: MorningReport;
  text: string;
  jsonPath: string;
  textPath: string;
}

async function loadResearchReport(
  overnightDir: string,
  date: string,
): Promise<OvernightResearchReport | null> {
  try {
    const raw = await readFile(join(overnightDir, `research-${date}.json`), 'utf8');
    return JSON.parse(raw) as OvernightResearchReport;
  } catch {
    // intentional: the research task is optional; missing or unreadable reports
    // should not block the deterministic morning report.
    return null;
  }
}

/**
 * Build the REPORT stage entry point. Reads events + observations, builds
 * the structured report, persists it, and writes events.
 */
export function makeReportStage(deps: ReportStageDeps): StageFn {
  const now = deps.now ?? (() => new Date());

  return async function runReportStage(ctx: StageContext): Promise<void> {
    const nowDate = now();

    // --- 1. Read inputs ------------------------------------------------
    let events: Awaited<ReturnType<typeof queryEvents>> = [];
    let observations: Awaited<ReturnType<typeof queryObservations>> = [];
    try {
      events = await queryEvents({ date: ctx.date, overnightDir: deps.overnightDir });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'report',
        phase: 'read-events',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `read events failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    const currentWeek = isoWeekOf(nowDate);
    try {
      observations = await queryObservations({
        isoWeek: currentWeek,
        overnightDir: deps.overnightDir,
      });
    } catch (err) {
      // Non-fatal: continue with empty observations and mark in the event
      await ctx.appendEvent({
        stage: 'report',
        phase: 'read-observations',
        inputs: [`observations-${currentWeek}.jsonl`],
        outputs: [],
        verdict: 'failed',
        reason: `read observations failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      observations = [];
    }

    // --- 2. Build report ----------------------------------------------
    const built = buildMorningReport({
      date: ctx.date,
      events,
      observations,
      now: nowDate,
      repoRoot: ctx.repoRoot,
      researchReport: await loadResearchReport(deps.overnightDir, ctx.date),
    });
    const { text: rawText, ...report } = built;
    const text = styleReport(rawText, await loadReportStyle(resolve(deps.overnightDir, '..')));

    // --- 3. Persist ----------------------------------------------------
    const jsonPath = join(deps.overnightDir, `report-${ctx.date}.json`);
    const textPath = join(deps.overnightDir, `report-${ctx.date}.txt`);
    try {
      await mkdir(deps.overnightDir, { recursive: true });
      await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
      await writeFile(textPath, text, 'utf8');
    } catch (err) {
      await ctx.appendEvent({
        stage: 'report',
        phase: 'persist',
        inputs: [`events:${events.length}`, `observations:${observations.length}`],
        outputs: [],
        verdict: 'failed',
        reason: `persist failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
      return;
    }

    // --- 4. Event log entry --------------------------------------------
    await ctx.appendEvent({
      stage: 'report',
      phase: 'generate',
      inputs: [`events:${events.length}`, `observations:${observations.length}`],
      outputs: [jsonPath, textPath],
      verdict: 'ok',
      reason: `report generated: ${report.summary.consolidateEvents} consolidate, ${report.summary.probeEvents} probe, ${report.summary.operationsEvents} operations, ${report.errors.length} errors, ${report.deferredCandidates.length} deferred`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  };
}

/** Export a pure helper for the briefing integration. */
export async function buildAndRenderReport(opts: {
  date: string;
  overnightDir: string;
  now?: Date;
  repoRoot?: string;
}): Promise<{ report: MorningReport; text: string }> {
  const nowDate = opts.now ?? new Date();
  const events = await queryEvents({ date: opts.date, overnightDir: opts.overnightDir });
  const currentWeek = isoWeekOf(nowDate);
  const observations = await queryObservations({
    isoWeek: currentWeek,
    overnightDir: opts.overnightDir,
  });
  const repoRoot = opts.repoRoot ?? resolve(opts.overnightDir, '..', '..');
  const built = buildMorningReport({
    date: opts.date,
    events,
    observations,
    now: nowDate,
    repoRoot,
    researchReport: await loadResearchReport(opts.overnightDir, opts.date),
  });
  const { text: rawText, ...report } = built;
  const text = styleReport(rawText, await loadReportStyle(resolve(opts.overnightDir, '..')));
  return { report, text };
}
