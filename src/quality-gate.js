// Quality gate — secondary LLM review of complex responses.
//
// Historically used Claude Opus for the critique pass. When the
// optional ANTHROPIC_API_KEY is unset, falls back to MiniMax (still via
// the Anthropic SDK surface — MiniMax speaks the same API shape). When
// neither is configured, the gate silently skips (runCritique returns
// the original text unchanged).

import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import logger from './logger.js';
import { currentConversation } from './conversation-context.js';

// Prefer Claude for critique when available (its critique quality is
// notably stronger on this prompt). Fall back to MiniMax otherwise so
// the gate still runs. When neither is set the gate is disabled.
const critiqueClient = config.anthropicApiKey
  ? { client: new Anthropic({ apiKey: config.anthropicApiKey }), defaultModel: 'claude-opus-4-6', provider: 'claude' }
  : (config.minimaxApiKey
    ? { client: new Anthropic({ apiKey: config.minimaxApiKey, baseURL: config.minimaxBaseUrl }), defaultModel: config.minimaxModel, provider: 'minimax' }
    : null);

function preserveOwnerDraft(scope = currentConversation()) {
  // This pass sees only a draft, not the question or tool evidence. It cannot
  // safely rewrite source-based owner replies. Deterministic output filters remain.
  return scope?.transport === 'slack' && scope.audience === 'group' && scope.isOwner
    && scope.privateContext && scope.localOnly && scope.readOnly && !scope.webOnly;
}

const CRITIQUE_SYSTEM = `You are a ruthless quality gate. You review Clint's draft responses before they're sent to a WhatsApp group of sharp, critical people who will instantly spot AI slop.

REJECT and rewrite if ANY of these are present:

STRUCTURAL SLOP:
- 4+ bullet points or numbered items. Condense to the 2-3 that matter and explain them in prose.
- "8 things" / "5 phases" / "10 gaps" — identify the ONE that matters and explain why.
- Inventorying: "Here's what exists: [list]" — never insightful. Instead: what most people miss and why.
- Binary contrasts: "It's not X. It's Y." — state the point directly.
- Dramatic fragments: "[Noun]. That's it." — write a real sentence.
- Rhetorical questions answered immediately — delete the question, keep the answer.

LANGUAGE SLOP:
- Any of: "Here's the thing", "It's worth noting", "Let me be clear", "Moreover", "Furthermore", "Indeed", "At the end of the day", "Full stop.", "Great question!", "Absolutely!"
- Adverbs: really, just, literally, genuinely, honestly, simply, actually, deeply, truly, fundamentally, inherently, inevitably
- Business jargon: navigate, lean into, landscape, game-changer, double down, deep dive, leverage, unlock, harness, supercharge, robust, seamless
- Em dash overuse — max one per message
- False agency: "the data tells us" — name the person

SUBSTANCE SLOP:
- Truisms: "communication is key", "quality matters", "there are no easy answers"
- Sentences that restate what was already said or what's obvious from context
- Generic answers that would be equally true of any similar question
- Paragraphs that fail the "so what?" test — if a reader could say "okay, and?" it's too shallow

Every sentence must add information the reader did not already have. Density over length. Reasoning over coverage.

OUTPUT RULES:
- If the draft passes all checks, return EXACTLY "[APPROVED]" on a line by itself, followed by nothing else.
- If rewriting, output ONLY the replacement text that will be sent directly to the WhatsApp chat. No preamble, no critique, no explanation, no tags, no "Here's the rewrite", no commentary about what was wrong. Your output IS the message. The reader must never know a review happened.
- NEVER include phrases like "The draft", "I've rewritten", "Key changes", "This version", "The original" in your output. Those leak the review process.
- Default to rewriting. Be very hard to impress.`;

/**
 * Check whether a response should go through the quality gate.
 * @param {string} category - Message category from router
 * @param {string} text - Draft response text
 * @param {boolean} useClaudeClient - Whether user explicitly requested Claude
 * @returns {boolean}
 */
export function shouldCritique(category, text, useClaudeClient) {
  if (preserveOwnerDraft()) return false;
  return (
    (category === 'planning' || category === 'legal'
      || (category === 'email' && text.length > 400))
    && text.length > 200
    && !useClaudeClient  // skip if already using Opus (don't gate Opus with Opus)
    && !text.startsWith('Learned:')      // skip soul confirmations
    && !text.startsWith('Updated ')      // skip project updates
    && !text.startsWith('No pending')    // skip mechanical responses
  );
}

/**
 * Run the quality gate critique on a response. Returns the original or refined text.
 * @param {string} text - Draft response text
 * @param {string} category - Message category
 * @param {Function} trackTokensFn - Token tracking callback
 * @returns {Promise<string>} - Refined or original text
 */
export async function runCritique(text, category, trackTokensFn, reviewClient) {
  if (preserveOwnerDraft()) return text;
  const selected = reviewClient || (currentConversation()?.localOnly ? null : critiqueClient);
  if (!selected) {
    logger.info('self-critique: skipped (no LLM provider configured)');
    return text;
  }
  try {
    const critiqueModel = selected.defaultModel;
    logger.info({ category, responseLen: text.length, model: critiqueModel, provider: selected.provider }, 'self-critique: reviewing response');

    const critiqueResponse = await selected.client.messages.create({
      model: critiqueModel,
      max_tokens: config.maxResponseTokens * 4,
      system: CRITIQUE_SYSTEM.replaceAll('WhatsApp', currentConversation()?.transport === 'slack' ? 'Slack' : 'WhatsApp'),
      messages: [{ role: 'user', content: `DRAFT RESPONSE TO REVIEW:\n\n${text}` }],
    });

    if (trackTokensFn) trackTokensFn(critiqueResponse);
    if (critiqueResponse.stop_reason !== 'end_turn') throw new Error('incomplete_critique');

    let critiqueText = critiqueResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (critiqueText.startsWith('[APPROVED]')) {
      logger.info('self-critique: approved as-is');
      return text;
    }

    if (critiqueText.length > 50) {
      // Post-process: strip any leaked critique artifacts.
      // Strategy: if there's a --- separator in the first 500 chars, everything
      // before it is meta-commentary (critique preamble). Take everything after.
      const earlyDivider = critiqueText.slice(0, 500).match(/\n---\s*\n/);
      if (earlyDivider) {
        const afterDivider = critiqueText.slice(earlyDivider.index + earlyDivider[0].length).trim();
        if (afterDivider.length > 50) {
          critiqueText = afterDivider;
        }
      }

      // Strip leading meta-commentary that doesn't use --- divider
      critiqueText = critiqueText
        .replace(/^\*?REWRITE:?\*?\s*\n*/i, '')
        .replace(/^(?:This is|Let me|I'll|I've|Here's the|Here is|The draft|The original|The response|Key changes|This version).+?\.\s*\n+/i, '')
        .replace(/^(?:This is|Let me|I'll|I've|Here's the|Here is|The draft|The original|The response|Key changes|This version).+?\.\s*\n+/i, '') // second pass
        .trim();

      // Strip trailing meta-commentary and tags
      critiqueText = critiqueText
        .replace(/\n+---\s*\n+[\s\S]*$/i, '')
        .replace(/\n+(?:Key changes|Changes made|What I changed|Notes?|The draft|I've (?:removed|rewritten|condensed|tightened)).+$/is, '')
        .replace(/\s*\[(?:REWRITTEN|REVISED|APPROVED)\]\s*$/i, '')
        .replace(/\s*---\s*$/i, '')
        .trim();

      if (critiqueText.length > 50) {
        logger.info({ originalLen: text.length, revisedLen: critiqueText.length, model: critiqueModel }, 'self-critique: response refined');
        return critiqueText;
      }
    }

    return text;
  } catch (err) {
    // Critique failed -- send the original (don't block the response)
    logger.warn({ err: err.message }, 'self-critique: failed, sending original');
    return text;
  }
}
