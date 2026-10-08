// System knowledge — seeds architecture and operational knowledge into EVO memory service
// Enables local-first answering of "how does X work?" and "what changed?" queries
// Auto-refreshes nightly at 2 AM to keep self-knowledge current
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { storeMemory, searchMemory, isEvoOnline, deleteMemory, listMemories, syncCache } from './memory.js';
import { describeCapabilities, getForgeHistory } from './skill-registry.js';
import config from './config.js';
import logger from './logger.js';
import { runtimePath } from './overnight/paths.js';

const KNOWLEDGE_SOURCE = 'system_knowledge';
const KNOWLEDGE_CATEGORY = 'system';
const KNOWLEDGE_DIR = join('data', 'system-knowledge');
const KNOWLEDGE_FILE_LEGACY = join('data', 'system-knowledge.json');

export function toStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : [];
}

export function formatObjectEntries(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key}: ${value}`)
    .join('. ');
}

// Load the structured knowledge document from modular sub-files
// Falls back to legacy monolithic file if directory doesn't exist
function loadKnowledgeDoc() {
  try {
    if (existsSync(KNOWLEDGE_DIR)) {
      const files = readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.json'));
      if (files.length === 0) return null;
      const merged = {};
      for (const file of files) {
        const content = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, file), 'utf-8'));
        Object.assign(merged, content);
      }
      return merged;
    }
    // Legacy fallback — single monolithic file
    if (!existsSync(KNOWLEDGE_FILE_LEGACY)) return null;
    return JSON.parse(readFileSync(KNOWLEDGE_FILE_LEGACY, 'utf-8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load system knowledge');
    return null;
  }
}

// Generate memory entries from the structured knowledge document
function generateKnowledgeEntries() {
  const doc = loadKnowledgeDoc();
  if (!doc) return generateFallbackEntries();

  const entries = [];

  // Identity
  entries.push({
    fact: `I am ${doc.identity.name} (${doc.identity.fullName}), ${doc.identity.role} for ${doc.identity.owner} (${doc.identity.ownerRole}). ${doc.identity.personality}`,
    tags: ['identity', 'personality', 'overview'],
  });

  // Architecture overview
  entries.push({
    fact: doc.architecture.summary,
    tags: ['architecture', 'overview', 'hybrid'],
  });

  // Each device
  for (const device of Array.isArray(doc.architecture?.devices) ? doc.architecture.devices : []) {
    const hw = device.hardware ? ` Hardware: ${device.hardware}.` : '';
    const role = device.role || device.framework || 'supporting component';
    const runs = device.runs || device.layout || device.connectivity || 'see architecture summary';
    entries.push({
      fact: `${device.name} (${device.ip || device.location}) — ${role}. Runs: ${runs}.${hw}`,
      tags: ['architecture', 'device', device.name.toLowerCase().replace(/\s+/g, '_')],
    });
  }

  // Message flow
  entries.push({
    fact: doc.messageFlow.summary,
    tags: ['routing', 'pipeline', 'messages'],
  });

  // Router layers
  const router = doc.messageFlow?.router || {};
  const routerFacts = [router.layer1, router.layer2, router.layer3, router.layer4]
    .filter(Boolean).join(' ');
  entries.push({
    fact: `Router: ${routerFacts}${router.writeDetection ? ' ' + router.writeDetection : ''}${router.learnedRules ? ' ' + router.learnedRules : ''}`,
    tags: ['router', 'classifier', 'keywords', 'llm'],
  });

  // Model selection
  const models = doc.messageFlow?.modelSelection || {};
  const modelFacts = Object.values(models).filter(Boolean).join(' ');
  entries.push({
    fact: `Model routing: ${modelFacts}`,
    tags: ['models', 'routing', 'minimax', 'claude'],
  });

  // Tools (grouped)
  const toolLines = Object.entries(doc.tools || {})
    .map(([cat, tools]) => `${cat}: ${toStringArray(tools).join(', ')}`)
    .filter((line) => !line.endsWith(': '))
    .join('. ');
  if (toolLines) {
    entries.push({
      fact: `Tool inventory: ${toolLines}`,
      tags: ['tools', 'capabilities'],
    });
  }

  // Scheduler
  if (doc.scheduler?.interval || toStringArray(doc.scheduler?.tasks).length > 0) {
    entries.push({
      fact: `Scheduler (${doc.scheduler?.interval || 'unknown'} interval): ${toStringArray(doc.scheduler?.tasks).join('. ')}.`,
      tags: ['scheduler', 'automation', 'reminders', 'briefing'],
    });
  }

  // Voice pipeline
  entries.push({
    fact: doc.voicePipeline.summary,
    tags: ['voice', 'pipeline', 'whisper', 'tts'],
  });

  if (toStringArray(doc.voicePipeline?.features).length > 0 || doc.voicePipeline?.config) {
    entries.push({
      fact: `Voice features: ${toStringArray(doc.voicePipeline?.features).join('. ')}. Config: ${doc.voicePipeline?.config || 'unknown'}.`,
      tags: ['voice', 'features', 'wake', 'contacts'],
    });
  }

  // Soul system
  entries.push({
    fact: doc.soulSystem.summary,
    tags: ['soul', 'personality', 'guardrails'],
  });

  // Memory system
  entries.push({
    fact: doc.memorySystem.summary,
    tags: ['memory', 'evo', 'vector', 'search', 'bm25', 'rrf'],
  });

  // Cortex — parallel intelligence layer
  if (doc.cortex) {
    entries.push({
      fact: doc.cortex.summary,
      tags: ['cortex', 'parallel', 'intelligence', 'fan-out', 'pipeline'],
    });
  }

  // Web search with speculative prefetch
  if (doc.webSearch?.speculativePrefetch) {
    entries.push({
      fact: doc.webSearch.speculativePrefetch,
      tags: ['web', 'search', 'prefetch', 'cortex', 'cache'],
    });
  }

  // Henry weekends
  entries.push({
    fact: doc.henryWeekends.summary,
    tags: ['henry', 'weekends', 'york', 'travel'],
  });

  // Guardrails
  if (toStringArray(doc.guardrails).length > 0) {
    entries.push({
      fact: `Critical guardrails: ${toStringArray(doc.guardrails).join(' ')}`,
      tags: ['guardrails', 'safety', 'restrictions'],
    });
  }

  // Users
  for (const [name, desc] of Object.entries(doc.users || {})) {
    entries.push({
      fact: `User ${name}: ${desc}`,
      tags: ['users', 'access', name],
    });
  }

  // Self-improvement
  entries.push({
    fact: doc.selfImprovement.summary,
    tags: ['self-improvement', 'eval', 'learning'],
  });

  // Dynamic: forge-authored learned skills
  const forgeHistory = getForgeHistory();
  if (forgeHistory.length > 0) {
    const skillList = forgeHistory.map(s =>
      `${s.name} (v${s.version || '?'}${s.created ? ', created ' + s.created : ''}): ${s.description || 'no description'}`
    ).join('. ');
    entries.push({
      fact: `Learned skills from overnight forge: ${skillList}`,
      tags: ['skills', 'forge', 'learned', 'capabilities'],
    });
  }
  const skillDesc = describeCapabilities();
  if (skillDesc !== 'No forge-authored skills installed.') {
    entries.push({
      fact: skillDesc,
      tags: ['skills', 'capabilities', 'forge'],
    });
  }

  // Tech stack
  const stackLines = formatObjectEntries(doc.techStack);
  if (stackLines) {
    entries.push({
      fact: `Tech stack: ${stackLines}`,
      tags: ['tech', 'stack', 'dependencies'],
    });
  }

  // Circuit breakers
  const cbLines = formatObjectEntries(doc.circuitBreakers);
  if (cbLines) {
    entries.push({
      fact: `Circuit breakers: ${cbLines}`,
      tags: ['circuit-breaker', 'resilience', 'failover'],
    });
  }

  // Version + changelog
  try {
    const versionPath = join(process.cwd(), 'version.json');
    if (existsSync(versionPath)) {
      const { version, notes } = JSON.parse(readFileSync(versionPath, 'utf-8'));
      if (notes && notes.length > 0) {
        entries.push({
          fact: `Current version: v${version}. Recent changes: ${notes.join('. ')}.`,
          tags: ['version', 'changelog', 'updates'],
        });
      }
    }
  } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }

  // Data persistence
  if (doc.dataPersistence?.summary) {
    entries.push({
      fact: doc.dataPersistence.summary,
      tags: ['data', 'persistence', 'json', 'storage'],
    });
  }

  // Subsystem entries — any field with a .summary that isn't already handled above
  const handledKeys = new Set([
    'identity', 'architecture', 'messageFlow', 'tools', 'scheduler',
    'voicePipeline', 'soulSystem', 'memorySystem', 'henryWeekends',
    'guardrails', 'users', 'selfImprovement', 'techStack',
    'circuitBreakers', 'dataPersistence', 'lquorum', 'version', 'lastUpdated',
  ]);

  // Tag enrichment — ensures security/specialist entries get discoverable tags
  const TAG_ENRICHMENT = {
    canaryToken: ['canary', 'security', 'prompt-leak', 'detection', 'output-filter'],
    antiInjection: ['anti-injection', 'security', 'prompt-hardening', 'identity-lock', 'role-play'],
    defenseInDepth: ['defense-in-depth', 'security', 'output-filter', 'canary', 'regex'],
    theForge: ['forge', 'overnight', 'coding', 'skills', 'autonomous', 'self-improvement'],
    engagementClassifier: ['engagement', 'classifier', 'groups', 'mention-only'],
    cortex: ['cortex', 'parallel', 'intelligence', 'fan-out', 'pipeline'],
    agenticTaskPlanner: ['planner', 'agentic', 'multi-step', 'goal-reasoning'],
    agiRoadmap: ['agi', 'roadmap', 'phases', 'experiment'],
  };

  for (const [key, val] of Object.entries(doc)) {
    if (handledKeys.has(key)) continue;
    if (val && typeof val === 'object' && val.summary) {
      const baseTags = TAG_ENRICHMENT[key]
        || [key.replace(/([A-Z])/g, '_$1').toLowerCase(), 'subsystem'];
      entries.push({
        fact: val.summary,
        tags: baseTags,
      });
      // Also add any additional string fields beyond summary
      for (const [subKey, subVal] of Object.entries(val)) {
        if (subKey === 'summary' || typeof subVal !== 'string') continue;
        const subTags = TAG_ENRICHMENT[subKey]
          || [key.replace(/([A-Z])/g, '_$1').toLowerCase(), subKey, 'subsystem'];
        entries.push({
          fact: subVal,
          tags: subTags,
        });
      }
    }
  }

  // LQuorum knowledge — single overview entry
  // Full depth is handled by conversational working memory (src/lquorum-rag.js)
  if (doc.lquorum) {
    entries.push({
      fact: `LQuorum community knowledge covers 18 legal AI topics from 40+ lawyers across 12 jurisdictions. Topics include RAG/hallucinations, document processing, DOCX problems, data security, platform reviews, local models, vibe coding, contract review AI, and more. Full knowledge is available through conversational working memory when these topics are discussed.`,
      tags: ['lquorum', 'legal-ai', 'community', 'knowledge'],
    });
    logger.info('LQuorum overview entry generated (full depth via working memory)');
  }

  return entries;
}

// Fallback entries if system-knowledge.json is missing
function generateFallbackEntries() {
  return [
    {
      fact: 'Clint is a distributed WhatsApp admin assistant centered on the EVO X2. EVO runs the Node.js bot runtime (Baileys, HTTP API, scheduler), local AI services, memory integration, the voice listener, and the default Qwen local chat model. The Raspberry Pi 5 is a Rust touchscreen dashboard and backup screen that connects to the EVO API. MiniMax M2.7 is cloud fallback, with Claude Opus 4.6 only for premium, explicit-request, or last-resort paths.',
      tags: ['architecture', 'overview'],
    },
  ];
}

// Seed system knowledge into EVO memory service
// Uses wipe-and-reseed to prevent stale duplicates accumulating
export async function seedSystemKnowledge() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) {
    logger.info('EVO offline — skipping system knowledge seed');
    return { seeded: 0, skipped: true };
  }

  // Wipe ALL old system knowledge entries (any source, any category that matches)
  let deleted = 0;
  try {
    const allMemories = await listMemories();
    const staleEntries = allMemories.filter(m =>
      m.source === KNOWLEDGE_SOURCE
      || m.source === 'system_knowledge_seed'
      || (m.category === KNOWLEDGE_CATEGORY && m.source !== 'dream_mode' && m.source !== 'conversation')
    );
    for (const entry of staleEntries) {
      try {
        await deleteMemory(entry.id);
        deleted++;
      } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to clean old system knowledge');
  }

  // Re-seed fresh from current system-knowledge.json
  const entries = generateKnowledgeEntries();
  let seeded = 0;

  for (const entry of entries) {
    try {
      await storeMemory(entry.fact, KNOWLEDGE_CATEGORY, entry.tags, 1.0, KNOWLEDGE_SOURCE);
      seeded++;
    } catch (err) {
      logger.warn({ err: err.message, tags: entry.tags }, 'failed to seed system knowledge entry');
    }
  }

  // Force cache sync so Pi immediately has fresh data
  try { await syncCache(); } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }

  logger.info({ deleted, seeded, total: entries.length }, 'system knowledge seeded');
  return { deleted, seeded };
}

// Nightly full refresh — wipes old system knowledge entries and re-seeds from current state
// Called at 2 AM by the scheduler to keep the bot's self-awareness current
export async function refreshSystemKnowledge() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) {
    logger.info('EVO offline — skipping system knowledge refresh');
    return { refreshed: false, reason: 'evo_offline' };
  }

  const startTime = Date.now();

  try {
    // 1. Find and delete all existing system knowledge entries (broad filter — catches all sources)
    const allMemories = await listMemories();
    const systemEntries = allMemories.filter(m =>
      m.source === KNOWLEDGE_SOURCE
      || m.source === 'system_knowledge_seed'
      || (m.category === KNOWLEDGE_CATEGORY && m.source !== 'dream_mode' && m.source !== 'conversation')
    );

    let deleted = 0;
    for (const entry of systemEntries) {
      try {
        await deleteMemory(entry.id);
        deleted++;
      } catch (err) {
        logger.warn({ id: entry.id, err: err.message }, 'failed to delete old system knowledge');
      }
    }

    // 2. Update the knowledge doc timestamp in meta.json (or legacy monolith)
    // Post Phase 0 spec §6.1 P1: meta.json is live-bot-written state.
    try {
      const metaPath = runtimePath('system-knowledge/meta.json');
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        meta.lastUpdated = new Date().toISOString();
        try {
          const vPath = join(process.cwd(), 'version.json');
          if (existsSync(vPath)) {
            const { version } = JSON.parse(readFileSync(vPath, 'utf-8'));
            meta.version = version;
          }
        } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } else if (existsSync(KNOWLEDGE_FILE_LEGACY)) {
        const doc = JSON.parse(readFileSync(KNOWLEDGE_FILE_LEGACY, 'utf-8'));
        doc.lastUpdated = new Date().toISOString();
        try {
          const vPath = join(process.cwd(), 'version.json');
          if (existsSync(vPath)) {
            const { version } = JSON.parse(readFileSync(vPath, 'utf-8'));
            doc.version = version;
          }
        } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }
        writeFileSync(KNOWLEDGE_FILE_LEGACY, JSON.stringify(doc, null, 2));
      }
    } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }

    // 3. Re-seed all entries fresh
    const entries = generateKnowledgeEntries();
    let seeded = 0;

    for (const entry of entries) {
      try {
        await storeMemory(entry.fact, KNOWLEDGE_CATEGORY, entry.tags, 1.0, KNOWLEDGE_SOURCE);
        seeded++;
      } catch (err) {
        logger.warn({ err: err.message, tags: entry.tags }, 'failed to seed refreshed knowledge');
      }
    }

    // Force cache sync so Pi immediately has fresh data
    try { await syncCache(); } catch { /* intentional: non-critical knowledge entry, continue with remaining entries */ }

    const elapsed = Date.now() - startTime;
    logger.info({ deleted, seeded, elapsed }, 'system knowledge refreshed');
    return { refreshed: true, deleted, seeded, elapsed };
  } catch (err) {
    logger.error({ err: err.message }, 'system knowledge refresh failed');
    return { refreshed: false, error: err.message };
  }
}

// Get a live system snapshot for context injection (complements stored knowledge)
export async function getLiveSystemSnapshot() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const waConnected = globalThis._clawdWhatsAppConnected || false;

  let evoStatus = 'unknown';
  try {
    const { checkLlamaHealth } = await import('./evo-client.js');
    evoStatus = await checkLlamaHealth() ? 'online' : 'offline';
  } catch { evoStatus = 'check failed'; }

  const { getRoutingStats } = await import('./router-telemetry.js');
  const routerStats = getRoutingStats();

  return `\n\n## Live System Status (${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })})
- EVO X2 runtime: running ${hours}h ${mins}m, ${(mem.rss / 1048576).toFixed(0)}MB RSS
- WhatsApp: ${waConnected ? 'connected' : 'disconnected'}
- EVO X2 llama-server: ${evoStatus}
- Routing today: ${routerStats.total > 0 ? `${routerStats.local} local, ${routerStats.cloud} cloud, ${routerStats.fallback} fallbacks` : 'no messages yet'}`;
}
