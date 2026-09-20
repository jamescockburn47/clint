import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import { legacyPlannerAllowed } from './owner-actions.js';
import { createQwenChatClient } from './qwen-chat.js';
import { finishToolAttempt } from './tool-attempt-notice.js';
import { createArchiveAttemptEvidence } from './archive-attempt-evidence.js';
import { getSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { capabilityPrompt } from './runtime-status.js';
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
import { createRequestId } from './request-id.js';
import logger from './logger.js';
import { safeErrorCode } from './error-code.js';
import { boundToolResult } from './tool-result.js';
import { orderedToolReads } from './parallel-reads.js';
import { currentConversation, isGroupConversation } from './conversation-context.js';
import { OWNER_ONLY_TOOLS } from './conversation-tools.js';
import { scopedResponse } from './conversation-response.js';
import { requestMessages } from './request-messages.js';

export { getUsageStats, flushUsage };

const CLAUDE_REQUEST_PATTERNS = /\b(?:ask claude|use claude|use opus|ask opus|claude only|opus only)\b/i;
const GROUP_MODE_TOOLS = TOOL_DEFINITIONS.filter(t => ['memory_search', 'web_search', 'web_fetch'].includes(t.name));
// The only tools a public-venue speaker (the Spire floor) may reach: public-web
// lookups. Everything else — memory_search, soul_read, todos, projects, sovren —
// can surface owner-private material, so it is withheld from venue interactions.
const SPIRE_SAFE_TOOLS = new Set(['web_search', 'web_fetch']);
const MAX_TOOL_LOOPS = 5;

export function selectToolsForProvider({ provider, category, allTools, categoryTools }) {
  // Category-based filtering benefits every provider, not just Qwen.
  // Pre-2026-05-07 this branch sent ALL ~60 tool schemas (~11K tokens)
  // to MiniMax/Claude unless the category was in mustUseClaude. After
  // flipping default chat to MiniMax (commit e80eba5), every chat was
  // dragging that full schema into the prompt unnecessarily — the
  // classifier picks category at 0.95 confidence and the tools each
  // category actually needs are well-defined. The router's null-allowed
  // sentinel (planning) returns allTools so multi-step reasoning still
  // sees the full set. Keeping the params unused-but-named for backward
  // compat with future provider-specific overrides.
  void provider;
  void allTools;
  void category;
  return categoryTools;
}

export function selectMaxTokensForToolLoop({ defaultMaxTokens }) {
  // With tool_choice:auto this request may produce the complete answer. A 512-token
  // tool-selection cap truncated real Qwen replies in the shared-core EVO probe.
  return defaultMaxTokens;
}

// --- LLMService class ---

class LLMService {
  /**
   * @param {{
   *   anthropicApiKey?: string,
   *   claudeModel?: string,
   *   minimaxApiKey?: string,
   *   minimaxBaseUrl?: string,
   *   minimaxModel?: string,
   *   qwenChatUrl?: string,
   *   qwenChatModel?: string,
   * }} opts
   *
   * Priority model (2026-04-23 Qwen3.6-27B swap):
   *   1. Qwen3.6-27B-Q8_0 local on EVO (config.evoLlmUrl, default :8080) —
   *      default for ALL non-image chat. Handles language and coding.
   *   2. MiniMax-M2.7 — fallback when Qwen is unreachable (llama-server
   *      down, GPU hang, model loading). Also handles images since the
   *      dense 27B has no vision head.
   *   3. Claude — only constructed if ANTHROPIC_API_KEY is set. Kept as
   *      last-resort dead-man's-switch; not reached in normal operation.
   */
  constructor(opts) {
    this._gatherIntelligence = opts.gatherIntelligence || gatherIntelligence;
    this._qwenClient = opts.qwenChatUrl
      ? createQwenChatClient({ baseUrl: opts.qwenChatUrl, defaultModel: opts.qwenChatModel })
      : null;
    this._claudeClient = opts.anthropicApiKey
      ? new Anthropic({ apiKey: opts.anthropicApiKey })
      : null;
    this._minimaxClient = opts.minimaxApiKey
      ? new Anthropic({ apiKey: opts.minimaxApiKey, baseURL: opts.minimaxBaseUrl })
      : null;
    if (!this._qwenClient && !this._claudeClient && !this._minimaxClient) {
      throw new Error(
        'LLMService: at least one of EVO_LLM_URL, MINIMAX_API_KEY, or ANTHROPIC_API_KEY must yield a client',
      );
    }
    // Default = MiniMax (cloud, ~5 s) when configured, else Qwen local
    // (slow but always available), else Claude. Reversed 2026-05-07 after
    // measuring Qwen 27B chat at 30-80 s end-to-end vs ~5 s on MiniMax;
    // Qwen retained for embedding/classifier/dream/memory paths that
    // bypass this client. (See diagnostic 2026-05-06 P1 set.)
    this._defaultClient = this._minimaxClient || this._qwenClient || this._claudeClient;
    this._defaultModel = this._minimaxClient
      ? opts.minimaxModel
      : (this._qwenClient ? (opts.qwenChatModel || 'qwen3.6-27b') : opts.claudeModel);
    this._qwenModel = opts.qwenChatModel || 'qwen3.6-27b';
    this._claudeModel = opts.claudeModel;
    this._qwenBreaker = new CircuitBreaker('qwen', { threshold: 3, resetTimeout: 30000 });
    this._claudeBreaker = new CircuitBreaker('claude', { threshold: 3, resetTimeout: 30000 });
    this._minimaxBreaker = new CircuitBreaker('minimax', { threshold: 3, resetTimeout: 30000 });
    this._lastToolsCalled = [];
  }

  /** True when the optional Claude client is configured. */
  _hasClaude() {
    return this._claudeClient !== null;
  }

  /** True when the local Qwen client is configured and ready. */
  _hasQwen() {
    return this._qwenClient !== null;
  }

  /**
   * Resolve the cloud fallback when Qwen is down. Prefer MiniMax over
   * Claude — MiniMax is the configured cloud provider; Claude only
   * exists as a kept-around dead-man's-switch.
   */
  _cloudFallback() {
    if (currentConversation()?.localOnly) return null;
    if (this._minimaxClient) return {
      client: this._minimaxClient,
      model: config.minimaxModel,
      breaker: this._minimaxBreaker,
      name: 'minimax',
    };
    if (this._claudeClient) return {
      client: this._claudeClient,
      model: this._claudeModel,
      breaker: this._claudeBreaker,
      name: 'claude',
    };
    return null;
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

  _selectClient(userWantsClaude, hasImage = false) {
    if (currentConversation()?.localOnly) {
      if (hasImage || !this._qwenClient) throw new Error('local_model_unavailable_for_request');
      return { activeClient: this._qwenClient, activeModel: this._qwenModel,
        breaker: this._qwenBreaker, droppedClaude: userWantsClaude,
        providerHint: 'qwen', reason: 'conversation_local_only' };
    }
    // Image path: dense Qwen3.6-27B has no vision head, always route
    // images to MiniMax (which has vision via its Anthropic-compatible
    // endpoint). Falls back to Claude only if MiniMax is unavailable.
    if (hasImage) {
      if (this._minimaxClient) {
        return {
          activeClient: this._minimaxClient,
          activeModel: config.minimaxModel,
          breaker: this._minimaxBreaker,
          droppedClaude: false,
          providerHint: 'minimax',
          reason: 'image_content',
        };
      }
      if (this._claudeClient) {
        return {
          activeClient: this._claudeClient,
          activeModel: this._claudeModel,
          breaker: this._claudeBreaker,
          droppedClaude: false,
          providerHint: 'claude',
          reason: 'image_content_no_minimax',
        };
      }
      // No vision-capable provider — fall through to text path; caller
      // will get a garbage answer but not a crash.
    }

    // Explicit "ask claude" overrides if Claude is configured.
    const wantsClaudeButUnavailable = userWantsClaude && !this._hasClaude();
    const effectiveClaude = userWantsClaude && this._hasClaude();
    if (effectiveClaude) {
      return {
        activeClient: this._claudeClient,
        activeModel: this._claudeModel,
        breaker: this._claudeBreaker,
        droppedClaude: false,
        providerHint: 'claude',
        reason: 'explicit_request',
      };
    }

    // Default for this remaining provider path: MiniMax when configured.
    if (this._minimaxClient) {
      return {
        activeClient: this._minimaxClient,
        activeModel: config.minimaxModel,
        breaker: this._minimaxBreaker,
        droppedClaude: wantsClaudeButUnavailable,
        providerHint: 'minimax',
        reason: 'minimax_default',
      };
    }

    if (this._qwenClient) {
      return {
        activeClient: this._qwenClient,
        activeModel: this._qwenModel,
        breaker: this._qwenBreaker,
        droppedClaude: wantsClaudeButUnavailable,
        providerHint: 'qwen',
        reason: 'qwen_local_fallback',
      };
    }

    const cloud = this._cloudFallback();
    return {
      activeClient: cloud?.client || null,
      activeModel: cloud?.model || null,
      breaker: cloud?.breaker || this._claudeBreaker,
      droppedClaude: wantsClaudeButUnavailable,
      providerHint: cloud?.name || 'unavailable',
      reason: 'cloud_fallback_no_qwen',
    };
  }

  /**
   * Identify which provider the given client represents — for logging
   * and for the cascade's "which tier am I in" check.
   */
  _providerNameFor(client) {
    if (client === this._qwenClient) return 'qwen';
    if (client === this._claudeClient) return 'claude';
    if (client === this._minimaxClient) return 'minimax';
    return 'unknown';
  }

  /** Run the tool use loop, returning final response */
  async _toolLoop(activeClient, activeModel, breaker, system, messages, cachedTools, isGroup, mode, senderJid, chatJid, requestId, category, inference = {}) {
    const archiveEvidence = createArchiveAttemptEvidence();
    let loopClient = activeClient;
    let loopModel = activeModel;
    let loopBreaker = breaker;
    let provider = this._providerNameFor(loopClient);
    let usedFallback = false;
    const hasTools = cachedTools.length > 0;
    const callOpts = (isFirstRequest = false) => {
      const defaultMaxTokens = (isGroup && mode === 'random')
        ? config.maxResponseTokens
        : config.maxResponseTokens * 4;
      return {
        model: loopModel,
        max_tokens: selectMaxTokensForToolLoop({
          provider,
          isFirstRequest,
          hasTools,
          defaultMaxTokens: provider === 'qwen' ? (inference.maxTokens ?? defaultMaxTokens) : defaultMaxTokens,
        }),
        requestId,
        ...(provider === 'qwen' && ['conversational', 'recall', 'email', 'system'].includes(category) ? { enableThinking: false } : {}),
        ...(provider === 'qwen' && typeof inference.enableThinking === 'boolean' ? { enableThinking: inference.enableThinking } : {}),
        system,
        messages,
        ...(hasTools ? { tools: cachedTools } : {}),
      };
    };

    let response = await loopBreaker.call(
      () => loopClient.messages.create(callOpts(true)),
      null,
    );

    // Fallback cascade Qwen → MiniMax → Claude:
    //   - When we started on Qwen and it failed, try MiniMax next.
    //   - When we were on MiniMax (directly or via the Qwen fallback) and it failed, try Claude.
    //   - When the active client is already Claude, no further fallback.
    if (!response && !currentConversation()?.localOnly && loopClient === this._qwenClient && this._minimaxClient) {
      logger.warn('Qwen local unreachable, falling back to MiniMax');
      loopClient = this._minimaxClient;
      loopModel = config.minimaxModel;
      loopBreaker = this._minimaxBreaker;
      provider = 'minimax';
      usedFallback = true;
      response = await loopBreaker.call(
        () => loopClient.messages.create(callOpts(true)),
        null,
      );
    }
    if (!response && !currentConversation()?.localOnly && loopClient === this._minimaxClient && this._claudeClient) {
      logger.warn('MiniMax unavailable, falling back to Claude');
      loopClient = this._claudeClient;
      loopModel = this._claudeModel;
      loopBreaker = this._claudeBreaker;
      provider = 'claude';
      usedFallback = true;
      response = await loopBreaker.call(
        () => loopClient.messages.create(callOpts(true)),
        null,
      );
    }

    if (!response) return null;
    trackTokens(response);

    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
      const toolUseBlocks = Array.isArray(response.content) ? response.content.filter(b => b?.type === 'tool_use') : [];
      if (toolUseBlocks.length === 0) break;
      loopCount++;

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = await orderedToolReads(toolUseBlocks, async toolUse => {
        const offered = cachedTools.some(t => t.name === toolUse.name);
        const toolName = offered ? toolUse.name : 'unrecognized_tool';
        logger.info({ requestId, tool: toolName }, 'tool call');
        this._lastToolsCalled.push(toolName);
        let result = offered
          ? await executeTool(toolUse.name, toolUse.input, senderJid, chatJid)
          : 'Tool denied: it was not offered for this request.';
        logger.info({ requestId, tool: toolName, chars: result.length }, 'tool result');
        result = boundToolResult(toolName, result);
        return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
      });
      toolResults.forEach((result, index) => archiveEvidence?.add(toolUseBlocks[index].name, result.content));
      messages.push({ role: 'user', content: toolResults });

      response = await loopBreaker.call(
        () => loopClient.messages.create(callOpts()),
        null,
      );
      if (!response) break;
      trackTokens(response);
      logger.info({ requestId, loop: loopCount, input: response.usage?.input_tokens, output: response.usage?.output_tokens, provider }, 'tool loop');
    }

    return { response, provider, modelName: loopModel, usedFallback, toolRounds: loopCount,
      archiveEvidence: archiveEvidence?.render() || '' };
  }

  /** Main entry point — handles routing, cortex, tools, quality gate */
  async getResponse(context, mode, senderJid, imageData = null, chatJid = null, options = {}) {
    return scopedResponse({ senderJid, chatJid, options },
      () => this._getResponse(context, mode, senderJid, imageData, chatJid, options));
  }

  async _getResponse(context, mode, senderJid, imageData, chatJid, options) {
    this._lastToolsCalled = [];
    const requestId = options.requestId || createRequestId({ source: 'llm' });

    if (!checkDailyLimit()) {
      logger.warn({ requestId, limit: config.dailyCallLimit }, 'daily limit reached');
      return { text: null, meta: null };
    }

    const isOwner = currentConversation().isOwner;
    let tools = this._getAvailableTools(isOwner, chatJid);
    // spireSafe (venue interactions): trim to the public-web allowlist so a
    // passer-by cannot drive private-store reads (memory/soul) via prompt injection.
    if (options.spireSafe) tools = tools.filter((t) => SPIRE_SAFE_TOOLS.has(t.name));

    // "Merlin" address → Moorstead-only warden mode (owner only). When James
    // opens a message with "Merlin", scope this reply strictly to the game:
    // only moorstead_* tools, a warden directive, and skip the planner.
    const _firstWord = (typeof context === 'string' ? context : '')
      .trim().toLowerCase().split(/[\s,:\-!?.]+/)[0];
    const merlinMode = isOwner && _firstWord === 'merlin';

    const routeStart = Date.now();
    const isGroup = isGroupConversation(chatJid);

    const { route, memoryFragment, timing: cortexTiming } = await this._gatherIntelligence(
      context, !!imageData, isGroup, { secretaryMode: options.secretaryMode, chatJid },
    );
    const projectScopeFragment = isGroup ? buildProjectScopePrompt(chatJid, context) : '';

    const { category, source: classifySource, forceClaude, reason: routeReason } = route;
    const userWantsClaude = CLAUDE_REQUEST_PATTERNS.test(context);
    const { activeClient, activeModel, breaker, droppedClaude, providerHint } = this._selectClient(userWantsClaude, !!imageData);
    if (droppedClaude) {
      logger.info({ requestId, sender: senderJid }, 'user asked for Claude but ANTHROPIC_API_KEY unset — using MiniMax');
    }

    logger.info({ requestId, category, source: classifySource, forceClaude, reason: routeReason, sender: senderJid, model: activeModel, provider: providerHint, hasImage: !!imageData, explicitClaude: userWantsClaude, qwenAvailable: this._hasQwen(), claudeAvailable: this._hasClaude() }, 'routed');

    const categoryTools = merlinMode
      ? tools.filter(t => /^moorstead_/.test(t.name))
      : getToolsForCategory(category, tools);

    // Task planner
    if (!merlinMode && legacyPlannerAllowed(currentConversation()) && route.needsPlan && (route.confidence || 0) >= PLANNING.MIN_CONFIDENCE) {
      try {
        const { executePlan } = await import('./task-planner.js');
        const planResult = await executePlan(context, route, senderJid, chatJid, memoryFragment);
        if (planResult) {
          logReasoningTrace({
            chatId: chatJid, sender: senderJid, engagement: null,
            routing: { category, layer: classifySource, needsPlan: true, planReason: null, forceClaude, writeIntent: !!routeReason?.includes('write'), confidence: route.confidence, timeMs: cortexTiming.totalMs, classifyMs: cortexTiming.phase1Ms },
            model: { selected: 'evo-30b', reason: 'needsPlan', qualityGate: false },
            plan: null, toolsCalled: planResult.plan.steps.map(s => s.tool), totalTimeMs: Date.now() - routeStart,
          });
          return {
            text: shouldCritique(category, planResult.response, false)
              ? await runCritique(planResult.response, category, trackTokens, currentConversation()?.localOnly
                ? { client: this._qwenClient, defaultModel: this._qwenModel, provider: 'qwen' } : undefined)
              : planResult.response,
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
      const selectedTools = selectToolsForProvider({
        provider: providerHint,
        category,
        allTools: tools,
        categoryTools,
      });
      const cachedTools = selectedTools.map((t, i) =>
        i === selectedTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      );

      // Ambient mode (invoked by maybeRunAmbientAgency for non-mention
      // group messages in LQCore-style open groups). The 27B makes the
      // "speak or stay silent" judgment itself — no separate 4B
      // classifier gate. When it has nothing useful to add it outputs
      // the sentinel `SILENT` and the caller discards the response.
      const ambientSuffix = options.ambient
        ? '\n\n## Ambient participation protocol\n'
          + 'You are NOT being directly addressed. You may choose to contribute '
          + 'unprompted only when you have something genuinely useful — a factual '
          + 'correction, a synthesis of a long thread, a specific fact or tool '
          + 'result someone would want, or an issue/constraint the group has not '
          + 'named. Stay silent on pure reactions, agreement, banter, or topics '
          + 'handled adequately by other participants.\n\n'
          + 'If you have nothing substantive to add, your ENTIRE response must '
          + 'be exactly the single word: SILENT\n'
          + 'Otherwise respond normally and the group will see your message.'
        : '';
      const merlinSuffix = merlinMode
        ? '\n\n## MERLIN MODE — Moorstead only\n'
          + 'James addressed you as "Merlin", so for this reply you ARE Merlin, warden of his '
          + 'Moorstead voxel game. Act ONLY as the game warden: use ONLY the moorstead_* tools and '
          + 'speak ONLY about Moorstead — who is online and where, the moor and bairns (children’s) '
          + 'worlds, broadcasts, bairns time limits and locks, service/room ops, and small game changes. '
          + 'Do NOT use web search, email, calendar, or any non-Moorstead tool, and do NOT answer '
          + 'off-topic questions — if asked something unrelated, say you are in Merlin mode and only '
          + 'handle the game. Call the right moorstead_* tool immediately and lead with the result.'
        : '';
      const system = [{
        type: 'text',
        text: getSystemPrompt(mode, isOwner, isGroup, category, chatJid)
          + capabilityPrompt(selectedTools)
          + projectScopeFragment
          + memoryFragment
          + ambientSuffix
          + merlinSuffix,
        cache_control: { type: 'ephemeral' },
      }];
      const userContent = [];
      if (imageData) { userContent.push(imageData); logger.info('image sent to Claude vision'); }
      userContent.push({ type: 'text', text: context });
      const messages = requestMessages(userContent, options.conversationEvidence);

      const toolLoopResult = await this._toolLoop(activeClient, activeModel, breaker, system, messages, cachedTools, isGroup, mode, senderJid, chatJid, requestId, category, options.inference);

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
            requestId,
          },
        };
      }
      const { response, provider, modelName, usedFallback } = toolLoopResult;
      const terminalNotice = finishToolAttempt(toolLoopResult, { category, classifySource, routeReason,
        routeForceClaude: forceClaude, requestId });
      if (terminalNotice) { recordCallInUsage(); return terminalNotice; }
      // A length-truncated answer is still the model's answer: deliver it flagged rather than as silence.
      const truncated = response.stop_reason === 'max_tokens';
      if (response.stop_reason !== 'end_turn' && !truncated) throw new Error(`incomplete_model_response:${response.stop_reason}`);
      if (truncated) logger.warn({ requestId, provider }, 'model response truncated at max_tokens');

      recordCallInUsage();
      const cacheInfo = response.usage?.cache_read_input_tokens ? ` (cache: ${response.usage.cache_read_input_tokens})` : '';
      logger.info({ requestId, input: response.usage?.input_tokens, output: response.usage?.output_tokens, calls: `${dailyCalls}/${config.dailyCallLimit}`, hasImage: !!imageData }, `claude response${cacheInfo}`);

      const textBlocks = response.content.filter(b => b.type === 'text');
      let text = textBlocks.map(b => b.text).join('\n');

      // Ambient-mode SILENT sentinel: 27B opted not to contribute. Treat
      // as "no response" for the caller (maybeRunAmbientAgency logs it as
      // a deliberate silence, not an error). Accept any variant in case
      // the model wraps it ("SILENT.", "SILENT\n", " SILENT ").
      if (options.ambient && text && /^\s*SILENT\.?\s*$/.test(text)) {
        return {
          text: null,
          meta: {
            category,
            classifySource,
            routeReason,
            routeForceClaude: forceClaude,
            provider,
            providerReason: 'ambient_silent',
            modelName,
            requestId,
          },
        };
      }

      if (!text) {
        return {
          text: null,
          meta: {
            category,
            classifySource,
            routeReason,
            routeForceClaude: forceClaude,
            provider,
            providerReason: usedFallback
              ? `${provider}_fallback`
              : (userWantsClaude ? 'explicit_request' : `${provider}_default`),
            modelName,
            requestId,
          },
        };
      }

      const critiqueApplied = shouldCritique(category, text, userWantsClaude);
      if (critiqueApplied) {
        text = await runCritique(text, category, trackTokens, currentConversation()?.localOnly
          ? { client: this._qwenClient, defaultModel: this._qwenModel, provider: 'qwen' } : undefined);
      }

      // Provider-reason derives from how we ended up on `provider` given
      // the original routing intent (`providerHint`). Branches match the
      // Qwen-primary → MiniMax → Claude cascade defined in _selectClient
      // + _toolLoop.
      let providerReason;
      if (userWantsClaude) {
        providerReason = 'explicit_request';
      } else if (!!imageData && provider === 'minimax') {
        providerReason = 'image_to_minimax';
      } else if (usedFallback && provider === 'minimax') {
        providerReason = 'qwen_local_fallback_to_minimax';
      } else if (usedFallback && provider === 'claude') {
        providerReason = 'cascade_fallback_to_claude';
      } else if (provider === 'qwen') {
        providerReason = 'qwen_local_default';
      } else if (provider === 'minimax') {
        providerReason = 'minimax_default';
      } else {
        providerReason = 'claude_default';
      }
      logRouting({
        requestId,
        category,
        confidence: route.confidence || null,
        model: provider,
        latencyMs: Date.now() - routeStart,
        classifyMs: cortexTiming.phase1Ms,
        fallback: usedFallback,
        reason: routeReason || classifySource,
        toolsCalled: this._lastToolsCalled,
        text: null,
      });
      logReasoningTrace({
        requestId,
        chatId: chatJid, sender: senderJid, engagement: null,
        routing: { category, layer: classifySource, needsPlan: route.needsPlan || false, planReason: null, forceClaude, writeIntent: !!routeReason?.includes('write'), confidence: route.confidence || null, timeMs: cortexTiming.totalMs, classifyMs: cortexTiming.phase1Ms },
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
          requestId,
          truncated,
        },
      };
    } catch (err) {
      const status = err?.status;
      if (status === 429) {
        logger.error({ requestId, status }, 'rate limited');
        return { text: 'Hit the API rate limit. Try again in a moment.', meta: null };
      }
      if (status === 529) {
        logger.error({ requestId, status }, 'API overloaded');
        return { text: 'Claude API is overloaded. Try again shortly.', meta: null };
      }
      // Error class only: prompts and model output never reach the log line.
      logger.error({ requestId, status, err: safeErrorCode(err) }, 'API error');
      return { text: null, meta: null };
    }
  }

  /** Group analysis response — simpler path with limited tools */
  async getGroupModeResponse(systemPrompt, userMessage, useOpus = false, senderJid = null, chatJid = null) {
    const result = await scopedResponse({ senderJid, chatJid, options: {} }, async () => ({
      text: await this._getGroupModeResponse(systemPrompt, userMessage, useOpus, senderJid, chatJid) }));
    return result?.text ?? null;
  }

  async _getGroupModeResponse(systemPrompt, userMessage, useOpus, senderJid, chatJid) {
    const activeClient = useOpus ? this._claudeClient : this._defaultClient;
    const activeModel = useOpus ? this._claudeModel : this._defaultModel;
    const breaker = useOpus ? this._claudeBreaker : (this._minimaxClient ? this._minimaxBreaker : this._claudeBreaker);

    const system = [{ type: 'text', text: systemPrompt }];
    const messages = [{ role: 'user', content: userMessage }];
    const tools = useOpus ? filterToolsForChat(chatJid, GROUP_MODE_TOOLS) : [];

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
          logger.info({ tool: tools.some(t => t.name === toolUse.name) ? toolUse.name : 'unrecognized_tool', mode: 'group_mode' }, 'group-mode tool call');
          let result = tools.some(t => t.name === toolUse.name)
            ? await executeTool(toolUse.name, toolUse.input, senderJid, chatJid)
            : 'Tool denied: it was not offered for this request.';
          result = boundToolResult(toolUse.name, result);
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
  // Qwen3.6-27B local on EVO :8080 — the configured PRIMARY chat path
  // as of 2026-04-23. When EVO_LLM_URL is reachable this is the default
  // for every non-image chat. Images route to MiniMax because the dense
  // 27B has no vision head.
  qwenChatUrl: config.evoLlmUrl,
  qwenChatModel: config.evoChatModel,
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
