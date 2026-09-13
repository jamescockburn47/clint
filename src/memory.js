/**
 * Memory client — connects to EVO X2 memory service.
 * Handles health monitoring, search, store, queue, cache, and fallback.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { evoFetchJSON, evoFetch as evoFetchRaw } from './evo-client.js';
import { TIMEOUTS } from './constants.js';
import { filterScopedMemories } from './conversation-context.js';

// Re-export logConversation for backward compatibility
export { logConversation } from './conversation-logger.js';

const CACHE_FILE = join('data', 'memory-cache.json');
const QUEUE_DIR = join('data', 'memory-queue');
const QUEUE_TEXT_DIR = join(QUEUE_DIR, 'text');
const QUEUE_AUDIO_DIR = join(QUEUE_DIR, 'audio');
const QUEUE_IMAGE_DIR = join(QUEUE_DIR, 'images');
const DOC_LOG_DIR = join(process.cwd(), 'data', 'document-logs');
const DOC_CACHE_DIR = join(process.cwd(), 'data', 'document-cache');

export function parseQueuedItem(raw) {
  if (!raw || !raw.trim()) return null;
  return JSON.parse(raw);
}

// --- MemoryClient class (owns connection state, cache, queue) ---

class MemoryClient {
  constructor({ memoryUrl, fetchJSON, fetchRaw }) {
    this._memoryUrl = memoryUrl;
    this._fetchJSON = fetchJSON;
    this._fetchRaw = fetchRaw;
    this._online = false;
    this._consecutiveFailures = 0;
    this._cache = [];
    this._cacheTimestamp = 0;
    this._lastHealthData = null;

    // Ensure directories
    for (const dir of [QUEUE_TEXT_DIR, QUEUE_AUDIO_DIR, QUEUE_IMAGE_DIR, DOC_LOG_DIR, DOC_CACHE_DIR]) {
      mkdirSync(dir, { recursive: true });
    }

    // Load cache on construction
    try {
      if (existsSync(CACHE_FILE)) {
        const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        this._cache = data.memories || [];
        this._cacheTimestamp = data.timestamp || 0;
        logger.info({ count: this._cache.length }, 'memory cache loaded');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to load memory cache');
    }
  }

  /** @returns {Promise<unknown>} Fetch parsed JSON from memory service. Validate at each consumer boundary. */
  _fetch(path, options = {}) {
    return this._fetchJSON(`${this._memoryUrl}${path}`, options);
  }

  // --- Health ---

  /** Check if EVO memory service is online, trigger queue drain on recovery */
  async checkHealth({ recover = true } = {}) {
    try {
      const data = await this._fetch('/health', { timeout: TIMEOUTS.MEMORY_HEALTH_CHECK });
      if (data.status === 'online') {
        const wasOffline = !this._online;
        this._online = true;
        this._consecutiveFailures = 0;
        this._lastHealthData = data;
        if (wasOffline && recover) {
          logger.info('EVO X2 came online — draining queue and syncing cache');
          this._drainQueue().catch(err => logger.error({ err: err.message }, 'queue drain failed'));
          this.syncCache().catch(err => logger.error({ err: err.message }, 'cache sync failed'));
        }
        return data;
      }
    } catch (err) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= 3 && this._online) {
        this._online = false;
        logger.warn('EVO X2 marked offline after 3 consecutive failures');
      }
    }
    return null;
  }

  getLastHealthData() { return this._lastHealthData; }
  isOnline() { return this._online; }

  getStatus() {
    return {
      online: this._online,
      consecutiveFailures: this._consecutiveFailures,
      cacheSize: this._cache.length,
      cacheAge: this._cacheTimestamp ? Math.round((Date.now() - this._cacheTimestamp) / 1000) : null,
      queueDepth: this._getQueueDepth(),
    };
  }

  // --- Search ---

  async search(query, category = null, limit = 8) {
    if (this._online) {
      try {
        const data = await this._fetch('/memory/search', {
          method: 'POST',
          body: JSON.stringify({ query, category, limit }),
          timeout: TIMEOUTS.MEMORY_SEARCH,
        });
        return filterScopedMemories(data.results || []);
      } catch (err) {
        logger.warn({ err: err.message }, 'EVO X2 search failed, falling back to cache');
      }
    }
    return filterScopedMemories(this._keywordSearch(query, category, limit));
  }

  _keywordSearch(query, category, limit) {
    const tokens = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    if (tokens.size === 0) return [];
    const scored = [];
    for (const m of filterScopedMemories(this._cache)) {
      if (category && m.category !== category) continue;
      const allTokens = new Set([...(m.tags || []), ...m.fact.toLowerCase().split(/\W+/).filter(t => t.length > 2)]);
      let matches = 0;
      for (const t of tokens) { if (allTokens.has(t)) matches++; }
      if (matches > 0) scored.push({ score: matches / tokens.size, memory: m });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // --- Store ---

  async store(fact, category, tags, confidence = 0.9, source = 'api') {
    if (this._online) {
      try {
        return await this._fetch('/memory/store', {
          method: 'POST',
          body: JSON.stringify({ fact, category, tags, confidence, source }),
          timeout: TIMEOUTS.MEMORY_STORE,
        });
      } catch (err) {
        logger.warn({ err: err.message }, 'EVO X2 store failed, queuing locally');
      }
    }
    this._queueItem('text', { type: 'store', fact, category, tags, confidence, source });
    return { stored: false, queued: true };
  }

  async storeNote(text, source = 'manual_note') {
    if (this._online) {
      try {
        return await this._fetch('/note', {
          method: 'POST', body: JSON.stringify({ text, source }), timeout: TIMEOUTS.MEMORY_NOTE,
        });
      } catch (err) {
        logger.warn({ err: err.message }, 'EVO X2 note store failed, queuing');
      }
    }
    this._queueItem('text', { type: 'note', text, source });
    return { stored: false, queued: true };
  }

  async extractFromConversation(conversation, source = 'conversation') {
    throw new Error('legacy_extraction_retired_use_grounded_learning_worker');
  }

  /**
   * Call /extract with store_results: false so EVO returns candidates without
   * persisting them. Used by the compound-dream shadow consolidate stage — the
   * Node side validates and writes to a shadow file. On offline or error,
   * returns an empty result with a flag; does NOT queue (queued extracts would
   * be replayed by the live bot and double-store).
   * @param {string} conversation
   * @param {string} source
   * @returns {Promise<{extracted: Array<object>, offline?: boolean, error?: string}>}
   */
  async extractWithoutStoring(conversation, source = 'conversation') {
    if (!this._online) return { extracted: [], offline: true };
    try {
      return await this._fetch('/extract', {
        method: 'POST',
        body: JSON.stringify({ conversation, store_results: false, source }),
        timeout: TIMEOUTS.MEMORY_EXTRACT,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 extractWithoutStoring failed');
      return { extracted: [], error: err.message };
    }
  }

  // --- Media ---

  async analyseImage(imageBuffer, prompt, extract = true, storeResults = true) {
    if (!this._online) return null;
    try {
      const formData = new FormData();
      formData.append('file', new Blob([imageBuffer]), 'image.jpg');
      formData.append('prompt', prompt || 'Describe this image in detail. Extract any text, numbers, names, dates visible.');
      formData.append('extract', String(extract));
      formData.append('store_results', String(storeResults));
      const resp = await this._fetchRaw(`${this._memoryUrl}/analyse-image`, {
        method: 'POST', body: formData, headers: {}, timeout: TIMEOUTS.MEMORY_IMAGE,
      });
      return await resp.json();
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 image analysis failed');
      return null;
    }
  }

  async transcribeAudio(audioBuffer, language = 'en', extract = true, storeResults = true) {
    if (!this._online) return null;
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.ogg');
      formData.append('language', language);
      formData.append('extract', String(extract));
      formData.append('store_results', String(storeResults));
      const resp = await this._fetchRaw(`${this._memoryUrl}/transcribe`, {
        method: 'POST', body: formData, headers: {}, timeout: TIMEOUTS.MEMORY_AUDIO,
      });
      return await resp.json();
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 transcription failed');
      return null;
    }
  }

  // --- Update / Delete ---

  async update(memoryId, updates) {
    if (!this._online) return { updated: false, offline: true };
    try {
      return await this._fetch(`/memory/${memoryId}`, {
        method: 'PUT', body: JSON.stringify(updates), timeout: TIMEOUTS.MEMORY_STORE,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'memory update failed');
      return { updated: false, error: err.message };
    }
  }

  async delete(memoryId) {
    /** Soft-archive a memory (sets status='archived'). Nothing is ever hard-deleted. */
    if (!this._online) return { archived: false, offline: true };
    try {
      return await this._fetch(`/memory/${memoryId}`, {
        method: 'DELETE', timeout: TIMEOUTS.MEMORY_DEFAULT,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'memory archive failed');
      return { archived: false, error: err.message };
    }
  }

  async archive(memoryId) {
    /** Explicitly soft-archive a memory — alias for delete() with clearer intent. */
    return this.delete(memoryId);
  }

  // --- Stats / List ---

  async getStats() {
    if (this._online) {
      try {
        return await this._fetch('/memory/stats', { timeout: TIMEOUTS.MEMORY_HEALTH_CHECK });
      } catch (err) {
        logger.warn({ err: err.message }, 'failed to get memory stats');
      }
    }
    const cats = {};
    for (const m of this._cache) { cats[m.category] = (cats[m.category] || 0) + 1; }
    return { total: this._cache.length, categories: cats, fromCache: true };
  }

  async list() {
    if (this._online) {
      try {
        const data = await this._fetch('/memory/list', { timeout: TIMEOUTS.MEMORY_DEFAULT });
        return data.memories || [];
      } catch (err) {
        logger.warn({ err: err.message }, 'failed to list memories');
      }
    }
    return this._cache;
  }

  // --- Retrieval helpers ---

  async getRelevantMemories(messageText, opts = {}) {
    if (!messageText || messageText.length < 5) return [];
    const tokens = messageText.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    if (tokens.length === 0) return [];

    // Project-scoped recall pulls more candidates (20 vs 8) AND drops the
    // relevance floor to near-zero (0.02 vs 0.12). Rationale: in a group
    // bound to a specific project, the user wants Clint to remember
    // everything said in that context — not just the top-8 hottest hits.
    // Recency decay + the project boost below re-rank; showing a broader
    // set to the LLM beats over-filtering and missing a weak-signal
    // memory that was actually relevant.
    const projectBoostKeys = Array.isArray(opts.projectBoostKeys)
      ? new Set(opts.projectBoostKeys.filter(Boolean))
      : null;
    const searchLimit = projectBoostKeys ? 20 : 8;
    const scoreFloor = projectBoostKeys ? 0.02 : 0.12;

    const results = await this.search(messageText, null, searchLimit);

    const docPattern = /\b(document|doc|file|pdf|report|analysis|the\s+\w+\.(?:md|pdf|docx|csv))\b/i;
    if (docPattern.test(messageText)) {
      try {
        const docResults = await this.search(messageText, 'document_chunk', 4);
        const docSummaries = await this.search(messageText, 'document', 2);
        const existingIds = new Set(results.map(r => (r.memory || r).id));
        for (const r of [...docResults, ...docSummaries]) {
          const id = (r.memory || r).id;
          if (id && !existingIds.has(id)) { results.push(r); existingIds.add(id); }
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'document memory search failed');
      }
    }

    // Project-scope boost: when invoked from a group bound to a specific
    // project, memories whose chatJid matches either the group JID (live
    // conversation extractions) or the project:<id> synthetic JID (docs
    // ingested by project-sync) get a significant score bump so they
    // outrank generic memories. Applied here rather than as a filter so
    // un-scoped recall still works; the bias just surfaces the right
    // content first.
    const PROJECT_BOOST = 0.25;

    const now = Date.now();
    return results
      .filter(r => (r.score ?? 0) >= scoreFloor)
      .map(r => {
        const mem = r.memory || r;
        let recencyBoost = 0;
        const dateStr = mem.sourceDate || mem.created;
        if (dateStr) {
          const ageDays = (now - new Date(dateStr).getTime()) / 86400000;
          if (ageDays < 1) recencyBoost = 0.15;
          else if (ageDays < 3) recencyBoost = 0.10;
          else if (ageDays < 7) recencyBoost = 0.05;
        }
        const projectBoost =
          projectBoostKeys && mem.chatJid && projectBoostKeys.has(mem.chatJid)
            ? PROJECT_BOOST
            : 0;
        return { memory: mem, adjustedScore: (r.score ?? 0) + recencyBoost + projectBoost };
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore)
      .map(r => r.memory);
  }

  async getDreamMemories(groupJid, limit = 3) {
    if (!this._online) return [];
    try {
      const results = await this.search(`dream summary ${groupJid}`, 'dream', limit);
      return results.map(r => r.memory || r).filter(Boolean);
    } catch (err) {
      logger.warn({ err: err.message }, 'dream memory fetch failed');
      return [];
    }
  }

  async getIdentityMemories() {
    if (!this._online) return [];
    try {
      const results = await this.search('identity core permanent', 'identity', 10);
      return results.map(r => r.memory || r).filter(Boolean);
    } catch (err) {
      logger.warn({ err: err.message }, 'identity memory fetch failed');
      return [];
    }
  }

  async getOvernightInsights(dateStr) {
    if (!this._online) return [];
    try {
      const results = await this.search(`diary_insight ${dateStr}`, 'insight', 8);
      return (results || []).map(r => r.memory || r).filter(m => m && (m.tags || []).includes(dateStr));
    } catch (err) {
      logger.warn({ err: err.message }, 'overnight insight fetch failed');
      return [];
    }
  }

  async getInsightMemories(query, limit = 3) {
    if (!this._online) return [];
    try {
      const results = await this.search(query, 'insight', limit);
      return (results || []).filter(r => (r.score ?? 0) >= 0.20).map(r => r.memory || r).filter(Boolean);
    } catch (err) {
      logger.warn({ err: err.message }, 'insight memory fetch failed');
      return [];
    }
  }

  // --- Document storage ---

  async storeDocument({ fileName, rawText, summary, sender, chatJid }) {
    const date = new Date().toISOString().split('T')[0];
    const baseTags = [fileName.replace(/\s+/g, '_'), date, sender || 'unknown'];

    try {
      await this.store(
        `Document "${fileName}" (${rawText.length} chars, from ${sender || 'unknown'}): ${summary}`,
        'document', [...baseTags, 'summary'], 0.9, 'document_intake',
      );
    } catch (err) {
      logger.warn({ err: err.message, fileName }, 'failed to store document summary');
    }

    const chunks = this._chunkText(rawText, 2000);
    let storedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.store(
          `[${fileName} chunk ${i + 1}/${chunks.length}] ${chunks[i]}`,
          'document_chunk', [...baseTags, `chunk_${i}`], 0.85, 'document_intake',
        );
        storedChunks++;
      } catch (err) {
        logger.warn({ err: err.message, fileName, chunk: i }, 'failed to store document chunk');
      }
    }

    try {
      await this.store(
        `Document index: "${fileName}", ${rawText.length} chars, ${chunks.length} chunks, from ${sender || 'unknown'} on ${date}. Summary: ${summary.slice(0, 200)}`,
        'document_index', [...baseTags, 'index'], 1.0, 'document_intake',
      );
    } catch (err) {
      logger.warn({ err: err.message, fileName }, 'failed to store document index');
    }

    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      writeFileSync(join(DOC_CACHE_DIR, `${date}_${safeName}`), rawText);
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(), fileName,
        sender: sender || 'unknown', chatJid: chatJid || 'unknown',
        charCount: rawText.length, summary: summary.slice(0, 1000),
      });
      appendFileSync(join(DOC_LOG_DIR, `${date}.jsonl`), logEntry + '\n');
    } catch (err) {
      logger.warn({ err: err.message, fileName }, 'failed to write document log');
    }

    logger.info({ fileName, chunks: storedChunks, totalChunks: chunks.length }, 'document stored in memory');
    return { storedChunks, totalChunks: chunks.length };
  }

  cleanDocumentCache(maxAgeDays = 7) {
    try {
      const now = Date.now();
      const maxAge = maxAgeDays * 86400000;
      let cleaned = 0;
      for (const f of readdirSync(DOC_CACHE_DIR)) {
        const filepath = join(DOC_CACHE_DIR, f);
        if (now - statSync(filepath).mtimeMs > maxAge) { unlinkSync(filepath); cleaned++; }
      }
      if (cleaned > 0) logger.info({ cleaned }, 'document cache cleaned');
    } catch (err) {
      logger.warn({ err: err.message }, 'document cache cleanup failed');
    }
  }

  // --- Formatting ---

  formatForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    const now = Date.now();
    const lines = memories.map(m => {
      const dateStr = m.sourceDate || m.created;
      let age = '';
      if (dateStr) {
        const ageDays = Math.floor((now - new Date(dateStr).getTime()) / 86400000);
        if (ageDays === 0) age = 'today';
        else if (ageDays === 1) age = 'yesterday';
        else if (ageDays < 7) age = `${ageDays}d ago`;
        else if (ageDays < 30) age = `${Math.floor(ageDays / 7)}w ago`;
        else age = `${Math.floor(ageDays / 30)}mo ago`;
      }
      return `- ${m.fact} [${m.category}${age ? ', ' + age : ''}]`;
    });
    return `\n\n## What you remember (most recent first)\n${lines.join('\n')}`;
  }

  // --- Cache sync ---

  async syncCache() {
    try {
      const data = await this._fetch('/memory/list', { timeout: TIMEOUTS.MEMORY_SEARCH });
      this._cache = data.memories || [];
      this._cacheTimestamp = Date.now();
      writeFileSync(CACHE_FILE, JSON.stringify({ memories: this._cache, timestamp: this._cacheTimestamp }));
      logger.info({ count: this._cache.length }, 'memory cache synced');
    } catch (err) {
      logger.error({ err: err.message }, 'cache sync failed');
    }
  }

  async triggerMaintenance() {
    if (!this._online) return { error: 'EVO X2 offline' };
    try {
      return await this._fetch('/maintain', { method: 'POST', timeout: TIMEOUTS.MEMORY_STORE });
    } catch (err) {
      return { error: err.message };
    }
  }

  // --- Queue (private) ---

  _queueItem(type, data) {
    const dir = type === 'audio' ? QUEUE_AUDIO_DIR : type === 'images' ? QUEUE_IMAGE_DIR : QUEUE_TEXT_DIR;
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(data));
    logger.info({ type, filename }, 'item queued for EVO X2');
  }

  _getQueueDepth() {
    let count = 0;
    for (const dir of [QUEUE_TEXT_DIR, QUEUE_AUDIO_DIR, QUEUE_IMAGE_DIR]) {
      try { count += readdirSync(dir).filter(f => f.endsWith('.json')).length; }
      catch { /* intentional: dir may not exist yet */ }
    }
    return count;
  }

  async _drainQueue() {
    const textFiles = readdirSync(QUEUE_TEXT_DIR).filter(f => f.endsWith('.json')).sort();
    let processed = 0;
    for (const file of textFiles) {
      const filepath = join(QUEUE_TEXT_DIR, file);
      try {
        const raw = readFileSync(filepath, 'utf-8');
        const data = parseQueuedItem(raw);
        if (!data) {
          logger.warn({ file }, 'discarding empty queued item');
          unlinkSync(filepath);
          continue;
        }
        if (data.type === 'store') {
          await this._fetch('/memory/store', { method: 'POST', body: JSON.stringify(data), timeout: TIMEOUTS.MEMORY_STORE });
        } else if (data.type === 'note') {
          await this._fetch('/note', { method: 'POST', body: JSON.stringify({ text: data.text, source: data.source }), timeout: TIMEOUTS.MEMORY_NOTE });
        } else if (data.type === 'extract') {
          // Preserve historical source material for supervised reprocessing; never promote old guesses.
          logger.warn({ file }, 'legacy extraction retained for grounded reprocessing');
          continue;
        }
        unlinkSync(filepath);
        processed++;
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.warn({ err: err.message, file }, 'discarding malformed queued item');
          try { unlinkSync(filepath); } catch { /* intentional: best-effort cleanup */ }
          continue;
        }
        logger.error({ err: err.message, file }, 'failed to process queued item');
        break;
      }
    }
    if (processed > 0) logger.info({ processed }, 'queue drain complete');
  }

  _chunkText(text, maxChars = 2000) {
    const chunks = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';
    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    const result = [];
    for (const chunk of chunks) {
      if (chunk.length <= maxChars) { result.push(chunk); }
      else { for (let i = 0; i < chunk.length; i += maxChars) result.push(chunk.slice(i, i + maxChars)); }
    }
    return result;
  }
}

// --- Singleton instance ---
const client = new MemoryClient({
  memoryUrl: config.evoMemoryUrl,
  fetchJSON: evoFetchJSON,
  fetchRaw: evoFetchRaw,
});

// --- Facade exports (identical API — zero breaking changes) ---
export { MemoryClient };
export const checkEvoHealth = (options = {}) => client.checkHealth(options);
export const getLastHealthData = () => client.getLastHealthData();
export const isEvoOnline = () => client.isOnline();
export const getEvoStatus = () => client.getStatus();
export const searchMemory = (q, c, l) => client.search(q, c, l);

// Invalidate the cortex identity cache on any write-path mutation.
// Dynamic import avoids a circular dependency between memory.js and cortex-cache.js.
async function _invalidateCortexIdentityCache() {
  try {
    const mod = await import('./cortex-cache.js');
    mod.clearIdentityCache?.();
  } catch {
    // intentional: cortex-cache is an optional consumer — no-op if unavailable
  }
}

export const storeMemory = async (f, c, t, conf, s) => {
  const result = await client.store(f, c, t, conf, s);
  if (c === 'identity') _invalidateCortexIdentityCache();
  return result;
};
export const storeNote = (t, s) => client.storeNote(t, s);
export const extractFromConversation = (c, s) => client.extractFromConversation(c, s);
export const extractWithoutStoring = (c, s) => client.extractWithoutStoring(c, s);
export const analyseImage = (b, p, e, s) => client.analyseImage(b, p, e, s);
export const transcribeAudio = (b, l, e, s) => client.transcribeAudio(b, l, e, s);
export const updateMemory = async (id, u) => {
  const result = await client.update(id, u);
  // Identity memories are rare; blanket-invalidate on any update to be safe
  _invalidateCortexIdentityCache();
  return result;
};
export const deleteMemory = async (id) => {
  const result = await client.delete(id);
  _invalidateCortexIdentityCache();
  return result;
};
export const archiveMemory = (id) => client.archive(id);
export const getMemoryStats = () => client.getStats();
export const listMemories = () => client.list();
export const getRelevantMemories = (t, opts) => client.getRelevantMemories(t, opts);
export const getDreamMemories = (g, l) => client.getDreamMemories(g, l);
export const getIdentityMemories = () => client.getIdentityMemories();
export const getOvernightInsights = (d) => client.getOvernightInsights(d);
export const getInsightMemories = (q, l) => client.getInsightMemories(q, l);
export const formatMemoriesForPrompt = (m) => client.formatForPrompt(m);
export const storeDocument = (o) => client.storeDocument(o);
export const cleanDocumentCache = (d) => client.cleanDocumentCache(d);
export const syncCache = () => client.syncCache();
export const triggerMaintenance = () => client.triggerMaintenance();
