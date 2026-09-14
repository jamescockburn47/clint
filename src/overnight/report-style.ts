/** Automatic policy v1: bounded report presentation changes from explicit owner feedback. */
import { z } from 'zod';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceMessage } from './grounded-memory.js';

export const REPORT_STYLE_POLICY = 'clint-auto-report-style-v1';
export const ReportStyleSchema = z.object({ version: z.literal(1), layout: z.enum(['compact', 'spaced']) }).strict();
export type ReportStyle = z.infer<typeof ReportStyleSchema>;
export const DEFAULT_REPORT_STYLE: ReportStyle = { version: 1, layout: 'spaced' };

/** Read only the two-field allowlisted settings file; invalid input fails closed. */
export async function loadReportStyle(dataDir: string): Promise<ReportStyle> {
  try { return ReportStyleSchema.parse(JSON.parse(await readFile(join(dataDir, 'report-style.json'), 'utf8'))); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_REPORT_STYLE;
    throw err;
  }
}

/** The rule accepts explicit layout feedback only; other speakers and model suggestions have no authority. */
export function ownerStyleRequest(message: SourceMessage, ownerJids: readonly string[]): ReportStyle | null {
  if (message.isBot || !message.senderJid || !ownerJids.includes(message.senderJid)) return null;
  const match = message.text.trim().match(/^(?:\/report-style|please make (?:my |the )?(?:morning |overnight )?reports?) (compact|spaced)[.!]?$/i);
  return match ? { version: 1, layout: match[1]!.toLowerCase() as ReportStyle['layout'] } : null;
}

/** Atomically apply a valid presentation preference with a recoverable previous version. */
export async function applyReportStyle(dataDir: string, value: unknown): Promise<void> {
  const style = ReportStyleSchema.parse(value);
  await mkdir(dataDir, { recursive: true });
  const previous = await loadReportStyle(dataDir);
  await writeFile(join(dataDir, 'report-style.previous.json'), JSON.stringify(previous), 'utf8');
  const pending = join(dataDir, 'report-style.pending.json');
  await writeFile(pending, JSON.stringify(style), { encoding: 'utf8', flag: 'wx' });
  await rename(pending, join(dataDir, 'report-style.json'));
}

/** Whitespace-only rendering preserves the report's words, numbers and status labels. */
export function styleReport(text: string, style: ReportStyle): string {
  return style.layout === 'compact' ? text.replace(/\n{3,}/g, '\n\n').replace(/\n\n/g, '\n') : text;
}
