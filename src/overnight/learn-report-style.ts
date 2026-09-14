/** Apply the owner's explicit low-risk report-layout feedback under policy v1. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSourceLine, type SourceMessage } from './grounded-memory.js';
import { ownerStyleRequest, applyReportStyle, loadReportStyle, REPORT_STYLE_POLICY } from './report-style.js';
import { appendEvent } from './events.js';

export async function learnReportStyle(opts: { date: string; logDate: string; logDir: string;
  dataDir: string; overnightDir: string; ownerJids: string[] }): Promise<void> {
  const messages: SourceMessage[] = [];
  let files: string[];
  try { files = await readdir(opts.logDir); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  for (const file of files.filter(f => f.startsWith(opts.logDate) && f.endsWith('.jsonl')).sort()) {
    const lines = (await readFile(join(opts.logDir, file), 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.trim()) continue;
      const message = readSourceLine(lines[i]!, file, i + 1);
      if (!message.timestamp || !Number.isFinite(Date.parse(message.timestamp)) ||
        !message.chatJid || !opts.ownerJids.includes(message.chatJid)) continue;
      if (ownerStyleRequest(message, opts.ownerJids)) messages.push(message);
    }
  }
  messages.sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
  const message = messages.at(-1);
  if (!message) return;
  const style = ownerStyleRequest(message, opts.ownerJids)!;
  if ((await loadReportStyle(opts.dataDir)).layout === style.layout) return;
  await applyReportStyle(opts.dataDir, style);
  await appendEvent({ stage: 'improve', phase: 'auto-apply-presentation', inputs: [message.id],
    outputs: ['data/report-style.json'], verdict: 'ok', reason: `${REPORT_STYLE_POLICY}: owner-requested ${style.layout} layout applied. Report content and authority unchanged.`,
    evidence_refs: [message.hash], rollback_ref: 'data/report-style.previous.json',
    budget: { opus_sessions: 0, tokens: 0 },
  }, { date: opts.date, overnightDir: opts.overnightDir });
}
