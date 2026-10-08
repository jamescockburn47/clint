import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import { getSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { executeTool } from './tools/handler.js';
import { getToolsForCategory, mustUseClaude, CATEGORY } from './router.js';
import { analyseImage } from './memory.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRouting } from './router-telemetry.js';
import { logReasoningTrace } from './reasoning-trace.js';
import { PLANNING } from './constants.js';
import { gatherIntelligence } from './cortex.js';
import { buildProjectScopePrompt } from './project-access.js';
import { filterToolsForChat } from './group-tool-policy.js';
import { trackTokens, checkDailyLimit, incrementDailyCalls, getDailyCalls, recordCallInUsage, getUsageStats, flushUsage } from './usage-tracker.js';
import { shouldCritique, runCritique } from './quality-gate.js';
import logger from './logger.js';

export { getUsageStats, flushUsage };

const CLAUDE_REQUEST_PATTERNS = /\b(?:ask claude|use claude|use opus|ask opus|claude only|opus only)\b/i;
const OWNER_ONLY_TOOLS = new Set(['gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send', 'soul_propose', 'soul_confirm', 'soul_learn', 'soul_forget', 'calendar_create_event', 'calendar_update_event', 'evolution_task']);
// The only tools a public-venue speaker (the Spire floor) may reach: public-web
// lookups. Everything else — memory_search, soul_read, todos, projects, sovren —
// can surface owner-private material, so it is withheld from venue interactions.
const SPIRE_SAFE_TOOLS = new Set(['web_search', 'web_fetch']);
const GROUP_MODE_TOOLS = TOOL_DEFINITIONS.filter(t => ['memory_search', 'web_search', 'web_fetch'].includes(t.name));
const MAX_TOOL_RESULT = 1500;
const MAX_TOOL_LOOPS = 5;

// --- LLMService class ---

class LLMService {
  /** @param {{ anthropicApiKey: string, claudeModel: string, minimaxApiKey?: string, minimaxBaseUrl?: string, minimaxModel?: string }} opts */
  constructor(opts) {
    this._claudeClient = new Anthropic({ apiKey: opts.anthropicApiKey });
    this._minimaxClient = opts.minimaxApiKey
      ? new Anthropic({ apiKey: opts.minimaxApiKey, baseURL: opts.minimaxBaseUrl })
      : null;
    this._defaultClient = this._minimaxClient || this._claudeClient;
    this._defaultModel = this._minimaxClient ? opts.minimaxModel : opts.claudeModel;
    this._claudeModel = opts.claudeModel;
    this._claudeBreaker = new CircuitBreaker('claude', { threshold: 3, resetTimeout: 30000 });
    this._minimaxBreaker = new CircuitBreaker('minimax', { threshold: 3, resetTimeout: 30000 });
    this._lastToolsCalled = [];
  }

  getLastToolsCalled() { return this._lastToolsCalled; }

  _getAvailableTools(isOwner = true, chatJid = null) {
    const hasGoogle = config.googleClientId && config.googleRefreshToken;
    const hasDarwin = !!config.darwinToken;
    const hasAmadeus = config.amadeusClientId && config.amadeusClientSecret;
    const filtered = TOOL_DEFINITIONS.filter(t => {
      if (!isOwner && OWNER_ONLY_TOOLS.has(t.name)) return false;
      if (t.name.startsWith('calendar_') || t.name.startsWith('gmail_')) return hasGoogle;
      if (t.name === 'train_departures') return hasDarwin;
      if (t.name === 'hotel_search') return hasAmadeus;
      return true;
    });
    return filterToolsForChat(chatJid, filtered);
  }

  _selectClient(userWantsClaude) {
    const activeClient = userWantsClaude ? this._claudeClient : this._defaultClient;
    const activeModel = userWantsClaude ? this._claudeModel : this._defaultModel;
    const breaker = userWantsClaude ? this._claudeBreaker : (this._minimaxClient ? this._minimaxBreaker : this._claudeBreaker);
    return { activeClient, activeModel, breaker };
  }

  /** Run the tool use loop, returning final response */
  async _toolLoop(activeClient, activeModel, breaker, system, messages, cachedTools, isGroup, mode, senderJid, chatJid) {
    let loopClient = activeClient;
    let loopModel = activeModel;
    let loopBreaker = breaker;
    let provider = loopClient === this._claudeClient ? 'claude' : 'minimax';
    let usedFallback = false;

    let response = await loopBreaker.call(
      () => activeClient.messages.create({
        model: activeModel,
        max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
        system, messages,
        ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      }),
      null,
    );

    // Fallback: MiniMax failed → Claude
    if (!response && activeClient !== this._claudeClient && this._minimaxClient) {
      logger.warn('MiniMax unavailable, falling back to Claude');
      loopClient = this._claudeClient;
      loopModel = this._claudeModel;
      loopBreaker = this._claudeBreaker;
      provider = 'claude';
      usedFallback = true;
      response = await this._claudeBreaker.call(
        () => this._claudeClient.messages.create({
          model: this._claudeModel,
          max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
          system, messages,
          ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        }),
        null,
      );
    }

    if (!response) return null;
    trackTokens(response);

    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
      loopCount++;
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        logger.info({ tool: toolUse.name, input: toolUse.input }, 'tool call');
        this._lastToolsCalled.push(toolUse.name);
        let result = await executeTool(toolUse.name, toolUse.input, senderJid, chatJid);
        logger.info({ tool: toolUse.name, chars: result.length }, 'tool result');
        if (result.length > MAX_TOOL_RESULT) result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });

      response = await loopBreaker.call(
        () => loopClient.messages.create({
          model: loopModel,
          max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
          system, messages,
          ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        }),
        null,
      );
      if (!response) break;
      trackTokens(response);
      logger.info({ loop: loopCount, input: response.usage?.input_tokens, output: response.usage?.output_tokens }, 'tool loop');
    }

    return { response, provider, modelName: loopModel, usedFallback };
  }

  /** Main entry point — handles routing, cortex, tools, quality gate */
  async getResponse(context, mode, senderJid, imageData = null, chatJid = null, options = {}) {
    this._lastToolsCalled = [];

    if (!checkDailyLimit()) {
      logger.warn({ limit: config.dailyCallLimit }, 'daily limit reached');
      return { text: null, meta: null };
    }

    const ownerJids = new Set();
    if (config.ownerJid) ownerJids.add(config.ownerJid);
    if (config.ownerLid) ownerJids.add(config.ownerLid);
    // forceRestricted (set by non-owner channels like the Spire floor) hard-locks
    // to non-owner regardless of senderJid — so a caller can guarantee owner-only
    // tools stay closed even when OWNER_JID is unconfigured (empty ownerJids would
    // otherwise treat every sender as the owner).
    const isOwner = options.forceRestricted ? false : (!senderJid || ownerJids.size === 0 || ownerJids.has(senderJid));
    let tools = this._getAvailableTools(isOwner, chatJid);
    // spireSafe (venue interactions): trim to the public-web allowlist so a
    // passer-by cannot drive private-store reads (memory/soul) via prompt injection.
    if (options.spireSafe) tools = tools.filter((t) => SPIRE_SAFE_TOOLS.has(t.name));

    const routeStart = Date.now();
    const isGroup = chatJid && chatJid.endsWith('@g.us');

    const { route, memoryFragment, timing: cortexTiming } = await gatherIntelligence(
      context, !!imageData, isGroup, { secretaryMode: options.secretaryMode },
    );
    const projectScopeFragment = isGroup ? buildProjectScopePrompt(chatJid, context) : '';

    const { category, source: classifySource, forceClaude, reason: routeReason } = route;
    const userWantsClaude = CLAUDE_REQUEST_PATTERNS.test(context);
    const { activeClient, activeModel, breaker } = this._selectClient(userWantsClaude);

    logger.info({ category, source: classifySource, forceClaude, reason: routeReason, sender: senderJid, model: activeModel, explicitClaude: userWantsClaude }, 'routed');

    const categoryTools = getToolsForCategory(category, tools);

    // Task planner
    if (route.needsPlan && (route.confidence || 0) >= PLANNING.MIN_CONFIDENCE) {
      try {
        const { executePlan } = await import('./task-planner.js');
        const planResult = await executePlan(context, route, senderJid, chatJid, memoryFragment);
        if (planResult) {
          logReasoningTrace({
            chatId: chatJid, sender: senderJid, engagement: null,
            routing: { category, layer: classifySource, needsPlan: true, planReason: route.planReason, forceClaude, writeIntent: !!routeReason?.includes('write'), confidence: route.confidence, timeMs: cortexTiming.totalMs, classifyMs: cortexTiming.phase1Ms },
            model: { selected: 'evo-30b', reason: 'needsPlan', qualityGate: false },
            plan: planResult.plan, toolsCalled: planResult.plan.steps.map(s => s.tool), totalTimeMs: Date.now() - routeStart,
          });
          return {
            text: planResult.response,
            meta: {
              category,
              classifySource,
              routeReason,
              routeForceClaude: forceClaude,
              provider: 'planner',
              providerReason: 'needs_plan',
              modelName: 'evo-30b',
            },
          };
        }
        logger.warn('task planner failed, falling back to single-shot');
      } catch (err) {
        logger.error({ err: err.message }, 'task planner error');
      }
    }

    try {
      const dailyCalls = incrementDailyCalls();
      const claudeTools = mustUseClaude(category) ? categoryTools : tools;
      const cachedTools = claudeTools.map((t, i) =>
        i === claudeTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      );

      const system = [{
        type: 'text',
        text: getSystemPrompt(mode, isOwner, isGroup, category, chatJid)
          + projectScopeFragment
          + memoryFragment,
        cache_control: { type: 'ephemeral' },
      }];
      const userContent = [];
      if (imageData) { userContent.push(imageData); logger.info('image sent to Claude vision'); }
      userContent.push({ type: 'text', text: context });
      const messages = [{ role: 'user', content: userContent }];

      const toolLoopResult = await this._toolLoop(activeClient, activeModel, breaker, system, messages, cachedTools, isGroup, mode, senderJid, chatJid);

      if (!toolLoopResult) {
        return {
          text: 'API is temporarily unavailable. Try again shortly.',
          meta: {
            category,
            classifySource,
            routeReason,
            routeForceClaude: forceClaude,
            provider: 'unavailable',
            providerReason: 'api_unavailable',
            modelName: activeModel,
          },
        };
      }
      const { response, provider, modelName, usedFallback } = toolLoopResult;

      recordCallInUsage();
      const cacheInfo = response.usage?.cache_read_input_tokens ? ` (cache: ${response.usage.cache_read_input_tokens})` : '';
      logger.info({ input: response.usage?.input_tokens, output: response.usage?.output_tokens, calls: `${dailyCalls}/${config.dailyCallLimit}`, hasImage: !!imageData }, `claude response${cacheInfo}`);

      const textBlocks = response.content.filter(b => b.type === 'text');
      let text = textBlocks.map(b => b.text).join('\n');
      if (!text) {
        return {
          text: null,
          meta: {
            category,
            classifySource,
            routeReason,
            routeForceClaude: forceClaude,
            provider,
            providerReason: usedFallback ? 'minimax_fallback' : (userWantsClaude ? 'explicit_request' : 'default_cloud_model'),
            modelName,
          },
        };
      }

      const critiqueApplied = shouldCritique(category, text, userWantsClaude);
      if (critiqueApplied) {
        text = await runCritique(text, category, trackTokens);
      }

      const providerReason = userWantsClaude
        ? 'explicit_request'
        : (usedFallback ? 'minimax_fallback' : (provider === 'minimax' ? 'default_cloud_model' : 'default_claude_model'));
      logRouting({
        category,
        confidence: route.confidence || null,
        model: provider,
        latencyMs: Date.now() - routeStart,
        classifyMs: cortexTiming.phase1Ms,
        fallback: usedFallback,
        reason: routeReason || classifySource,
        toolsCalled: this._lastToolsCalled,
        text: context,
      });
      logReasoningTrace({
        chatId: chatJid, sender: senderJid, engagement: null,
        routing: { category, layer: classifySource, needsPlan: route.needsPlan || false, planReason: route.planReason || null, forceClaude, writeIntent: !!routeReason?.includes('write'), confidence: route.confidence || null, timeMs: Date.now() - routeStart },
        model: { selected: provider, modelName, reason: providerReason, qualityGate: critiqueApplied, routeForceClaude: forceClaude },
        plan: null, toolsCalled: this._lastToolsCalled, totalTimeMs: Date.now() - routeStart,
      });

      return {
        text,
        meta: {
          category,
          classifySource,
          routeReason,
          routeForceClaude: forceClaude,
          provider,
          providerReason,
          modelName,
        },
      };
    } catch (err) {
      const status = err?.status;
      if (status === 429) {
        logger.error({ status }, 'rate limited');
        return { text: 'Hit the API rate limit. Try again in a moment.', meta: null };
      }
      if (status === 529) {
        logger.error({ status }, 'API overloaded');
        return { text: 'Claude API is overloaded. Try again shortly.', meta: null };
      }
      logger.error({ err: err.message, status }, 'API error');
      return { text: null, meta: null };
    }
  }

  /** Group analysis response — simpler path with limited tools */
  async getGroupModeResponse(systemPrompt, userMessage, useOpus = false, senderJid = null, chatJid = null) {
    const activeClient = useOpus ? this._claudeClient : this._defaultClient;
    const activeModel = useOpus ? this._claudeModel : this._defaultModel;
    const breaker = useOpus ? this._claudeBreaker : (this._minimaxClient ? this._minimaxBreaker : this._claudeBreaker);

    const system = [{ type: 'text', text: systemPrompt }];
    const messages = [{ role: 'user', content: userMessage }];
    const tools = useOpus ? GROUP_MODE_TOOLS : [];

    try {
      let response = await breaker.call(
        () => activeClient.messages.create({ model: activeModel, max_tokens: 4000, system, messages, ...(tools.length > 0 ? { tools } : {}) }),
        null,
      );
      if (!response) return null;
      trackTokens(response);

      let loopCount = 0;
      while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        if (toolUseBlocks.length === 0) break;
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          logger.info({ tool: toolUse.name, mode: 'group_mode' }, 'group-mode tool call');
          let result = await executeTool(toolUse.name, toolUse.input, senderJid, chatJid);
          if (result.length > MAX_TOOL_RESULT) result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
        }
        messages.push({ role: 'user', content: toolResults });
        response = await breaker.call(
          () => activeClient.messages.create({ model: activeModel, max_tokens: 4000, system, messages, ...(tools.length > 0 ? { tools } : {}) }),
          null,
        );
        if (!response) break;
        trackTokens(response);
      }

      const textBlocks = response.content.filter(b => b.type === 'text');
      return textBlocks.map(b => b.text).join('\n') || null;
    } catch (err) {
      logger.error({ err: err.message, model: activeModel }, 'group-mode API error');
      return null;
    }
  }
}

// --- Singleton ---
const llmService = new LLMService({
  anthropicApiKey: config.anthropicApiKey,
  claudeModel: config.claudeModel,
  minimaxApiKey: config.minimaxApiKey,
  minimaxBaseUrl: config.minimaxBaseUrl,
  minimaxModel: config.minimaxModel,
});

// --- Facade exports ---
export { LLMService };
export const getClawdResponseResult = (ctx, mode, sender, img, chat, opts) => llmService.getResponse(ctx, mode, sender, img, chat, opts);
export const getClawdResponse = async (ctx, mode, sender, img, chat, opts) => {
  const result = await llmService.getResponse(ctx, mode, sender, img, chat, opts);
  return result?.text ?? null;
};
export const getGroupModeResponse = (sys, msg, opus, sender, chat) => llmService.getGroupModeResponse(sys, msg, opus, sender, chat);
export const getLastToolsCalled = () => llmService.getLastToolsCalled();
