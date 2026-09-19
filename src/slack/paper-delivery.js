import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { paperDirectory, paperSummaries } from './nightly-papers.js';
import { authorizeChannel } from './channel-access.js';
import { outboundArtifactSafe } from '../outbound-query.js';
import { filterResponse } from '../output-filter.js';
import { withConversationContext } from '../conversation-context.js';
import core from '../config.js';

/** A separate receipt prevents an upload failure from resending the morning message. */
export async function deliverPapers({ config, web, store, date, scopeKey, scope, now,
  signal, authorize = authorizeChannel }) {
  if (!config.papersEnabled || config.workspaceShared) return false;
  const briefing = store.get(`${date}:briefing`);
  if (briefing?.scope !== scopeKey || briefing.state !== 'sent') return false;
  const reports = paperSummaries(store, date, scopeKey).filter(row => row.report);
  if (!reports.length) return false;
  const job = store.ensure(date, 'paper_delivery', scopeKey, now());
  if (job.scope !== scopeKey || job.state !== 'pending') return false;
  const files = [];
  try {
    for (const { kind, report } of reports) {
      const filename = `${date}-${kind}.html`;
      if (report.htmlFile !== filename) throw Error('paper_artifact_identity');
      const path = join(paperDirectory(config), filename), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error('paper_artifact_invalid');
      const file = await readFile(path);
      if (!/^[a-f0-9]{64}$/.test(report.htmlSha256 || '') ||
          createHash('sha256').update(file).digest('hex') !== report.htmlSha256) throw Error('paper_artifact_invalid');
      const text = file.toString('utf8');
      if (!outboundArtifactSafe(text, { ...core, ...config }) ||
          !withConversationContext(scope, () => filterResponse(text, scope.conversationId)).safe) {
        throw Error('paper_output_restriction');
      }
      files.push({ file, filename, title: report.title });
    }
    signal.throwIfAborted();
    if (!await authorize(web, config)) throw Error('paper_channel_changed');
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) return false;
    store.update(job.id, 'blocked', now(), { error: ['paper_artifact_identity', 'paper_artifact_invalid',
      'paper_output_restriction', 'paper_channel_changed'].includes(error.message) ? error.message : 'paper_artifact_unavailable' });
    return true;
  }
  // uploadV2 may fail after sharing. Persist before the first network mutation and never blindly retry.
  store.update(job.id, 'sending', now());
  try {
    const result = await web.files.uploadV2({ file_uploads: files, channel_id: config.channelId,
      thread_ts: briefing.reply_ts, initial_comment: 'The complete HTML papers for this morning.' });
    const uploaded = result.files?.flatMap(item => item.files ?? [item]);
    if (!result.ok || uploaded?.length !== files.length || uploaded.some(file => !/^F[A-Z0-9]+$/.test(file.id || ''))) {
      throw Error('paper_upload_unconfirmed');
    }
    store.update(job.id, 'sent', now(), { report: { files: uploaded.map(file => file.id) } });
  } catch {
    store.update(job.id, 'uncertain', now(), { error: 'paper_upload_unconfirmed' });
  }
  return true;
}
