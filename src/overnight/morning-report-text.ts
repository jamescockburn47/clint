// Plain-text rendering for morning reports (WhatsApp + console).
import type { OvernightEvent } from './events.js';
import { renderParticipationLearningSummaryBlock } from './participation-summary.js';
import type { MorningReport } from './morning-report.js';

/** Hard cap on rendered word count for WhatsApp delivery. */
export const MAX_REPORT_WORDS = 600;

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/London',
  });
}

function renderErrors(report: MorningReport): string | null {
  if (report.errors.length === 0) return null;
  const lines = [`Errors (${report.errors.length}):`];
  for (const e of report.errors) {
    lines.push(`  ${e.stage}/${e.phase}: ${e.reason}`);
  }
  return lines.join('\n');
}

function renderMemorySection(report: MorningReport): string {
  const { memoryStored, memoryRejected } = report.summary;
  const lines = ['Memory:'];
  if (report.summary.consolidateEvents === 0) {
    lines.push('  not run last night (consolidate stage produced no events).');
    return lines.join('\n');
  }
  lines.push(
    `  Persisted ${memoryStored} candidate statements from yesterday's conversations.`,
  );
  if (memoryRejected > 0) {
    lines.push(
      `  ${memoryRejected} rejected with no supporting evidence.`,
    );
  }
  lines.push(
    '  Source attribution is preserved; these statements are not independently verified facts. See storage events for remote write failures.',
  );
  return lines.join('\n');
}

const KNOWN_OPS_PHASES = new Set([
  'daily-backup',
  'trace-analyser',
  'system-refresh',
  'ground-truth',
  'overnight-research',
]);

const MAX_RESEARCH_TOPICS_IN_REPORT = 3;
const MAX_FINDING_CHARS = 240;

function renderOperationsSection(report: MorningReport): string {
  const lines: string[] = [];
  const opsEvents = report.events.filter((e) => e.stage === 'operations' && e.verdict !== 'failed');

  const byPhase = new Map<string, OvernightEvent>();
  for (const e of opsEvents) {
    if (!byPhase.has(e.phase)) byPhase.set(e.phase, e);
  }

  const backup = byPhase.get('daily-backup');
  if (backup) {
    lines.push(`Backup:\n  ${backup.reason}. If EVO crashed tonight, nothing since the backup would be lost.`);
  }
  const trace = byPhase.get('trace-analyser');
  if (trace) {
    lines.push(`Traces:\n  ${trace.reason}. These feed the weekly improve cycle.`);
  }
  const sys = byPhase.get('system-refresh');
  if (sys) {
    lines.push(`System knowledge:\n  ${sys.reason}.`);
  }
  const gt = byPhase.get('ground-truth');
  if (gt) {
    lines.push(`Ground truth:\n  ${gt.reason}. (Only updates when a response is flagged as gold.)`);
  }

  for (const [phase, event] of byPhase) {
    // Some writers (e.g. SOVREN cross-reference) emit ops events without phase/reason.
    // Skip them rather than rendering "undefined: undefined".
    if (!phase || !event.reason) continue;
    if (KNOWN_OPS_PHASES.has(phase)) continue;
    lines.push(`${phase}:\n  ${event.reason}`);
  }

  return lines.join('\n\n');
}

function renderParticipationLearningSection(report: MorningReport): string | null {
  const s = report.participationSummary;
  if (!s) return null;
  return renderParticipationLearningSummaryBlock(s, report.date);
}

function renderProbeSection(report: MorningReport): string | null {
  if (report.summary.probeEvents === 0) return null;
  const s = report.summary;
  const parts: string[] = [];
  if (s.patternsObserved > 0) parts.push(`${s.patternsObserved} patterns observed`);
  if (s.candidatesProposed > 0) parts.push(`${s.candidatesProposed} candidates proposed`);
  if (s.driftAlertsThisWeek > 0) parts.push(`${s.driftAlertsThisWeek} drift alerts`);
  if (s.qualityFailuresThisWeek > 0) parts.push(`${s.qualityFailuresThisWeek} quality failures`);
  if (parts.length === 0) parts.push('no new observations');
  return `Probe:\n  ${parts.join(', ')}.`;
}

function renderResearchTopicCount(count: number): string {
  return `${count} topic${count === 1 ? '' : 's'}`;
}

function oneLine(text: string): string {
  return text.split('\n').join(' ');
}

function renderResearchLines(report: MorningReport): string[] {
  const research = report.events.find((e) => e.stage === 'operations' && e.phase === 'overnight-research');

  if (report.researchReport?.topics.length) {
    const lines = [
      `Research: researched ${renderResearchTopicCount(report.researchReport.topics.length)} using SearXNG.`,
    ];
    for (const topic of report.researchReport.topics.slice(0, MAX_RESEARCH_TOPICS_IN_REPORT)) {
      lines.push(`  - ${topic.topic}: ${oneLine(topic.findings).slice(0, MAX_FINDING_CHARS)}`);
      if (topic.sources[0]) lines.push(`    Source: ${topic.sources[0]}`);
    }
    return lines;
  }

  if (research) {
    const lines = [`Research: ${research.reason}.`];
    const topics = research.outputs
      .filter((output) => output.startsWith('research:'))
      .map((output) => output.slice('research:'.length));
    for (const topic of topics.slice(0, MAX_RESEARCH_TOPICS_IN_REPORT)) {
      lines.push(`  - ${topic}`);
    }
    return lines;
  }

  return ['Research: no overnight research report was produced.'];
}

function renderSelfImprovementLine(report: MorningReport): string {
  const packet = [...report.events].reverse().find(event => event.stage === 'improve' && event.phase === 'proposal');
  if (packet) {
    const count = (prefix: string) => packet.outputs.find(output => output.startsWith(prefix + ':'))?.split(':')[1] ?? '0';
    const adaptation = report.events.some(event => event.phase === 'auto-apply-presentation' && event.verdict === 'ok');
    return `Learning: ${count('recollections')} recollections, ${count('hypotheses')} unverified hypotheses and ${count('improvements')} observed-failure tasks. ` +
      `Review packet ${packet.verdict === 'ok' ? 'saved' : 'saved with failures'}. ` +
      (adaptation ? 'Owner report-layout preference applied automatically. ' : '') + 'Executable source was not deployed.';
  }
  const deploy = [...report.events]
    .reverse()
    .find((e) => e.stage === 'improve' && e.phase === 'deploy');

  if (deploy) {
    const branch = deploy.outputs.find((output) => output && output !== 'none') ?? 'branch not recorded';
    if (/approval required|proposal/i.test(deploy.reason)) {
      return `Self-improvement: branch ${branch} is awaiting approval. Nothing was merged automatically.`;
    }
    return `Self-improvement: ${deploy.reason}. Branch: ${branch}.`;
  }

  const improveEvents = report.events.filter((e) => e.stage === 'improve');
  if (improveEvents.length > 0) {
    const last = improveEvents[improveEvents.length - 1]!;
    return `Self-improvement: stopped at ${last.phase}: ${last.reason}. Nothing was merged automatically.`;
  }

  return 'Self-improvement: no coding changes were attempted.';
}

function renderResearchAndSelfImprovementSection(report: MorningReport): string {
  const lines = ['*Overnight research and self-improvement*'];
  lines.push(...renderResearchLines(report));
  lines.push(renderSelfImprovementLine(report));
  return lines.join('\n');
}

function renderDriftSection(report: MorningReport): string | null {
  if (report.driftAlerts.length === 0) return null;
  const lines = [`DRIFT alerts (${report.driftAlerts.length}):`];
  for (const d of report.driftAlerts.slice(0, 3)) {
    lines.push(`  [${d.input_hash}] ${d.reason}`);
  }
  if (report.driftAlerts.length > 3) {
    lines.push(`  ... and ${report.driftAlerts.length - 3} more`);
  }
  return lines.join('\n');
}

function renderNewThisWeek(report: MorningReport): string | null {
  if (report.newThisWeek.length === 0) return null;
  const patterns = report.newThisWeek.filter((o) => o.kind === 'pattern');
  const failures = report.newThisWeek.filter((o) => o.kind === 'quality_failure');
  if (patterns.length === 0 && failures.length === 0) return null;

  const lines = ['NEW this week:'];
  for (const p of patterns.slice(0, 3)) {
    if (p.kind === 'pattern') {
      lines.push(`  - ${p.observation} (weight ${p.weight})`);
    }
  }
  for (const f of failures.slice(0, 3)) {
    if (f.kind === 'quality_failure') {
      lines.push(`  - [${f.category}] ${f.rejection_reason}`);
    }
  }
  return lines.join('\n');
}

function renderDeferredCandidates(report: MorningReport): string | null {
  if (report.deferredCandidates.length === 0) return null;
  const lines = [`DEFERRED to next deep run (${report.deferredCandidates.length}):`];
  for (const c of report.deferredCandidates.slice(0, 5)) {
    lines.push(`  - [w=${c.weight}] ${c.title}`);
    lines.push(`      ${c.scope}`);
  }
  return lines.join('\n');
}

function renderArchive(report: MorningReport): string | null {
  if (report.archive.length === 0) return null;
  return `ARCHIVE: ${report.archive.length} items from prior weeks, collapsed.`;
}

function renderBudget(report: MorningReport): string {
  const { opus_sessions_used, tokens_used } = report.budget;
  return `Budget: ${opus_sessions_used} Opus, ${tokens_used.toLocaleString('en-GB')} tokens.`;
}

/**
 * Render a structured report to plain text suitable for WhatsApp. Word-capped
 * at MAX_REPORT_WORDS with an omission pointer to the console for details.
 */
export function renderReportAsText(report: MorningReport): string {
  const sections: string[] = [`*Overnight — ${formatDate(report.date)}* (${report.mode})`];

  const errors = renderErrors(report);
  if (errors) sections.push(errors);

  sections.push(renderMemorySection(report));

  sections.push(renderResearchAndSelfImprovementSection(report));

  const ops = renderOperationsSection(report);
  if (ops) sections.push(ops);

  const probe = renderProbeSection(report);
  if (probe) sections.push(probe);

  const participation = renderParticipationLearningSection(report);
  if (participation) sections.push(participation);

  const drift = renderDriftSection(report);
  if (drift) sections.push(drift);

  const newThis = renderNewThisWeek(report);
  if (newThis) sections.push(newThis);

  const deferred = renderDeferredCandidates(report);
  if (deferred) sections.push(deferred);

  const archive = renderArchive(report);
  if (archive) sections.push(archive);

  sections.push(renderBudget(report));
  if (report.errors.length === 0) {
    sections.push('No errors.');
  }

  const full = sections.join('\n\n');
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_REPORT_WORDS) return full;

  const truncated = words.slice(0, MAX_REPORT_WORDS).join(' ');
  return `${truncated}\n\n... (further events omitted, open Clint Console for full detail)`;
}
