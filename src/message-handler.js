// src/message-handler.js — WhatsApp incoming message processing
// Extracts text/media, routes through trigger/engagement/classifier, generates responses.

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import config from './config.js';
import logger from './logger.js';
import { shouldRespond } from './trigger.js';
import { pushMessage, buildContext } from './buffer.js';
import { getClawdResponseResult, getLastToolsCalled, getGroupModeResponse } from './claude.js';
import { broadcastSSE } from './sse.js';
import { logInteraction, handleReaction, isCorrection, logFeedback } from './interaction-log.js';
import { isMuteTrigger, activateMute, recordGroupResponse } from './engagement.js';
import { scanMessage } from './lquorum-rag.js';
import { logConversation } from './memory.js';
import { logIncomingConversation } from './conversation-logger.js';
import { observeMember } from './group-members.js';
import { getDocumentInfo, processDocument } from './document-handler.js';
// Phase 5: evolution-gate retired. The old DM-approval flow is replaced
// by proposal cards written to data/overnight/proposals/ by the new
// IMPROVE stage. See docs/superpowers/specs/2026-04-10-compound-dream-*.
import { cacheSentMessage } from './message-cache.js';
import { recordDecryptionFailure } from './session-repair.js';
import { filterResponse, getBlockedResponse } from './output-filter.js';
import { detectGroupMode, detectGroupModeExit, detectTopicSelection, runTopicRetrieval, executeGroupMode, buildExecutionPrompt, buildAristotlePrompt } from './group-modes.js';
import { clearPendingAction, getPendingAction } from './pending-action.js';
import { getRecentGroupMessages, formatTranscript } from './topic-scan.js';
import { runSkillPostProcessors } from './skill-registry.js';
import { getDefaultFollowUpWindowMs } from './participation/engagement-service.js';
import { openFollowUpWindow, getConversationState, recordParticipantTurn } from './participation/conversation-state.js';
import { applyProductionFollowUpTurn } from './participation/follow-up-runtime.js';
import { quotedReplyTarget } from './participation/reply-target.js';
import { createRequestId } from './request-id.js';

// --- Owner JID resolution ---
const ownerJids = new Set();
if (config.ownerJid) ownerJids.add(config.ownerJid);
if (config.ownerLid) ownerJids.add(config.ownerLid);

export function isOwnerJid(jid) {
  if (!jid || ownerJids.size === 0) return true;
  return ownerJids.has(jid);
}

export function isOwnerChat(chatJid) {
  return ownerJids.has(chatJid);
}

// --- Message text extraction ---

export function extractText(message) {
  const msg = message.message;
  if (!msg) return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';
}

function deriveReplyTarget(message, botJid) {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.stanzaId || contextInfo.participant !== botJid) {
    return null;
  }
  return quotedReplyTarget(contextInfo.stanzaId, 'Clint');
}

// --- Message splitting and typing simulation ---

const MAX_MESSAGE_LENGTH = 3000;

export function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function simulateTyping(sock, chatJid, responseLength) {
  try {
    await sock.presenceSubscribe(chatJid);
    await sock.sendPresenceUpdate('composing', chatJid);
    await new Promise((r) => setTimeout(r, Math.min(500 + responseLength * 10, 4000)));
    await sock.sendPresenceUpdate('paused', chatJid);
  } catch (_) { /* intentional: presence updates are best-effort */ }
}

// --- Dedup guard ---

const recentMessageIds = new Set();
const DEDUP_MAX = 200;

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMessageIds.has(msgId)) return true;
  recentMessageIds.add(msgId);
  if (recentMessageIds.size > DEDUP_MAX) {
    recentMessageIds.delete(recentMessageIds.values().next().value);
  }
  return false;
}

// --- Image/document follow-up caches ---
const lastImageByChat = new Map();
const lastDocByChat = new Map();

// Re-export for index.js wiring
export { handleReaction };

// --- Image download ---

async function downloadImage(message) {
  try {
    const buffer = await downloadMediaMessage(message, 'buffer', {});
    const mimeType = message.message.imageMessage.mimetype || 'image/jpeg';
    logger.info({ mime: mimeType, bytes: buffer.length }, 'image downloaded');
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  } catch (err) {
    logger.warn({ err: err.message }, 'image download failed');
    return null;
  }
}

// --- Main message handler ---

export async function handleIncomingMessage(sock, message, botJid) {
  try {
    // Detect decryption failures — messageStubType 2 = CIPHERTEXT (failed to decrypt)
    if (message.messageStubType === 2 && message.key?.remoteJid) {
      const failedJid = message.key.participant || message.key.remoteJid;
      logger.warn({ jid: failedJid, msgId: message.key.id }, 'message decryption failed — recording for session repair');
      recordDecryptionFailure(failedJid);
      return;
    }

    const msgId = message.key.id;
    if (isDuplicate(msgId)) { logger.debug({ msgId }, 'duplicate message ignored'); return; }

    const chatJid = message.key.remoteJid;
    const isGroup = chatJid?.endsWith('@g.us');
    const senderJid = message.key.participant || chatJid;
    const senderName = message.pushName || 'Unknown';
    const text = extractText(message);
    const msgHasImage = !!message.message?.imageMessage;
    const docInfo = getDocumentInfo(message);
    const replyTarget = deriveReplyTarget(message, botJid);

    logger.info({ sender: senderName, text: text || (msgHasImage ? '[photo]' : docInfo ? `[file: ${docInfo.fileName}]` : '[empty]') }, 'message received');

    if (!text && !msgHasImage && !docInfo) return;

    // Passive member observation — fixes pushName drift by pinning each
    // speaker to their JID the first time we see them in a group. Runs
    // for every group message (including Clint's own, via fromMe), so
    // bot-self is seeded without a separate code path.
    if (isGroup) {
      observeMember(chatJid, senderJid, senderName, { isBotSelf: !!message.key.fromMe });
    }

    pushMessage(chatJid, { senderName, text, hasImage: msgHasImage, isBot: false });
    if (isGroup) {
      recordParticipantTurn({
        chatJid,
        senderName,
        text: text || (msgHasImage ? '[photo]' : docInfo ? `[file: ${docInfo.fileName}]` : ''),
        messageId: msgId || null,
        timestamp: Date.now(),
        isBot: false,
      });
    }

    // Phase 5: evolution DM approval gates retired. Replaced by proposal
    // cards written to data/overnight/proposals/ by the IMPROVE stage.

    if (isGroup && text) scanMessage(text);

    // Broadcast all messages (not just owner) for mission control feed
    if (text) {
      broadcastSSE('message', {
        sender: senderName,
        text,
        timestamp: Date.now(),
        chatJid,
        isBot: false,
        isGroup,
      });
    }

    const repliedToBot = !!replyTarget;
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const mentionsClint = mentionedJids.includes(botJid);
    const followUpParticipation = applyProductionFollowUpTurn({
      chatJid,
      isGroup: !!isGroup,
      isFromMe: !!message.key.fromMe,
      now: Date.now(),
      directlyRepliesToClint: repliedToBot,
      mentionsClint,
      senderJid,
    });
    if (isGroup && mentionedJids.length > 0) {
      logger.info({ mentionedJids, botJid, text: (text || '').slice(0, 80) }, 'mention debug');
    }

    const trigger = shouldRespond({ text, hasImage: msgHasImage || !!docInfo, isFromMe: message.key.fromMe, isGroup, senderJid, botJid, groupJid: chatJid, mentionedJids });
    if (!trigger.respond && repliedToBot && !message.key.fromMe) { trigger.respond = true; trigger.mode = 'direct'; trigger.secretaryMode = false; }
    // Spec §7.6 + §8.2: if we're inside an open follow-up window, let the same
    // participant Clint just replied to continue without @mention or native reply.
    // Group security / blocked topics / output filter still apply downstream —
    // this only flips the @mention gate on the hot path.
    if (!trigger.respond && followUpParticipation.inFollowUpExchange && !message.key.fromMe) {
      trigger.respond = true;
      trigger.mode = 'direct';
      trigger.secretaryMode = false;
      logger.info({ chatJid, senderJid, turnIndex: followUpParticipation.followUpTurnIndex }, 'follow-up window continuation — bypassing mention gate');
    }

    // Preserve source identity before the response gate. Own echoes are never human evidence.
    if (config.evoMemoryEnabled && (isGroup || senderJid === config.ownerJid || senderJid === config.ownerLid)) {
      logIncomingConversation(message, { chatJid, senderName, senderJid, text });
    }

    if (!trigger.respond) return;

    // Engagement gate — disabled. Groups are @mention-only (CLAUDE.md #109-110).
    // 0.6B classifier service stopped. Future: Forge may re-introduce selective engagement.

    // Direct mute trigger
    if (trigger.mode === 'direct' && isGroup && isMuteTrigger(text)) {
      activateMute(chatJid);
      try {
        await sock.sendMessage(chatJid, { text: 'Going quiet.' });
        pushMessage(chatJid, { senderName: 'Clint', text: 'Going quiet.', hasImage: false, isBot: true });
      } catch { /* intentional: mute UI notification is best-effort */ }
      return;
    }

    logger.info({ mode: trigger.mode, chat: chatJid }, 'triggered');

    let messageText = text;
    // Strip @ prefix and bot name prefixes (clawd, clawdbot, clawdsec)
    const BOT_PREFIXES = ['clintsec', 'clintbot', 'clint', 'clawdsec', 'clawdbot', 'clawd']; // longest first to avoid partial match
    let lowerMsg = messageText.toLowerCase().replace(/^@/, ''); // strip leading @
    if (lowerMsg !== messageText.toLowerCase()) messageText = messageText.slice(1); // sync actual text
    for (const prefix of BOT_PREFIXES) {
      if (lowerMsg.startsWith(prefix + ' ') || lowerMsg === prefix) {
        messageText = messageText.slice(prefix.length).trim();
        break;
      }
    }
    if (messageText.toLowerCase().startsWith(config.triggerPrefix.toLowerCase())) {
      messageText = messageText.slice(config.triggerPrefix.length).trim();
    }

    // ── GROUP ANALYSIS MODES (devil's advocate, summary) ──────────────────
    if (isGroup) {
      const isExitRequest = detectGroupModeExit(messageText, chatJid);
      if (isExitRequest) {
        logger.info({ chatJid }, 'group analysis mode exit — falling through to normal handling');
        // Pending action already cleared by detectGroupModeExit. Fall through to classifier.
      }

      // Aristotle mode — single-step, no topic selection
      const aristotleMode = !isExitRequest && detectGroupMode(messageText);
      if (aristotleMode && aristotleMode.mode === 'aristotle') {
        logger.info({ chatJid }, 'aristotle mode triggered');
        await simulateTyping(sock, chatJid, 500);

        // Extract quoted message if present
        const quotedText = message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
          || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
          || null;

        // Build transcript — recent group messages
        const recentMessages = getRecentGroupMessages(chatJid, quotedText ? 15 : 50);
        const transcript = formatTranscript(recentMessages);

        if (!transcript && !quotedText) {
          const noDataMsg = 'Not enough recent conversation to deconstruct.';
          await sock.sendMessage(chatJid, { text: noDataMsg });
          return;
        }

        const systemPrompt = buildAristotlePrompt(transcript, quotedText);
        const userMsg = quotedText
          ? 'Deconstruct the highlighted message to its foundation using the surrounding context.'
          : 'Analyse the main thrust of this group discussion and deconstruct it to its foundation.';

        const aristotleResponse = await getGroupModeResponse(
          systemPrompt, userMsg,
          true, // useOpus — first principles reasoning needs the strongest model
          senderJid, chatJid
        );

        const finalText = aristotleResponse || 'Failed to complete the analysis. Try again.';

        // Apply output filter
        const filterResult = filterResponse(finalText, chatJid);
        const safeText = filterResult.safe ? finalText : getBlockedResponse(filterResult.reason, filterResult.blocked);

        // Log before send — see main response path comment
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clint', text: safeText, isBot: true }]); } catch (err) { logger.warn({ err: err.message }, 'conversation log failed'); }
        }
        await simulateTyping(sock, chatJid, safeText.length);
        const chunks = splitMessage(safeText);
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(chatJid, { text: chunk });
          if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
          if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
        }
        pushMessage(chatJid, { senderName: 'Clint', text: safeText, hasImage: false, isBot: true });
        return;
      }

      // Check for pending topic selection (skip if exit requested)
      const topicSel = !isExitRequest && detectTopicSelection(messageText, chatJid);
      if (topicSel) {
        logger.info({ chatJid, mode: topicSel.action.mode, selection: topicSel.selectedTopics }, 'topic selection received');
        await simulateTyping(sock, chatJid, 500);

        const execPrompt = buildExecutionPrompt(topicSel.action, topicSel.selectedTopics);

        // Stress-test mode returns an async marker — needs Sonar research before LLM call
        let execResponse;
        if (execPrompt?.stressTest) {
          // Acknowledge before slow operation (research + analysis = 30-60s)
          await sock.sendMessage(chatJid, { text: 'Researching and building adversarial analysis — this takes 30-60 seconds.' });
          const { buildStressTestPrompt } = await import('./stress-test.js');
          const { prompt, useOpus } = await buildStressTestPrompt(execPrompt.transcript, execPrompt.topicLabels);
          execResponse = await getGroupModeResponse(prompt, 'Execute the stress-test analysis.', useOpus, senderJid, chatJid);
        } else {
          execResponse = await getGroupModeResponse(
            execPrompt, 'Execute the analysis on the selected topics.',
            true, // useOpus — accuracy matters
            senderJid, chatJid
          );
        }

        clearPendingAction(chatJid);
        const finalText = execResponse || 'Failed to complete the analysis. Try again.';

        // Apply output filter
        const filterResult = filterResponse(finalText, chatJid);
        const safeText = filterResult.safe ? finalText : getBlockedResponse(filterResult.reason, filterResult.blocked);

        await simulateTyping(sock, chatJid, safeText.length);
        const chunks = splitMessage(safeText);
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(chatJid, { text: chunk });
          if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
          if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
        }
        pushMessage(chatJid, { senderName: 'Clint', text: safeText, hasImage: false, isBot: true });
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clint', text: safeText, isBot: true }]); } catch (err) { logger.warn({ err: err.message }, 'conversation log failed'); }
        }
        return;
      }

      // Check for new group mode trigger (skip if exit request — "exit devil's advocate" contains the trigger)
      const groupMode = !isExitRequest && !aristotleMode && detectGroupMode(messageText);
      if (groupMode) {
        logger.info({ chatJid, mode: groupMode.mode }, 'group analysis mode triggered');
        await simulateTyping(sock, chatJid, 200);

        const segResponse = await runTopicRetrieval(chatJid, groupMode.mode);

        // Apply output filter to the topic list too
        const filterResult = filterResponse(segResponse, chatJid);
        const safeText = filterResult.safe ? segResponse : getBlockedResponse(filterResult.reason, filterResult.blocked);

        await simulateTyping(sock, chatJid, safeText.length);
        const sent = await sock.sendMessage(chatJid, { text: safeText });
        if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
        pushMessage(chatJid, { senderName: 'Clint', text: safeText, hasImage: false, isBot: true });
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clint', text: safeText, isBot: true }]); } catch (err) { logger.warn({ err: err.message }, 'conversation log failed'); }
        }
        return;
      }
    }

    // Download image if present
    let imageData = msgHasImage ? await downloadImage(message) : null;

    // Download and process document if present
    if (docInfo && !imageData) {
      try {
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        const result = await processDocument(buffer, docInfo, messageText, senderName, chatJid, lastDocByChat, { senderJid, isGroup });
        messageText = result.messageText;
      } catch (err) {
        logger.warn({ err: err.message, fileName: docInfo.fileName }, 'document download/parse failed');
      }
    }

    // SOVREN contribution capture for plain-text messages from registered
    // contributors. The burst grouper coalesces multi-message contributions
    // (e.g. cover email + "And finally:" + template) into a single store entry.
    // Imports are lazy to avoid loading the sovren module on every message.
    if (text && !docInfo && !imageData) {
      try {
        const { detectContribution } = await import('./sovren/contribution-detector.js');
        const sovrenDetect = detectContribution({
          chatJid,
          isGroup: !!isGroup,
          senderJid,
          senderName,
          text,
          fileName: null,
        });
        if (sovrenDetect.isContribution && sovrenDetect.contributor) {
          const { recordTextMessage } = await import('./sovren/contribution-pipeline.js');
          recordTextMessage({
            contributorSlug: sovrenDetect.contributor.slug,
            contributorName: sovrenDetect.contributor.displayName,
            chatJid,
            timestamp: Date.now(),
            text,
            attachment: null,
          });
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'sovren text contribution capture failed');
      }
    }

    // Detect correction of previous response
    if (isCorrection(messageText)) {
      logFeedback({ interactionId: null, type: 'correction', signal: 'negative', detail: messageText.slice(0, 200), sender: { name: senderName, jid: senderJid } });
    }

    // Image caption defaults
    if (imageData && !messageText.trim()) {
      messageText = '[Photo shared — respond naturally as part of the conversation. React to what you see, relate it to the discussion if relevant. Do not just label or identify objects.]';
    }
    if (imageData) lastImageByChat.set(chatJid, { data: imageData, timestamp: Date.now() });

    // Follow-up image reuse (5 min TTL)
    if (!imageData && /\b(the\s+)?(image|photo|picture|pic|screenshot)\b/i.test(messageText)) {
      const lastImg = lastImageByChat.get(chatJid);
      if (lastImg && (Date.now() - lastImg.timestamp) < 5 * 60 * 1000) {
        imageData = lastImg.data;
        logger.info({ chatJid, ageMs: Date.now() - lastImg.timestamp }, 'reusing recent image for follow-up');
      }
    }

    // Generate response
    const requestId = createRequestId({ source: isGroup ? 'whatsapp_group' : 'whatsapp_dm' });
    const context = buildContext(chatJid, messageText);
    const responseStart = Date.now();
    const responseResult = await getClawdResponseResult(context, trigger.mode, senderJid, imageData, chatJid, { secretaryMode: !!trigger.secretaryMode, requestId });
    const routingResult = responseResult?.meta ?? null;
    const response = responseResult?.text ?? null;
    const responseLatency = Date.now() - responseStart;
    if (!response || !response.trim() || response.trim() === '[SILENT]') {
      if (response?.trim() === '[SILENT]') logger.debug({ chat: chatJid }, 'Claude chose silence');
      return;
    }

    // ── Skill post-processing hooks ──
    let processedResponse = response;
    try {
      const skillContext = {
        responseLength: response.length,
        isGroup: chatJid.endsWith('@g.us'),
        category: routingResult?.category,
        chatJid,
      };
      processedResponse = await runSkillPostProcessors(response, { text: messageText, category: routingResult?.category }, skillContext);
    } catch (err) {
      logger.warn({ err: err.message }, 'skill post-processing failed, using original response');
    }

    // Output filter — code-level security, cannot be prompt-injected
    const filterResult = filterResponse(processedResponse, chatJid);
    let finalResponse = processedResponse;
    if (!filterResult.safe) {
      logger.warn({ chatJid, reason: filterResult.reason, blocked: filterResult.blocked }, 'output filter blocked response');
      finalResponse = getBlockedResponse(filterResult.reason, filterResult.blocked);
    }

    // Log response BEFORE sending — if process dies between send and log, the response
    // is lost from conversation history (dream mode, topic index, decision extraction all
    // read these logs). Logging first means we may occasionally log a response that failed
    // to send, but that's far less harmful than losing responses that DID send.
    if (config.evoMemoryEnabled) {
      try { logConversation(chatJid, [{ senderName: 'Clint', text: finalResponse, isBot: true }]); } catch (err) { logger.warn({ err: err.message }, 'conversation log failed'); }
    }

    // Send response
    await simulateTyping(sock, chatJid, finalResponse.length);
    const chunks = splitMessage(finalResponse);
    const sentMsgIds = [];
    for (const chunk of chunks) {
      const sent = await sock.sendMessage(chatJid, { text: chunk });
      if (sent?.key?.id) {
        sentMsgIds.push(sent.key.id);
        cacheSentMessage(sent.key.id, sent.message);
      }
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
    }
    if (isGroup && sentMsgIds[0]) {
      // Only open a new follow-up window if one isn't already active.
      // Re-opening resets turnIndex to 0, defeating the 3-turn cap.
      const existingWindow = getConversationState(chatJid).followUpWindow;
      if (!existingWindow?.open) {
        openFollowUpWindow({
          chatJid,
          sourceMessageId: sentMsgIds[0],
          replyTarget,
          lastRepliedSenderJid: senderJid || null,
          expiresAt: Date.now() + getDefaultFollowUpWindowMs(),
        });
      }
    }

    pushMessage(chatJid, { senderName: 'Clint', text: finalResponse, hasImage: false, isBot: true });
    if (isGroup) recordGroupResponse(chatJid);

    broadcastSSE('message', {
      sender: 'Clint',
      text: finalResponse,
      timestamp: Date.now(),
      chatJid,
      isBot: true,
      isGroup,
      category: routingResult?.category,
      model: routingResult?.provider,
      modelName: routingResult?.modelName,
      requestId,
    });

    logInteraction({
      requestId,
      sender: { name: senderName, jid: senderJid }, source: 'whatsapp',
      input: { text: messageText, hadImage: !!imageData },
      routing: {
        mode: trigger.mode,
        category: routingResult?.category || null,
        model: routingResult?.provider || null,
        modelReason: routingResult?.providerReason || null,
        classifySource: routingResult?.classifySource || null,
        routeForceClaude: routingResult?.routeForceClaude || false,
      },
      participation: isGroup ? {
        replyTarget,
        directlyRepliesToClint: repliedToBot,
        mentionsClint,
        inFollowUpExchange: followUpParticipation.inFollowUpExchange,
        followUpWindowOpen: followUpParticipation.followUpWindowOpen,
        followUpTurnIndex: followUpParticipation.followUpTurnIndex,
      } : null,
      toolsCalled: getLastToolsCalled(), response: { text: finalResponse, chars: finalResponse.length, filtered: !filterResult.safe },
      latencyMs: responseLatency, messageIds: sentMsgIds,
    });

    logger.info({ requestId, mode: trigger.mode, chars: finalResponse.length, filtered: !filterResult.safe, latencyMs: responseLatency }, 'response sent');
  } catch (err) {
    logger.error({ err: err.message }, 'message handler error');
  }
}
