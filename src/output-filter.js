// src/output-filter.js — Code-level output filtering for group security
// Scans responses before sending. Pattern matching is defense in depth, not proof against all injection.
// Deterministic regex/keyword scanning — not LLM-based.
import { getGroupConfig, getGroupMode } from './group-registry.js';
import logger from './logger.js';
import { isGroupConversation } from './conversation-context.js';

// ── BLOCKED PATTERNS BY MODE ──────────────────────────────────────────────────
// 'project' mode: personal life blocked
// 'colleague' mode: personal life + all side projects blocked
// 'open' mode: no filtering (except per-group blocked topics and canary)

const MODE_PATTERNS = {
  // Project mode: block personal life leaking into responses
  project: [
    /\b(henry|henry'?s)\b/i,
    /\byorkshire\b/i,  // was york(shire)? — false-positived on New York
    /\bkings?\s*cross\b/i,
    /\blner\b/i,
    /\b(helmsley|pickering|kirkbymoorside|hutton.le.hole|malton|hovingham)\b/i,
    /\b(whitby|robin\s*hood'?s?\s*bay|staithes|runswick|sandsend)\b/i,
    /\bMG\b/, // wife's initial — case sensitive to avoid false positives
  ],

  // Colleague mode: personal life (inherited) + all side projects
  colleague: [
    // Side project names
    /\blearned\s*hand\b/i,
    /\bshlomo\b/i,
    /\blegal\s*quants?\b/i,
    /\blquorum\b/i,
    /\brecordum\b/i,
    /\batlas\b/i,
    /\b(ai\s*)?consultancy\b/i,
  ],
};

// ── PER-GROUP BLOCKED TERMS ────────────────────────────────────────────────
// Built from the group's blockedTopics config. These are exact keyword matches
// (case-insensitive) that apply regardless of mode.

function buildBlockedTopicPatterns(topics) {
  if (!topics || topics.length === 0) return [];
  return topics.map(topic => {
    // Escape regex special chars, then create word-boundary pattern
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  });
}

// ── CANARY TOKEN ───────────────────────────────────────────────────────────
// Random string injected into system prompt. If it appears in output,
// the model is leaking the system prompt.

let _canaryToken = null;

export function getCanaryToken() {
  if (!_canaryToken) {
    _canaryToken = 'CANARY_' + Math.random().toString(36).slice(2, 10).toUpperCase();
  }
  return _canaryToken;
}

export function resetCanaryToken() {
  _canaryToken = null;
}

// ── MAIN FILTER ────────────────────────────────────────────────────────────

/**
 * Filter a response for a specific group chat.
 * Returns { safe: true, text } if OK, or { safe: false, reason, blocked } if blocked.
 *
 * @param {string} responseText - The generated response
 * @param {string} chatJid - The group JID (null for DMs — no filtering)
 * @returns {{ safe: boolean, text?: string, reason?: string, blocked?: string[] }}
 */
export function filterResponse(responseText, chatJid) {
  // No filtering for DMs
  if (!isGroupConversation(chatJid)) {
    return { safe: true, text: responseText };
  }

  const mode = getGroupMode(chatJid);
  const config = getGroupConfig(chatJid);
  const blocked = [];

  // 1. Canary token check (system prompt leakage)
  if (_canaryToken && responseText.includes(_canaryToken)) {
    logger.warn({ chatJid, mode }, 'output-filter: CANARY TOKEN DETECTED — system prompt leak blocked');
    return { safe: false, reason: 'system_prompt_leak', blocked: ['canary_token'] };
  }

  // 2. Open mode skips pattern checks (only canary + blocked topics apply)
  if (mode !== 'open') {
    // Project-level patterns (personal life) — apply to project AND colleague modes
    for (const pattern of MODE_PATTERNS.project) {
      if (pattern.test(responseText)) {
        blocked.push(pattern.source);
      }
    }

    // Colleague-level patterns (side projects) — apply to colleague mode only
    if (mode === 'colleague') {
      for (const pattern of MODE_PATTERNS.colleague) {
        if (pattern.test(responseText)) {
          blocked.push(pattern.source);
        }
      }
    }
  }

  // 3. Per-group blocked topics (always apply, even in open mode)
  if (config?.blockedTopics) {
    const topicPatterns = buildBlockedTopicPatterns(config.blockedTopics);
    for (const pattern of topicPatterns) {
      if (pattern.test(responseText)) {
        blocked.push(pattern.source);
      }
    }
  }

  if (blocked.length > 0) {
    logger.warn({ chatJid, mode, blockedCount: blocked.length }, 'output-filter: response blocked');
    return { safe: false, reason: 'content_violation', blocked };
  }

  return { safe: true, text: responseText };
}

/**
 * Safe replacement message when a response is blocked.
 * Never disclose the triggering private terms to the destination audience.
 */
export function getBlockedResponse(reason) {
  if (reason === 'system_prompt_leak') {
    return "I can't share that information.";
  }
  // Matched terms are private diagnostics, never material to echo into the group.
  return "I can't discuss that in this context.";
}
