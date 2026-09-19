import { currentConversation } from './conversation-context.js';

const READS = new Set(['knowledge_status', 'knowledge_search', 'knowledge_read', 'repository_status',
  'google_read_status', 'calendar_list_calendars', 'calendar_read_events', 'drive_search', 'drive_read',
  'web_search', 'web_fetch', 'system_status', 'proactive_status', 'proactive_report', 'soul_read']);

/** Only independent reads already emitted in the same model turn can overlap. */
export async function orderedToolReads(blocks, execute, scope = currentConversation()) {
  const parallel = scope?.transport === 'slack' && scope.isOwner && scope.privateContext &&
    scope.localOnly && !scope.webOnly && blocks.every(block => READS.has(block.name)) &&
    blocks.filter(block => block.name === 'knowledge_search').length <= 1 &&
    blocks.filter(block => block.name === 'drive_read').length <= 1;
  const output = new Array(blocks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= blocks.length) return;
      output[index] = await execute(blocks[index]);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: parallel ? Math.min(3, blocks.length) : 1 }, worker));
  const failure = settled.find(row => row.status === 'rejected');
  if (failure) throw failure.reason;
  return output;
}
