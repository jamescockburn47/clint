import config from './config.js';
import { getGroupConfig, getGroupLabel } from './group-registry.js';

// Bot names for direct addressing. @mention always works regardless of name.
// 'claude' and 'assistant' deliberately excluded — too broad, matches general AI discussion.
// 'clawd' kept temporarily for backward compatibility during transition.
const BOT_NAMES = ['clint', 'clintbot', 'clintsec', 'clawd', 'clawdbot', 'clawdsec'];

// Secretary mode trigger — admin/single-tool mode, skips planner
const SECRETARY_NAMES = ['clintsec', 'clawdsec'];
const NAME_IN_TEXT_GROUP_LABELS = new Set(['sovren']);

export function shouldRespond({ text, hasImage, isFromMe, isGroup, senderJid, botJid, groupJid, mentionedJids }) {
  // Never respond to own messages
  if (isFromMe || senderJid === botJid) {
    return { respond: false };
  }

  // Always respond to DMs
  if (!isGroup) {
    const secretaryMode = detectSecretaryMode(text);
    return { respond: true, mode: 'direct', secretaryMode };
  }

  // Only respond in configured group (if set)
  const groupLabel = (getGroupLabel(groupJid) || '').trim().toLowerCase();
  const groupConfig = getGroupConfig(groupJid);
  const allowProjectScopedBypass = !!(groupConfig?.allowedProjects?.length);
  if (config.whatsappGroupJid && groupJid !== config.whatsappGroupJid && !allowProjectScopedBypass) {
    return { respond: false };
  }

  // Skip empty messages
  if (!text && !hasImage) {
    return { respond: false };
  }

  const lowerText = (text || '').toLowerCase();

  // Group chats: respond ONLY to @mention, prefix command, or reply-to-bot
  // (reply-to-bot is handled in message-handler.js)

  // 1. @mention via JID or LID (WhatsApp tag)
  if (mentionedJids && mentionedJids.length > 0) {
    const normBotJid = (botJid || '').replace(/:\d+@/, '@');
    const botLid = globalThis._clawdBotLid || null;
    const normBotLid = botLid ? botLid.replace(/:\d+@/, '@') : null;

    const mentioned = mentionedJids.some(jid => {
      const normJid = jid.replace(/:\d+@/, '@');
      if (normJid === normBotJid) return true;
      if (normBotLid && normJid === normBotLid) return true;
      return false;
    });

    if (mentioned) {
      return { respond: true, mode: 'direct', secretaryMode: detectSecretaryMode(text) };
    }
  }

  // 2. Prefix command (e.g. "clawd ..." or "clawdsec ...")
  for (const name of BOT_NAMES) {
    if (lowerText === name || (lowerText.startsWith(name) && /^[\s,.:;!?–—-]/.test(lowerText.slice(name.length)))) {
      return { respond: true, mode: 'direct', secretaryMode: SECRETARY_NAMES.includes(name) };
    }
  }

  // 3. Name-in-text addressing for explicitly opted-in project groups (e.g. SOVREN)
  if (
    NAME_IN_TEXT_GROUP_LABELS.has(groupLabel)
    && groupConfig?.projectScopeMode === 'single_project_only'
    && BOT_NAMES.some((name) => lowerText.includes(name))
  ) {
    return { respond: true, mode: 'direct', secretaryMode: detectSecretaryMode(text) };
  }

  // Not directly addressed → silent. No passive mode.
  // Future: autonomous participation will re-introduce selective engagement here.
  return { respond: false };
}

/**
 * Detect if the message is using secretary mode (clawdsec prefix or keyword).
 * Works in both DMs and groups.
 */
function detectSecretaryMode(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  for (const name of SECRETARY_NAMES) {
    if (lower.startsWith(name + ' ') || lower === name) return true;
  }
  return false;
}
