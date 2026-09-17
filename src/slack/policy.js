import { formatReply } from './format-reply.js';
const stamp = /^\d{10}\.\d{6}$/;
export const MAX_REPLY_CHARACTERS = 32000;

/** Owner messages in the configured private channel; other venues never enter the inbox. */
export function acceptMention(body, cfg, botUserId) {
  const event = body?.event;
  const addressed = event?.type === 'app_mention' && typeof event.text === 'string' && event.text.includes(`<@${botUserId}>`);
  const privateMessage = event?.type === 'message' && event.channel_type === 'group' && !cfg.workspaceShared;
  const publicMessage = event?.type === 'message' && event.channel_type === 'channel' && cfg.workspaceShared === true;
  if (body?.type !== 'event_callback' || body.team_id !== cfg.teamId ||
      body.api_app_id !== cfg.appId || body.is_ext_shared_channel === true ||
      !/^Ev[A-Z0-9]+$/.test(body.event_id || '') || !event ||
      (!addressed && !privateMessage && !publicMessage) || event.subtype || event.bot_id || event.bot_profile ||
      typeof event.user !== 'string' || !/^[UW][A-Z0-9]+$/.test(event.user) ||
      (!cfg.workspaceShared && event.user !== cfg.ownerId) || event.user === botUserId ||
      event.channel !== cfg.channelId || event.team && event.team !== cfg.teamId ||
      !stamp.test(event.ts || '') || event.thread_ts && !stamp.test(event.thread_ts) ||
      typeof event.text !== 'string' || !event.text.trim() || event.text.length > 12000) return null;
  return { id: body.event_id, team: body.team_id, channel: event.channel,
    owner: event.user, ts: event.ts, thread: event.thread_ts || event.ts, text: event.text };
}

export function allowedChannel(info, cfg) {
  const channel = info?.channel;
  return info?.ok === true && channel?.id === cfg.channelId &&
    channel.is_private === (cfg.workspaceShared ? false : true) && channel.is_member === true &&
    channel.is_archived === false && channel.is_shared === false &&
    channel.is_ext_shared === false && channel.is_org_shared === false;
}

/** Render formatting as typed elements; generated mention strings stay literal. */
export function replyPayload(event, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_REPLY_CHARACTERS || isControlReply(text)) {
    throw new Error('slack_invalid_reply');
  }
  return { channel: event.channel, thread_ts: event.thread,
    text: 'Clint replied in this thread.',
    blocks: formatReply(text),
    unfurl_links: false, unfurl_media: false, parse: 'none' };
}

export function isControlReply(text) {
  return /^\s*\[(?:INVALID|SILENT|APPROVED)\][.!]?\s*$/i.test(text) ||
    /<\/?(?:think|analysis)\b[^>]*>/i.test(text);
}
