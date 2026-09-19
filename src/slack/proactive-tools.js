import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { currentConversation } from '../conversation-context.js';

export const PROACTIVE_NAMES = ['proactive_status', 'proactive_report'];
export const PROACTIVE_DEFINITIONS = PROACTIVE_NAMES.map((name, i) => ({ name,
  description: i ? 'Read audience-permitted saved research, self-improvement paper receipts or briefings, optionally by date and kind. Private HTML papers are attached to the morning briefing. Public audiences receive research only. Reports are dated model analyses, not verification of their claims.'
    : 'Read audience-permitted background job status. When enabled, self-improvement starts after 00:30 London, general papers after 01:00, and the private morning briefing after 07:00 once papers finish or exhaust retries. Existing research runs after 03:45. Public audiences expose research status only; recorded jobs establish actual state.',
  input_schema: { type: 'object', properties: i ? { date: { type: 'string', description: 'YYYY-MM-DD' },
    kind: { type: 'string', enum: ['research', 'paper', 'self_review', 'briefing', 'paper_delivery'] } } : {},
    required: [], additionalProperties: false } }));

export function proactiveRead(name, input, { scope = currentConversation(),
  path = join(process.cwd(), 'data', 'proactive', 'proactive.sqlite') } = {}) {
  const shared = scope?.policy.workspaceShared === true;
  if (scope?.transport !== 'slack' || (!scope.isOwner && !shared) || !scope.privateContext || !scope.localOnly || scope.webOnly) {
    return JSON.stringify({ state: 'not_authorized' });
  }
  const args = (name === 'proactive_report' ? z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    kind: z.enum(['research', 'paper', 'self_review', 'briefing', 'paper_delivery']).optional() })
    : z.object({})).strict().safeParse(input);
  if (!args.success) return JSON.stringify({ state: 'invalid_input' });
  if (shared && args.data.kind && args.data.kind !== 'research') return JSON.stringify({ state: 'not_authorized' });
  if (!existsSync(path)) return JSON.stringify({ state: 'no_jobs_recorded' });
  const [, team, channel] = scope.conversationId.split(':');
  const key = shared ? scope.policy.researchScope : JSON.stringify([team, channel, scope.actorId]);
  if (shared && !key) return JSON.stringify({ state: 'not_authorized' });
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT date,kind,state,attempts,updated,error,report FROM jobs
      WHERE scope=? AND (?=0 OR kind='research') AND (? IS NULL OR date=?) AND (? IS NULL OR kind=?) ORDER BY date DESC,kind LIMIT ?`)
      .all(key, shared ? 1 : 0, args.data.date ?? null, args.data.date ?? null,
        args.data.kind ?? null, args.data.kind ?? null, name === 'proactive_report' ? 2 : 6);
    return JSON.stringify({ state: 'recorded_jobs', observedAt: new Date().toISOString(),
      jobs: rows.map(({ report, ...row }) => ({ ...row,
        ...(name === 'proactive_report' ? { report: report ? JSON.parse(report) : null } : {}) })),
      interpretation: 'Saved reports are dated outputs. Dreams are hypotheses; no model weights or executable code are changed by these jobs.' });
  } catch { return JSON.stringify({ state: 'unavailable' }); }
  finally { db?.close(); }
}

export const PROACTIVE_HANDLERS = PROACTIVE_NAMES.map(name => [name, input => proactiveRead(name, input)]);
