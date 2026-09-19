// src/router.js — Smart activity-based message router
// Layers: 4B classifier (primary) → keyword heuristics (fallback) → 0.6B LLM → default
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { classifyViaEvo, classifyVia4B } from './evo-llm.js';
import { CATEGORY } from './constants.js';
import { plannerBreaker } from './evo-client.js';

// Re-export CATEGORY so existing consumers don't break
export { CATEGORY };

// --- Static routing tables ---

const AVAILABLE_READ_TOOLS = new Set(['task_list', 'task_read', 'system_status', 'web_search', 'web_fetch', 'knowledge_search', 'knowledge_read', 'knowledge_status', 'repository_status']);

const CATEGORY_TOOLS = {
  [CATEGORY.CALENDAR]: new Set(['calendar_list_events', 'calendar_create_event', 'calendar_update_event', 'calendar_find_free_time']),
  [CATEGORY.TASK]: new Set(['task_save', 'task_list', 'task_read', 'task_set_status', 'todo_add', 'todo_list', 'todo_complete', 'todo_remove', 'todo_update']),
  [CATEGORY.TRAVEL]: new Set(['train_departures', 'train_fares', 'hotel_search', 'search_trains', 'search_accommodation']),
  [CATEGORY.EMAIL]: new Set(['gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send']),
  [CATEGORY.RECALL]: new Set([
    'memory_search', 'memory_update', 'memory_delete',
    'project_list', 'project_read', 'project_pitch', 'project_update',
    'project_list_files', 'project_file_read',
    'overnight_report',
  ]),
  [CATEGORY.PLANNING]: null,
  [CATEGORY.CONVERSATIONAL]: new Set(),
  [CATEGORY.GENERAL_KNOWLEDGE]: new Set(['web_search', 'web_fetch']),
  [CATEGORY.SYSTEM]: new Set(['system_status', 'memory_search', 'overnight_report']),
};

const READ_SAFE_TOOLS = new Set([
  'todo_list', 'calendar_list_events', 'calendar_find_free_time',
  'memory_search', 'system_status', 'soul_read',
  'project_list', 'project_read', 'project_pitch',
  'project_list_files', 'project_file_read',
]);
const WRITE_DANGEROUS_TOOLS = new Set(['gmail_draft', 'gmail_confirm_send', 'calendar_create_event', 'calendar_update_event', 'soul_propose', 'soul_confirm', 'memory_update', 'memory_delete']);
const WRITE_LIKELY_CATEGORIES = new Set([CATEGORY.EMAIL]);
const MEMORY_CATEGORIES = new Set([CATEGORY.TRAVEL, CATEGORY.RECALL, CATEGORY.PLANNING, CATEGORY.SYSTEM]);
const CLAUDE_CATEGORIES = new Set([CATEGORY.EMAIL, CATEGORY.PLANNING, CATEGORY.RECALL, CATEGORY.SYSTEM]);
const VALID_CATEGORIES = new Set(Object.values(CATEGORY));
const EXPLICIT_RECALL_PATTERN = /\b(search|check|look in|query|use)\s+(?:your\s+)?memor(?:y|ies)\b|\bfrom memory\b|\b(?:do you remember|what did (?:i|we) (?:say|decide)|recall)\b/;

const CLASSIFY_PROMPT = `Classify this WhatsApp message into exactly one category.
Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge, system

Rules:
- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation, booking trips
- "email" = reading/sending/drafting emails, inbox, gmail
- "recall" = asking about something previously discussed, stored facts, "do you remember", "what did I say about"
- "planning" = complex multi-step reasoning, organising something that needs tools AND context
- "conversational" = chat, banter, greetings, opinions, no tools needed
- "general_knowledge" = factual questions, current info, web lookups, "what is X", "who is Y"
- "system" = questions about the bot itself, its architecture, status, services, voice pipeline, what's running, what changed, deployments, components

Reply with ONLY the category name. Nothing else.`;

// --- Keyword rules (static + learned) ---

const KEYWORD_RULES = [
  { category: CATEGORY.RECALL, test: (l) => /\b(dream|diary|dreamt|dreamed|last night|overnight|overnight.*report)\b/.test(l) && /\b(tell|what|about|how|show|recall|review|read|describe|share|report|regenerate|resend|send|generate)\b/.test(l) },
  { category: CATEGORY.PLANNING, test: (l) => /\b(soul|personality)\b/.test(l) && /\b(change|update|modify|propose|set|adjust|learn|forget|remove)\b/.test(l) },
  { category: CATEGORY.PLANNING, test: (l) => /\b(project|pitch|atlas|clint.?agi|clawd.?agi|sovren)\b/.test(l) },
  { category: CATEGORY.PLANNING, test: (l) => /\b(self.?program|self.?cod|evolution|evolve|tweak.*classif|fix.*yourself|upgrade.*yourself|improve.*yourself|recode|reprogram)\b/.test(l) },
  { category: CATEGORY.EMAIL, test: (l) => (/\b(gmail|inbox|draft an? email|send an? email|reply to .* email|forward .* email|compose)\b/.test(l)) || (/\b(email|mail)\b/.test(l) && /\b(check|read|search|send|draft|compose|write|reply|forward)\b/.test(l)) },
  { category: CATEGORY.TASK, test: (l) => /\b(todo|to-do|to do list|remind me|add task|mark done|mark complete|my tasks|reminders)\b/.test(l) || l.startsWith('/todo') },
  { category: CATEGORY.CALENDAR, test: (l) => /\b(calendar|diary|what'?s on|free time|schedule|book an? event|my week|my day|upcoming events|what am i doing|what have i got)\b/.test(l) },
  { category: CATEGORY.TRAVEL, test: (l) => /\b(trains?|flights?|hotels?|travel|fares?|depart\w*|lner|airbnb|accommodation|booking|glamping|cottages?)\b/.test(l) },
  { category: CATEGORY.SYSTEM, test: (l) => /\b(system status|architecture|how do(?:es)? (?:the |my )?(?:voice|whatsapp|dashboard|routing|evo|pi|system|pipeline))\b/.test(l) || /\b(what(?:'s| is) running|what services|what components|system report|status report)\b/.test(l) || /\b(what changed|changelog|what version|current version|deployment|what(?:'s| is) deployed)\b/.test(l) || /\b(how are you running|how do you work|what are you running on|tell me about yourself)\b/.test(l) || /\b(self[- ]?aware|know yourself|what are you|who are you as a system)\b/.test(l) || /\b(evo x2|ollama|llama-server|whisper model|voice listener|noise suppression)\b/.test(l) || /\b(agi|your (?:plan|roadmap|capabilities|functions|features|progress)|how far along|what can you do|what do you do)\b/.test(l) || /\b(your evolution|your dream|your soul|your memory|your diary|overnight (?:report|coding|learning))\b/.test(l) || /\b(how (?:do|does) (?:clint|clawd|you) (?:work|learn|think|evolve|improve|dream))\b/.test(l) || /\b(tell me (?:about|what) you(?:rself)?|describe yourself|explain yourself|what(?:'s| is) your status)\b/.test(l) },
  { category: CATEGORY.GENERAL_KNOWLEDGE, test: (l) => /^(search for|google|look up|what is|who is|how does|how do you|how much does|where is|when did|when was|when is|when does)\b/.test(l) || /\b(search the web|web search|look this up)\b/.test(l) || /\b(tell me about|explain|latest news|current price|is .{2,30} legal|how many|how much|what happened|what's happening|what are the|who founded|who started|who owns|what year|what date|which country)\b/.test(l) || /\b(compare|difference between|pros and cons|best .{2,30} for|top \d|versus|vs\b)/.test(l) },
];

// --- RouterService class ---

class RouterService {
  constructor({ evoClassify, evo4BClassify, breakerCall }) {
    this._evoClassify = evoClassify;
    this._evo4BClassify = evo4BClassify;
    this._breakerCall = breakerCall;
    this._learnedRules = [];
    this._learnedRulesLoadedAt = 0;
    this._llmCircuitBreaker = { failures: 0, lastFailure: 0, openUntil: 0, THRESHOLD: 3, COOLDOWN_MS: 30000, WINDOW_MS: 60000 };
    this._reloadLearnedRules();
  }

  // --- Learned rules ---

  _reloadLearnedRules() {
    try {
      const LEARNED_RULES_FILE = join('data', 'learned-rules.json');
      if (!existsSync(LEARNED_RULES_FILE)) { this._learnedRules = []; this._learnedRulesLoadedAt = Date.now(); return; }
      const data = JSON.parse(readFileSync(LEARNED_RULES_FILE, 'utf-8'));
      this._learnedRules = (data.rules || [])
        .filter(r => r.approved !== false)
        .map(r => ({ category: r.category, test: (lower) => new RegExp(r.pattern).test(lower), source: 'learned', id: r.id }));
      this._learnedRulesLoadedAt = Date.now();
      if (this._learnedRules.length > 0) logger.info({ count: this._learnedRules.length }, 'learned rules loaded');
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to load learned rules');
      this._learnedRules = [];
    }
  }

  _ensureLearnedRulesLoaded() {
    if (Date.now() - this._learnedRulesLoadedAt > 300000) this._reloadLearnedRules();
  }

  // --- Write intent detection ---

  _detectsWriteIntent(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (/\b(create|add|book|schedule|move|cancel|update|change|reschedule)\b/.test(lower) && /\b(event|meeting|appointment|calendar)\b/.test(lower)) return true;
    if (/\b(send|draft|compose|write|reply|forward)\b/.test(lower) && /\b(email|mail|message)\b/.test(lower)) return true;
    return false;
  }

  // --- Keyword classification ---

  classifyByKeywords(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    if (EXPLICIT_RECALL_PATTERN.test(lower)) return CATEGORY.RECALL;
    this._ensureLearnedRulesLoaded();
    const allRules = [...KEYWORD_RULES, ...this._learnedRules];
    const categories = [...new Set(allRules.filter(r => r.test(lower)).map(r => r.category))];
    return categories.length === 1 ? categories[0] : null;
  }

  // --- LLM classification (0.6B fallback) ---

  async classifyByLLM(text) {
    const cb = this._llmCircuitBreaker;
    if (Date.now() < cb.openUntil) { logger.debug('EVO circuit breaker open, skipping LLM classifier'); return null; }
    if (cb.failures > 0 && Date.now() - cb.lastFailure > cb.WINDOW_MS) cb.failures = 0;

    try {
      const raw = await this._evoClassify(text, CLASSIFY_PROMPT);
      if (raw && VALID_CATEGORIES.has(raw)) { cb.failures = 0; logger.info({ category: raw, source: 'llm_classifier' }, 'message classified'); return raw; }
      logger.warn('LLM classifier returned invalid category');
      cb.failures++; cb.lastFailure = Date.now();
      if (cb.failures >= cb.THRESHOLD) cb.openUntil = Date.now() + cb.COOLDOWN_MS;
      return null;
    } catch (err) {
      cb.failures++; cb.lastFailure = Date.now();
      if (cb.failures >= cb.THRESHOLD) { cb.openUntil = Date.now() + cb.COOLDOWN_MS; logger.warn({ failures: cb.failures }, 'EVO circuit breaker opened'); }
      logger.warn({ err: err.message }, 'LLM classifier failed');
      return null;
    }
  }

  // --- Main entry point ---

  /**
   * Classify a message. `groupProject` is the project id this group is
   * bound to (from group-registry `allowedProjects[0]`) — when set,
   * ambiguous-scope categories (conversational, general_knowledge) are
   * forced through Claude so better tool selection happens; the category
   * itself is preserved for downstream tool-filter logic. Also tags the
   * result with `projectContext` so callers (prompt, tool policy) can
   * specialise without re-reading the group registry.
   */
  async classify(text, hasImage, isGroup = false, groupProject = null) {
    const applyProjectBias = (result) => {
      if (!groupProject) return result;
      result.projectContext = groupProject;
      // Ambiguous-scope categories: the 4B sees no chat context so a
      // question about an internal project looks generic. Force Claude
      // and record WHY so trace-analysis can see the bias fired.
      const ambiguous =
        result.category === CATEGORY.GENERAL_KNOWLEDGE ||
        result.category === CATEGORY.CONVERSATIONAL;
      if (ambiguous && !result.forceClaude) {
        result.forceClaude = true;
        result.reason = `project-bound group (${groupProject}) — forcing Claude for better tool selection`;
      }
      return result;
    };

    if (hasImage) {
      logger.info({ category: CATEGORY.PLANNING, source: 'image', projectContext: groupProject }, 'message classified');
      return applyProjectBias({ category: CATEGORY.PLANNING, source: 'image', forceClaude: false, reason: 'image input — EVO VL model preferred', needsPlan: false, planReason: null, confidence: null });
    }

    // Layer 1: 4B classifier
    const classResult = await this._breakerCall(() => this._evo4BClassify(text), null);
    if (classResult && VALID_CATEGORIES.has(classResult.category)) {
      const writeIntent = this._detectsWriteIntent(text);
      const forceClaude = CLAUDE_CATEGORIES.has(classResult.category) || WRITE_LIKELY_CATEGORIES.has(classResult.category) || writeIntent || classResult.needsPlan;
      logger.info({ category: classResult.category, source: '4b_classifier', forceClaude, needsPlan: classResult.needsPlan, confidence: classResult.confidence, projectContext: groupProject }, 'message classified');
      return applyProjectBias({ category: classResult.category, source: '4b_classifier', forceClaude, reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null), needsPlan: classResult.needsPlan || false, planReason: classResult.planReason || null, confidence: classResult.confidence || null });
    }

    // Layer 2: keyword heuristics
    const keywordResult = this.classifyByKeywords(text);
    if (keywordResult) {
      const writeIntent = this._detectsWriteIntent(text);
      const forceClaude = CLAUDE_CATEGORIES.has(keywordResult) || WRITE_LIKELY_CATEGORIES.has(keywordResult) || writeIntent;
      logger.info({ category: keywordResult, source: 'keywords_fallback', forceClaude, writeIntent, projectContext: groupProject }, 'message classified');
      return applyProjectBias({ category: keywordResult, source: 'keywords_fallback', forceClaude, reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null), needsPlan: false, planReason: null, confidence: null });
    }

    // Layer 3: 0.6B LLM classifier
    const llmResult = await this.classifyByLLM(text);
    if (llmResult) {
      const writeIntent = this._detectsWriteIntent(text);
      const forceClaude = CLAUDE_CATEGORIES.has(llmResult) || WRITE_LIKELY_CATEGORIES.has(llmResult) || writeIntent;
      return applyProjectBias({ category: llmResult, source: 'llm_classifier', forceClaude, reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null), needsPlan: false, planReason: null, confidence: null });
    }

    // Fallback
    logger.info({ category: CATEGORY.PLANNING, source: 'fallback', isGroup, projectContext: groupProject }, 'message classified');
    return applyProjectBias({ category: CATEGORY.PLANNING, source: 'fallback', forceClaude: true, reason: 'no confident classification', needsPlan: false, planReason: null, confidence: null });
  }
}

// --- Singleton ---
const router = new RouterService({
  evoClassify: classifyViaEvo,
  evo4BClassify: classifyVia4B,
  breakerCall: (fn, fallback) => plannerBreaker.call(fn, fallback),
});

// --- Facade exports (identical API) ---
export { RouterService };
export function getToolsForCategory(category, allTools) {
  const allowed = CATEGORY_TOOLS[category];
  if (allowed === null) return allTools;
  return allTools.filter(t => allowed.has(t.name) || AVAILABLE_READ_TOOLS.has(t.name));
}
export function needsMemories(category) { return MEMORY_CATEGORIES.has(category); }
export function mustUseClaude(category) { return CLAUDE_CATEGORIES.has(category); }
export const classifyMessage = (text, hasImage, isGroup, groupProject = null) => router.classify(text, hasImage, isGroup, groupProject);
export const classifyByKeywords = (text) => router.classifyByKeywords(text);
export const classifyByLLM = (text) => router.classifyByLLM(text);
export const reloadLearnedRules = () => router._reloadLearnedRules();
export function detectsWriteIntent(text) { return router._detectsWriteIntent(text); }
export { READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS, KEYWORD_RULES, CLAUDE_CATEGORIES, WRITE_LIKELY_CATEGORIES };
