import { z } from 'zod';

// --- Schema ---
// Validates all config on startup. Fast-fail on bad/missing env vars.
// Note: bot runs on EVO (localhost URLs), Pi is screen + backup.

const boolFromEnv = z.string().optional().transform(v => v !== 'false').pipe(z.boolean());
const intFromEnv = (fallback) => z.string().optional().transform(v => parseInt(v) || fallback).pipe(z.number());
const floatFromEnv = (fallback) => z.string().optional().transform(v => parseFloat(v) || fallback).pipe(z.number());

const ConfigSchema = z.object({
  // Cloud LLM providers. Clint needs AT LEAST ONE of {MINIMAX_API_KEY,
  // ANTHROPIC_API_KEY} to function. MiniMax is the primary provider;
  // Anthropic is an optional explicit-opt-in path. When ANTHROPIC_API_KEY
  // is unset/empty, the Claude client is not constructed, all
  // forceClaude routing gracefully routes to MiniMax, and the
  // MiniMax-failed fallback returns a \"temporarily unavailable\"
  // message instead of cascading to Claude.
  ANTHROPIC_API_KEY: z.string().optional().default(''),

  // Cloud models
  CLAUDE_MODEL: z.string().optional().default('claude-sonnet-4-6'),
  MINIMAX_API_KEY: z.string().optional().default(''),
  MINIMAX_BASE_URL: z.string().optional().default('https://api.minimax.io/anthropic'),
  MINIMAX_MODEL: z.string().optional().default('MiniMax-M3'),
  MINIMAX_ENABLED: boolFromEnv.default('true'),

  // WhatsApp
  WHATSAPP_GROUP_JID: z.string().optional().default(''),
  TRIGGER_PREFIX: z.string().optional().default('/clawd'),
  RANDOM_REPLY_CHANCE: floatFromEnv(0.05).default('0.05'),
  KEYWORD_BOOST_CHANCE: floatFromEnv(0.25).default('0.25'),
  RANDOM_COOLDOWN_SECONDS: intFromEnv(300).default('300'),
  CONTEXT_MESSAGE_COUNT: intFromEnv(30).default('30'),
  MAX_RESPONSE_TOKENS: intFromEnv(1000).default('1000'),
  DAILY_CALL_LIMIT: intFromEnv(100).default('100'),
  AUTH_STATE_PATH: z.string().optional().default('./auth_state'),
  PAIRING_PHONE_NUMBER: z.string().optional().default(''),

  // Moorstead game integration
  MOORSTEAD_ENABLED: z.string().optional().default('true').transform(v => v !== 'false').pipe(z.boolean()),
  MOORSTEAD_JID: z.string().optional().default(''),
  MOORSTEAD_RELAY_URL: z.string().url().optional().default('http://127.0.0.1:8096'),

  // Master off-switch for all proactive/scheduled owner DMs (briefing,
  // daily-activity, todos, meetings, weekly review, trace + LQC alerts).
  // Moorstead reporting and interactive replies are unaffected.
  CLINT_PROACTIVE_ENABLED: z.string().optional().default('true').transform(v => v !== 'false').pipe(z.boolean()),

  // Owner (James)
  OWNER_JID: z.string().optional().default(''),
  OWNER_LID: z.string().optional().default(''),

  // Travel APIs
  DARWIN_TOKEN: z.string().optional().default(''),
  AMADEUS_CLIENT_ID: z.string().optional().default(''),
  AMADEUS_CLIENT_SECRET: z.string().optional().default(''),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REFRESH_TOKEN: z.string().optional().default(''),

  // Web search
  BRAVE_API_KEY: z.string().optional().default(''),
  // Tavily — LLM-native search API (1k free calls/month). Primary provider
  // when set; SearXNG remains the fallback when Tavily is missing, errors,
  // or returns no results.
  TAVILY_API_KEY: z.string().optional().default(''),
  TAVILY_BASE_URL: z.string().url().optional().default('https://api.tavily.com'),
  TAVILY_SEARCH_DEPTH: z.enum(['basic', 'advanced']).optional().default('basic'),

  // Perplexity Sonar (grounded research — Search API + Agent API)
  PERPLEXITY_API_KEY: z.string().optional().default(''),
  PERPLEXITY_ENABLED: boolFromEnv.default('true'),

  // Sovren access
  SOVREN_WEB_URL: z.string().url().optional().default('https://www.sovren.xyz'),
  SOVREN_API_URL: z.string().url().optional().default('https://api.sovren.xyz'),
  SOVREN_DEMO_EMAIL: z.string().optional().default('peter@slaneyadvisors.com'),
  SOVREN_DEMO_PASSWORD: z.string().optional().default('slaney2026'),

  // Dashboard — Pi connects to EVO's HTTP server
  HTTP_PORT: intFromEnv(3000).default('3000'),
  DASHBOARD_TOKEN: z.string().optional().default(''),

  // Model labels for system_status tool
  EVO_MAIN_MODEL_LABEL: z.string().optional().default('qwen3.6-27b-q6_k + qwen3.5-0.8b-draft (llama-server :8080, EVO X2, spec-decode)'),
  EVO_CLASSIFIER_LABEL: z.string().optional().default('qwen3.6-27b-q8_0 (shared with main on :8080 — 0.6B retired 2026-04-23)'),
  EVO_PLANNER_LABEL: z.string().optional().default('qwen3-4b-instruct-2507-q4_k_m (llama-server :8085, restored 2026-04-24 — hot-path classifier)'),

  // Local models via llama.cpp — bot runs on EVO, all localhost
  EVO_LLM_URL: z.string().url().optional().default('http://localhost:8080'),
  // Classifier and planner URLs — 2026-04-24 rebalance:
  //   - 4B planner restored on :8085 for the hot-path classifier call
  //     (classifyVia4B). Qwen3-4B-Instruct at Q4_K_M classifies in
  //     <1 s, vs 6-7 s when classification ran on the 27B. Most
  //     messages still end up on the 27B for the actual response
  //     generation; the 4B only decides "which category, needsPlan?".
  //   - Engagement classifier (classifyViaEvo, rarely invoked post
  //     @mention-only invariant) stays pointed at :8080 — no separate
  //     0.6B process, and the path is cold enough that latency is
  //     irrelevant.
  EVO_CLASSIFIER_URL: z.string().url().optional().default('http://localhost:8080'),
  EVO_PLANNER_URL: z.string().url().optional().default('http://localhost:8085'),
  EVO_TOOL_ENABLED: boolFromEnv.default('true'),
  EVO_EMBED_URL: z.string().url().optional().default('http://localhost:8083'),
  EVO_DOCLING_URL: z.string().url().optional().default('http://localhost:8084'),
  EVO_SEARXNG_URL: z.string().url().optional().default('http://localhost:8888'),

  // Weather
  WEATHER_ENABLED: boolFromEnv.default('true'),
  WEATHER_LOCATIONS: z.string().optional().default('London,York'),

  // Briefing
  BRIEFING_ENABLED: boolFromEnv.default('true'),
  BRIEFING_TIME: z.string().optional().default('07:00'),

  // Daily-activity summary DM (companion to briefing, fires 30 min later
  // by default — backward-looking narrative of yesterday's bot activity)
  DAILY_ACTIVITY_ENABLED: boolFromEnv.default('true'),
  DAILY_ACTIVITY_TIME: z.string().optional().default('07:30'),

  // Group engagement
  GROUP_MUTE_DURATION_MS: intFromEnv(600000).default('600000'),
  ENGAGEMENT_CLASSIFIER_ENABLED: boolFromEnv.default('true'),
  DREAM_MODE_ENABLED: boolFromEnv.default('true'),

  // Memory service (localhost — bot runs on EVO)
  EVO_MEMORY_URL: z.string().url().optional().default('http://localhost:5100'),
  EVO_MEMORY_ENABLED: boolFromEnv.default('true'),

  // EVO SSH access (for evolution executor — Pi reaches EVO via direct ethernet)
  EVO_SSH_HOST: z.string().optional().default('10.0.0.2'),
  EVO_SSH_USER: z.string().optional().default('james'),
  EVO_REPO_PATH: z.string().optional().default('/home/james/clawdbot'),

  // Professional groups (comma-separated JIDs)
  PROFESSIONAL_GROUPS: z.string().optional().default(''),

  // Forge overnight window
  FORGE_HARD_STOP_HOUR: intFromEnv(7).default('7'),

  // Claude Code CLI for forge phases 2-6
  // FORGE_CLAUDE_MODEL: model to use (default: claude-opus-4-6)
  // FORGE_USE_SUBSCRIPTION: unset ANTHROPIC_API_KEY so CLI uses Max/Pro OAuth creds
  //   Set to 'false' only if you want to use API key billing instead.
  FORGE_CLAUDE_MODEL: z.string().optional().default('claude-opus-4-6'),
  FORGE_USE_SUBSCRIPTION: boolFromEnv.default('true'),

  // LQ Council integration — Clint co-runs with bot-council on EVO and
  // talks to it via loopback (skipping Vercel proxy + Tailscale Funnel).
  // Tools are gated to LQC_DEV_GROUP_JID and owner DMs only. Disabled by
  // default so environments without the council don't see the tools.
  LQC_ENABLED: boolFromEnv.default('false'),
  LQC_API_URL: z.string().url().optional().default('http://127.0.0.1:3100'),
  LQC_ADMIN_TOKEN: z.string().optional().default(''),
  LQC_DEV_GROUP_JID: z.string().optional().default(''),
  // Sentry API access (for Phase 4 lqc_recent_errors / webhook). Unused
  // while tools are in their Phase 2 scope but defined here so it's ready.
  LQC_SENTRY_API_TOKEN: z.string().optional().default(''),
  // Regional API base. US tenant: https://sentry.io/api/0. EU (DE) tenant
  // (bot-council's case — DSN host is o...ingest.de.sentry.io): use
  // https://de.sentry.io/api/0. A user auth token scoped to an EU org
  // returns empty lists against the US endpoint.
  LQC_SENTRY_API_URL: z.string().url().optional().default('https://sentry.io/api/0'),
  LQC_SENTRY_ORG: z.string().optional().default(''),
  LQC_SENTRY_PROJECT_BACKEND: z.string().optional().default(''),
  LQC_SENTRY_PROJECT_FRONTEND: z.string().optional().default(''),
  LQC_SENTRY_WEBHOOK_SECRET: z.string().optional().default(''),
  STEADS_WEBHOOK_SECRET: z.string().optional().default(''),
  STEADS_ENABLED: z.string().optional().default('true').transform(v => v !== 'false').pipe(z.boolean()),
  STEADS_JID: z.string().optional().default(''),

  // The Spire (members' 3D venue) — Clint joins as a live orb via the venue's own
  // MCP endpoint, the same URL + bearer-key path any other agent uses. Disabled by
  // default so a plain deploy doesn't try to join. Every venue speaker is treated
  // as a non-owner with a web-only tool allowlist (see src/spire.js).
  SPIRE_ENABLED: boolFromEnv.default('false'),
  SPIRE_MCP_URL: z.string().url().optional().default('https://spire.lquorum.blog/mcp'),
  SPIRE_AGENT_KEY: z.string().optional().default(''),
  SPIRE_NAME: z.string().optional().default('Clint'),
  // Clint-side Sentry (optional): when SENTRY_DSN is set, Clint reports
  // its own errors to Sentry via native-fetch envelope ingest (no SDK
  // dependency). src/sentry.js wires uncaught-exception + unhandled-
  // rejection handlers and scheduler task-failure captureException
  // calls. Distributed-trace headers are injected on outbound
  // bot-council requests so the two services share a trace ID. No-op
  // when DSN unset — every call path has a cheap short-circuit.
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_ENVIRONMENT: z.string().optional().default('production'),
  SENTRY_RELEASE: z.string().optional().default(''),
  // Shared secret for the on-demand knowledge-refresh webhook. A GitHub
  // Action in bot-council repo uses this to trigger Clint's drift check
  // out-of-band when the source changes. HMAC-SHA256 over the body.
  LQCOUNCIL_REFRESH_SECRET: z.string().optional().default(''),
  // Consolidate store mode: 'promoted' writes validated candidates to EVO
  // memory (post-cutover default); 'shadow' writes to shadow-candidates-*
  // for review without touching memory. Flag exists so a regression can
  // be flipped back to shadow without a code change.
  CONSOLIDATE_MODE: z.enum(['shadow', 'promoted']).optional().default('promoted'),

  // Moorstead auto-coder (owner-only, confirm-gated WhatsApp tool).
  // Safe defaults: both booleans off, so the feature is inert until
  // explicitly enabled in the environment.
  //
  // MOORSTEAD_CODE_ENABLED — master on/off for the auto-coder.
  //   false (default): moorstead_code_confirm returns a disabled message
  //   and never execs the runner.
  // MOORSTEAD_CODE_APPLY — whether the EVO-side runner may actually deploy
  //   (vs propose-only). Surfaced here for status display; the runner also
  //   reads its own env. Both must be true for a live deploy.
  // MOORSTEAD_CODE_RUNNER — path/command for the EVO-side runner script.
  //   Runner receives: <jobId> <base64-request>
  // MOORSTEAD_CODE_REPO — absolute path to the game source on EVO.
  //   The runner uses this; exposed here so status tools can report it.
  //
  // Bool idiom: z.string().optional().default('false').transform(v => v === 'true').pipe(z.boolean())
  // This is required because boolFromEnv uses `v !== 'false'` which returns
  // true for an unset var (default 'false' → 'false' !== 'false' → false works,
  // but .default('true') would return true for unset, which is wrong for a
  // feature that must be explicitly opted in). We use the explicit === 'true'
  // transform so the default is unambiguously false.
  MOORSTEAD_CODE_ENABLED: z.string().optional().default('false').transform(v => v === 'true').pipe(z.boolean()),
  MOORSTEAD_CODE_APPLY: z.string().optional().default('false').transform(v => v === 'true').pipe(z.boolean()),
  MOORSTEAD_CODE_RUNNER: z.string().optional().default('bash /home/james/moorstead/autocode/run.sh'),
  MOORSTEAD_CODE_REPO: z.string().optional().default('/home/james/moorstead/game-src'),
});

// --- Parse & validate ---
const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n  FATAL: Invalid configuration:\n${errors}\n`);
  process.exit(1);
}

const env = parsed.data;

// --- Exported config object (same shape as before — zero breaking changes) ---
const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL,

  minimaxApiKey: env.MINIMAX_API_KEY,
  minimaxBaseUrl: env.MINIMAX_BASE_URL,
  minimaxModel: env.MINIMAX_MODEL,
  minimaxEnabled: env.MINIMAX_ENABLED,

  whatsappGroupJid: env.WHATSAPP_GROUP_JID,
  triggerPrefix: env.TRIGGER_PREFIX,
  randomReplyChance: env.RANDOM_REPLY_CHANCE,
  keywordBoostChance: env.KEYWORD_BOOST_CHANCE,
  randomCooldownSeconds: env.RANDOM_COOLDOWN_SECONDS,
  contextMessageCount: env.CONTEXT_MESSAGE_COUNT,
  maxResponseTokens: env.MAX_RESPONSE_TOKENS,
  dailyCallLimit: env.DAILY_CALL_LIMIT,
  authStatePath: env.AUTH_STATE_PATH,
  pairingPhoneNumber: env.PAIRING_PHONE_NUMBER,

  moorsteadEnabled: env.MOORSTEAD_ENABLED,
  clintProactiveEnabled: env.CLINT_PROACTIVE_ENABLED,
  moorsteadJid: env.MOORSTEAD_JID,
  moorsteadRelayUrl: env.MOORSTEAD_RELAY_URL,

  ownerJid: env.OWNER_JID,
  ownerLid: env.OWNER_LID,

  darwinToken: env.DARWIN_TOKEN,
  amadeusClientId: env.AMADEUS_CLIENT_ID,
  amadeusClientSecret: env.AMADEUS_CLIENT_SECRET,

  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,

  braveApiKey: env.BRAVE_API_KEY,

  tavilyApiKey: env.TAVILY_API_KEY,
  tavilyBaseUrl: env.TAVILY_BASE_URL,
  tavilySearchDepth: env.TAVILY_SEARCH_DEPTH,

  perplexityApiKey: env.PERPLEXITY_API_KEY,
  perplexityEnabled: env.PERPLEXITY_ENABLED,

  sovrenWebUrl: env.SOVREN_WEB_URL,
  sovrenApiUrl: env.SOVREN_API_URL,
  sovrenDemoEmail: env.SOVREN_DEMO_EMAIL,
  sovrenDemoPassword: env.SOVREN_DEMO_PASSWORD,

  httpPort: env.HTTP_PORT,
  dashboardToken: env.DASHBOARD_TOKEN,

  evoMainModelLabel: env.EVO_MAIN_MODEL_LABEL,
  evoClassifierLabel: env.EVO_CLASSIFIER_LABEL,
  evoPlannerLabel: env.EVO_PLANNER_LABEL,

  evoLlmUrl: env.EVO_LLM_URL,
  evoClassifierUrl: env.EVO_CLASSIFIER_URL,
  evoPlannerUrl: env.EVO_PLANNER_URL,
  evoToolEnabled: env.EVO_TOOL_ENABLED,
  evoEmbedUrl: env.EVO_EMBED_URL,
  evoDoclingUrl: env.EVO_DOCLING_URL,
  evoSearxngUrl: env.EVO_SEARXNG_URL,

  weatherEnabled: env.WEATHER_ENABLED,
  weatherLocations: env.WEATHER_LOCATIONS.split(',').map(s => s.trim()),

  briefingEnabled: env.BRIEFING_ENABLED,
  briefingTime: env.BRIEFING_TIME,

  dailyActivityEnabled: env.DAILY_ACTIVITY_ENABLED,
  dailyActivityTime: env.DAILY_ACTIVITY_TIME,

  groupMuteDurationMs: env.GROUP_MUTE_DURATION_MS,
  engagementClassifierEnabled: env.ENGAGEMENT_CLASSIFIER_ENABLED,
  dreamModeEnabled: env.DREAM_MODE_ENABLED,

  evoMemoryUrl: env.EVO_MEMORY_URL,
  evoMemoryEnabled: env.EVO_MEMORY_ENABLED,

  evoSshHost: env.EVO_SSH_HOST,
  evoSshUser: env.EVO_SSH_USER,
  evoRepoPath: env.EVO_REPO_PATH,

  professionalGroups: env.PROFESSIONAL_GROUPS.split(',').map(s => s.trim()).filter(Boolean),

  forgeHardStopHour: env.FORGE_HARD_STOP_HOUR,
  forgeClaudeModel: env.FORGE_CLAUDE_MODEL,
  forgeUseSubscription: env.FORGE_USE_SUBSCRIPTION,

  // LQ Council integration
  lqcEnabled: env.LQC_ENABLED,
  lqcApiUrl: env.LQC_API_URL,
  lqcAdminToken: env.LQC_ADMIN_TOKEN,
  lqcDevGroupJid: env.LQC_DEV_GROUP_JID,
  lqcSentryApiToken: env.LQC_SENTRY_API_TOKEN,
  lqcSentryApiUrl: env.LQC_SENTRY_API_URL,
  lqcSentryOrg: env.LQC_SENTRY_ORG,
  lqcSentryProjectBackend: env.LQC_SENTRY_PROJECT_BACKEND,
  lqcSentryProjectFrontend: env.LQC_SENTRY_PROJECT_FRONTEND,
  lqcSentryWebhookSecret: env.LQC_SENTRY_WEBHOOK_SECRET,
  steadsWebhookSecret: env.STEADS_WEBHOOK_SECRET,
  steadsEnabled: env.STEADS_ENABLED,
  steadsJid: env.STEADS_JID,

  // The Spire
  spireEnabled: env.SPIRE_ENABLED,
  spireMcpUrl: env.SPIRE_MCP_URL,
  spireAgentKey: env.SPIRE_AGENT_KEY,
  spireName: env.SPIRE_NAME,
  lqcouncilRefreshSecret: env.LQCOUNCIL_REFRESH_SECRET,
  consolidateMode: env.CONSOLIDATE_MODE,

  // Moorstead auto-coder
  moorsteadCodeEnabled: env.MOORSTEAD_CODE_ENABLED,
  moorsteadCodeApply: env.MOORSTEAD_CODE_APPLY,
  moorsteadCodeRunner: env.MOORSTEAD_CODE_RUNNER,
  moorsteadCodeRepo: env.MOORSTEAD_CODE_REPO,
};

Object.freeze(config);
export default config;
