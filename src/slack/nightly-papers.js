import { join } from 'node:path';
import { researchPaper, selfReview } from '../overnight/paper-research.js';
import { executeTool } from '../tools/handler.js';
import { boundToolResult } from '../tool-result.js';

export const PAPER_KINDS = new Set(['paper', 'self_review']);
export function papersPending(store, date, scope) {
  return [...PAPER_KINDS].some(kind => {
    const row = store.get(`${date}:${kind}`);
    return !row || row.scope === scope && ['pending', 'running'].includes(row.state) && row.attempts < 3;
  });
}
/** Separate durable work items; selection never depends on a model's claimed confidence. */
export function nextPaperJob(store, date, minute, scope, now) {
  for (const [kind, due] of [['self_review', 30], ['paper', 60]]) {
    if (minute < due || minute >= 1200) continue;
    const job = store.ensure(date, kind, scope, now);
    if (job.scope === scope && job.state === 'pending' && job.attempts < 3 &&
        (!job.attempts || now - job.updated >= 15 * 60000)) return kind;
  }
  return null;
}

export async function runPaperJob({ kind, date, chat, signal, owner, conversationId, directory,
  statements, outcomes, history, tool = executeTool }) {
  if (!PAPER_KINDS.has(kind)) throw Error('invalid_paper_kind');
  const call = names => async (name, input) => {
    signal.throwIfAborted();
    if (!names.has(name)) throw Error('nightly_tool_not_permitted');
    const result = boundToolResult(name, await tool(name, input, owner, conversationId));
    signal.throwIfAborted();
    return result;
  };
  const privateTool = call(new Set(['knowledge_search', 'system_status', 'repository_status']));
  const args = { date, chat, signal, directory, privateTool, history,
    publicTool: call(new Set(['web_search', 'web_fetch'])) };
  return kind === 'paper' ? researchPaper(args)
    : selfReview({ ...args, statements, outcomes });
}

export function paperDirectory(config) { return join(config.dataDir, 'data', 'proactive', 'papers'); }
export function paperSummaries(store, date, scope) {
  return [...PAPER_KINDS].map(kind => {
    const row = store.get(`${date}:${kind}`);
    if (!row || row.scope !== scope) return { kind, state: 'not_recorded' };
    return { kind, state: row.state === 'pending' && row.attempts >= 3 ? 'attempts_exhausted' : row.state, attempts: row.attempts, error: row.error,
      report: row.state === 'complete' && row.report ? JSON.parse(row.report) : null };
  });
}

export function appendPaperSummaries(text, papers) {
  return text + '\n\nNightly papers (private):\n' + papers.map(({ kind, state, report }) => report
    ? `\n${kind === 'paper' ? 'Technical research' : 'Self-improvement'}: ${report.title}\n${report.summary}\nHTML: ${report.htmlFile}`
    : `\n${kind === 'paper' ? 'Technical research' : 'Self-improvement'}: ${state}. No completed paper is available.`).join('\n');
}
