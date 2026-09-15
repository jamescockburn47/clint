import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { currentConversation } from '../conversation-context.js';

export const PROACTIVE_NAMES = ['proactive_status', 'proactive_report'];
export const PROACTIVE_DEFINITIONS = PROACTIVE_NAMES.map((name, i) => ({ name,
  description: i ? 'Read the latest saved private research, dream hypotheses and morning diary briefing, optionally for a date. These are dated model drafts with source references, not verified facts or proof of self-training.'
    : 'Read actual private Slack background job status. Nightly research and reflection run after 03:45 London; a morning briefing after 07:00, when idle. Status records completed/failed work; schedules alone do not prove execution.',
  input_schema: { type: 'object', properties: i ? { date: { type: 'string', description: 'YYYY-MM-DD' } } : {},
    required: [], additionalProperties: false } }));

export function proactiveRead(name, input, { scope = currentConversation(),
  path = join(process.cwd(), 'data', 'proactive', 'proactive.sqlite') } = {}) {
  if (scope?.transport !== 'slack' || !scope.isOwner || !scope.privateContext || !scope.localOnly || scope.webOnly) {
    return JSON.stringify({ state: 'not_authorized' });
  }
  const args = (name === 'proactive_report' ? z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    : z.object({})).strict().safeParse(input);
  if (!args.success) return JSON.stringify({ state: 'invalid_input' });
  if (!existsSync(path)) return JSON.stringify({ state: 'no_jobs_recorded' });
  const [, team, channel] = scope.conversationId.split(':');
  const key = JSON.stringify([team, channel, scope.actorId]);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT date,kind,state,attempts,updated,error,report FROM jobs
      WHERE scope=? AND (? IS NULL OR date=?) ORDER BY date DESC,kind LIMIT ?`)
      .all(key, args.data.date ?? null, args.data.date ?? null, name === 'proactive_report' ? 2 : 6);
    return JSON.stringify({ state: 'recorded_jobs', observedAt: new Date().toISOString(),
      jobs: rows.map(({ report, ...row }) => ({ ...row,
        ...(name === 'proactive_report' ? { report: report ? JSON.parse(report) : null } : {}) })),
      interpretation: 'Saved reports are dated outputs. Dreams are hypotheses; no model weights or executable code are changed by these jobs.' });
  } catch { return JSON.stringify({ state: 'unavailable' }); }
  finally { db?.close(); }
}

export const PROACTIVE_HANDLERS = PROACTIVE_NAMES.map(name => [name, input => proactiveRead(name, input)]);
