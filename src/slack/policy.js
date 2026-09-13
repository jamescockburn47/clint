const stamp = /^\d{10}\.\d{6}$/;

/** Socket identity and channel/user allowlists are application checks, not model decisions. */
export function acceptMention(body, cfg, botUserId) {
  const event = body?.event;
  if (body?.type !== 'event_callback' || body.team_id !== cfg.teamId ||
      body.api_app_id !== cfg.appId || body.is_ext_shared_channel === true ||
      !/^Ev[A-Z0-9]+$/.test(body.event_id || '') || !event ||
      event.type !== 'app_mention' || event.subtype || event.bot_id || event.bot_profile ||
      event.user !== cfg.ownerId || event.user === botUserId ||
      event.channel !== cfg.channelId || event.team && event.team !== cfg.teamId ||
      !stamp.test(event.ts || '') || event.thread_ts && !stamp.test(event.thread_ts) ||
      typeof event.text !== 'string' || event.text.length > 12000 ||
      !event.text.includes(`<@${botUserId}>`)) return null;
  return { id: body.event_id, team: body.team_id, channel: event.channel,
    owner: event.user, ts: event.ts, thread: event.thread_ts || event.ts, text: event.text };
}

export function allowedChannel(info, cfg) {
  const channel = info?.channel;
  return info?.ok === true && channel?.id === cfg.channelId &&
    channel.is_private === true && channel.is_member === true &&
    channel.is_archived === false && channel.is_shared === false &&
    channel.is_ext_shared === false && channel.is_org_shared === false;
}

/** Plain text blocks prevent generated mentions/links from notifying people or unfurling. */
export function replyPayload(event, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) {
    throw new Error('slack_invalid_reply');
  }
  const chunks = [];
  for (let i = 0; i < text.length; i += 2500) chunks.push(text.slice(i, i + 2500));
  return { channel: event.channel, thread_ts: event.thread,
    text: 'Clint replied in this thread.',
    blocks: chunks.map(chunk => ({ type: 'section', text: { type: 'plain_text', text: chunk, emoji: false } })),
    unfurl_links: false, unfurl_media: false, parse: 'none' };
}
