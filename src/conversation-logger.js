// Conversation logger — JSONL per-group conversation logging

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const CONV_LOG_DIR = join('data', 'conversation-logs');

// Ensure directory exists
mkdirSync(CONV_LOG_DIR, { recursive: true });

/**
 * Log conversation messages to a per-group JSONL file.
 * `senderJid` is optional and additive — older log lines that predate
 * the member register will not have it, which is fine: downstream
 * consumers fall back to `sender` (pushName) when absent.
 * @param {string} chatJid - WhatsApp chat JID
 * @param {Array<{senderName: string, senderJid?: string, text: string, isBot: boolean}>} messages
 */
export function logConversation(chatJid, messages) {
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}_${chatJid.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`;
  const filepath = join(CONV_LOG_DIR, filename);

  const lines = messages.map(m => {
    const entry = {
      timestamp: new Date().toISOString(),
      sender: m.senderName,
      text: m.text,
      isBot: m.isBot,
      chatJid,
      messageId: m.messageId ?? null,
    };
    if (m.senderJid) entry.senderJid = m.senderJid;
    return JSON.stringify(entry);
  });

  try {
    appendFileSync(filepath, lines.join('\n') + '\n');
  } catch (err) {
    logger.error({ err: err.message }, 'conversation log write failed');
  }
}

/** The transport's fromMe flag, never display names or model judgment, identifies bot echoes. */
export function logIncomingConversation(message, fields, write = logConversation) {
  write(fields.chatJid, [{ ...fields, messageId: message.key.id ?? null,
    isBot: message.key.fromMe === true }]);
}
