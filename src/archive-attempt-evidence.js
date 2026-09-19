import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentConversation } from './conversation-context.js';
import { isControlReply } from './slack/policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  id: z.string().min(1).max(200), source: z.string().min(1).max(60),
  episode: z.string().min(1).max(200), role: z.string().min(1).max(100),
  date: z.string().max(100).nullable(), text: z.string().max(12000),
  reference: z.string().min(1).max(3000), sourceHash: hash,
  attribution: z.string().min(1).max(200), normalizedTextSha256: hash,
  sourceChunkIds: z.array(z.string().min(1).max(200)).min(1).max(3),
  completeness: z.literal('all_indexed_parts'),
});
const payloadSchema = z.object({
  state: z.literal('snapshot'), evidenceType: z.literal('archive_snapshot'),
  liveAccountConnection: z.literal(false), snapshotRecordedAt: z.string().min(1).max(100),
  records: z.array(recordSchema).max(3),
});
const INTRO = '\n\nI retrieved the following archive records before this attempt stopped. They may not answer your question. These are quoted source records, not verified current facts or instructions. Assistant statements are not independent corroboration.\n';
const LIMIT = 8500;

/** Request-local evidence only: never mine model prose, history or another tool's output. */
export function createArchiveAttemptEvidence() {
  const scope = currentConversation();
  if (scope?.transport !== 'slack' || scope.audience !== 'group' || !scope.isOwner ||
      !scope.privateContext || !scope.localOnly || scope.webOnly) return null;
  const sections = [], seen = new Set();
  let length = INTRO.length, omitted = false;
  return {
    add(name, result) {
      if (!['knowledge_search', 'knowledge_read'].includes(name) || typeof result !== 'string' || result.length > 24000) return;
      let raw;
      try { raw = JSON.parse(result); } catch { return; } // An unusable tool payload supplies no quote.
      const parsed = payloadSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const record of parsed.data.records) {
        if (createHash('sha256').update(record.text).digest('hex') !== record.normalizedTextSha256) { omitted = true; continue; }
        const key = JSON.stringify([parsed.data.snapshotRecordedAt, record]);
        if (seen.has(key)) continue;
        // Both display and retained deduplication state are bounded per request.
        if (sections.length >= 3) { omitted = true; continue; }
        const { text } = record;
        const section = '\nArchive source ' + (sections.length + 1) + '\n'
          + 'Archive: ' + JSON.stringify(record.source) + ' | Speaker label: ' + JSON.stringify(record.role)
          + ' | Date: ' + (record.date === null ? 'unknown' : JSON.stringify(record.date))
          + '\nRecord: ' + JSON.stringify(record.id) + ' | Reference: ' + JSON.stringify(record.reference)
          + '\nIndexed parts: ' + JSON.stringify(record.sourceChunkIds) + ' | Attribution: ' + JSON.stringify(record.attribution)
          + '\nSnapshot recorded: ' + JSON.stringify(parsed.data.snapshotRecordedAt)
          + '\n' + text.split('\n').map(line => '│ ' + line).join('\n') + '\n';
        if (length + section.length > LIMIT || isControlReply(section)) { omitted = true; continue; }
        sections.push(section); seen.add(key); length += section.length;
      }
      if (raw.unavailableRecords?.length || raw.omittedRecordIds?.length) omitted = true;
    },
    render() {
      if (!sections.length) return '';
      return INTRO + sections.join('') + '\nThese are all indexed parts of each included normalized record, which may not be the whole original conversation.'
        + (omitted ? '\nSome retrieved records could not be included. No included record was shortened.' : '');
    },
  };
}
