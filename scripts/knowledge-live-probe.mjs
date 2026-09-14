/** Read-only live GitHub + private local index checks. Does not print archive text or write to Slack. */
import assert from 'node:assert/strict';
import { createConversationContext } from '../src/conversation-context.js';
import { repositoryStatus } from '../src/knowledge/repository.js';
import { knowledgeTool } from '../src/knowledge/tools.js';

const scope = createConversationContext({ transport: 'internal', conversationId: 'knowledge-probe',
  actorId: 'synthetic-owner', ownerId: 'synthetic-owner', audience: 'direct', localOnly: true, readOnly: true });
const github = await repositoryStatus({ id: 'clint' }, { scope });
assert.equal(github.state, 'live_github_read');
const status = JSON.parse(knowledgeTool('status', {}, { scope, path: process.argv[2] }));
assert.equal(status.state, 'snapshot');
assert.equal(status.liveAccountConnection, false);
const results = JSON.parse(knowledgeTool('search', { query: 'mentoring prototype evidence' },
  { scope, path: process.argv[2] }));
assert.ok(results.records.length);
assert.ok(results.records.every(r => r.sourceHash && r.reference && r.role && r.attribution));
console.log(JSON.stringify({ kind: 'actual_live_github_and_private_index', github,
  archiveRecords: status.records, archiveSources: status.sources,
  queryReturnedAttributedRecords: results.records.length, privateTextPrinted: false,
  semanticAnalysis: status.semanticAnalysis }, null, 2));
