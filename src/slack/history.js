import { matchesEvent, authorizeActor } from './workspace-channels.js';
import { authorizeChannel } from './channel-access.js';

const STAMP = /^\d{10}\.\d{6}$/;
const ACTOR = /^[UW][A-Z0-9]+$/;
const PAGE_LIMIT = 100;
const MAX_PAGES = 2;
const STREAM_BUDGET = 22000;

/** Read Block Kit's visible text, including Clint's rich-text/table replies. */
export function visibleSlackText(message) {
  let remaining = 24000;
  const walk = (node, depth = 0) => {
    if (!node || depth > 10 || remaining <= 0) return '';
    if (Array.isArray(node)) return node.map(item => walk(item, depth + 1)).join('\n');
    let text = '';
    if (['text', 'mrkdwn', 'plain_text', 'raw_text'].includes(node.type)) text = node.text || '';
    else if (node.type === 'user') text = `<@${node.user_id}>`;
    else if (node.type === 'channel') text = `<#${node.channel_id}>`;
    else if (node.type === 'link') text = node.text || node.url || '';
    else if (node.type === 'emoji') text = `:${node.name}:`;
    else if (node.type === 'rich_text_section') {
      return (node.elements || []).map(item => walk(item, depth + 1)).join('');
    } else return [node.text, node.elements, node.rows, node.fields]
      .filter(Boolean).map(value => walk(value, depth + 1)).join('\n');
    if (typeof text !== 'string') return '';
    const bounded = text.slice(0, remaining);
    remaining -= bounded.length;
    return bounded;
  };
  const blocks = walk(message.blocks).trim();
  return blocks || (typeof message.text === 'string' ? message.text.slice(0, 24000) : '');
}

async function readPages(web, method, args, event) {
  const messages = new Map();
  let cursor;
  let status = 'complete';
  const seen = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await web.conversations[method]({ ...args, limit: PAGE_LIMIT,
        latest: event.ts, inclusive: false, ...(cursor ? { cursor } : {}) });
      if (result?.ok !== true || !Array.isArray(result.messages)) throw new Error('history_unavailable');
      for (const message of result.messages) {
        if (!STAMP.test(message.ts || '') || message.ts >= event.ts ||
            (message.channel && message.channel !== event.channel) ||
            (method === 'replies' && (message.thread_ts || message.ts) !== event.thread) ||
            (message.subtype && !['bot_message', 'thread_broadcast'].includes(message.subtype))) continue;
        const text = visibleSlackText(message);
        if (!text || !(ACTOR.test(message.user || '') || message.bot_id)) continue;
        messages.set(message.ts, { ts: message.ts, thread: message.thread_ts || message.ts,
          actorId: message.user || message.bot_id, text });
      }
      cursor = result.response_metadata?.next_cursor;
      if (!cursor) { status = result.has_more ? 'bounded' : 'complete'; break; }
      status = 'bounded';
      if (typeof cursor !== 'string' || seen.has(cursor)) break;
      seen.add(cursor);
    }
  } catch { status = messages.size ? 'partial_unavailable' : 'unavailable'; }
  let size = 0;
  const selected = [];
  for (const message of [...messages.values()].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const cost = JSON.stringify(message).length;
    if (size + cost > STREAM_BUDGET) { status = status === 'complete' ? 'bounded' : status; continue; }
    size += cost;
    selected.unshift(message);
  }
  return { status, messages: selected };
}

/** Exact current audience only. Historical text is evidence, never a replayed request. */
export async function readSlackHistory(web, config, event) {
  if (!matchesEvent(event, config) || !STAMP.test(event.ts || '') || !STAMP.test(event.thread || '')) {
    throw new Error('slack_history_scope_mismatch');
  }
  if (config.policy?.mode !== 'open') return { status: 'policy_excluded', messages: [] };
  if (!await authorizeChannel(web, config) || !await authorizeActor(web, config, event)) {
    throw new Error('slack_history_access_denied');
  }
  const channel = await readPages(web, 'history', { channel: event.channel }, event);
  const thread = event.thread !== event.ts
    ? await readPages(web, 'replies', { channel: event.channel, ts: event.thread }, event)
    : { status: 'not_applicable', messages: [] };
  const merged = new Map([...channel.messages, ...thread.messages].map(item => [item.ts, item]));
  const speakers = {};
  const actors = [...new Set([...merged.values()].map(item => item.actorId))];
  let unavailableNames = Math.max(0, actors.length - 16);
  for (const actorId of actors.slice(0, 16)) {
    if (actorId === config.botUserId) { speakers[actorId] = 'Clint'; continue; }
    if (!ACTOR.test(actorId)) { unavailableNames++; continue; }
    try {
      const result = await web.users.info({ user: actorId });
      if (result?.ok && result.user?.id === actorId) {
        const name = result.user.real_name || result.user.profile?.real_name || result.user.name;
        if (typeof name === 'string' && name) speakers[actorId] = name.slice(0, 160);
      }
      if (!speakers[actorId]) unavailableNames++;
    } catch { unavailableNames++; } // Stable IDs still identify messages; disclose missing labels.
  }
  return { channel: event.channel, before: event.ts,
    coverage: { channel: channel.status, thread: thread.status, unavailableNames }, speakers,
    messages: [...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts)) };
}
