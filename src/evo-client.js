// src/evo-client.js — Shared EVO X2 HTTP client infrastructure
// Single source for all EVO HTTP calls, health checks, and circuit breakers.
// Zero hardcoded IPs — all URLs from config.js.

import config from './config.js';
import logger from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TIMEOUTS } from './constants.js';

// --- EvoClient class (owns circuit breakers and HTTP state) ---

class EvoClient {
  /** @param {{ evoLlmUrl: string, evoClassifierUrl: string, evoPlannerUrl: string, evoMemoryUrl: string, evoChatModel?: string }} urls */
  constructor(urls) {
    this.urls = urls;
    this.llamaBreaker = new CircuitBreaker('evo-llama', { threshold: 3, resetTimeout: 60000 });
    this.memoryBreaker = new CircuitBreaker('evo-memory', { threshold: 3, resetTimeout: 60000 });
    this.classifierBreaker = new CircuitBreaker('evo-classifier', { threshold: 3, resetTimeout: 30000 });
    this.plannerBreaker = new CircuitBreaker('evo-planner', { threshold: 3, resetTimeout: 60000 });
  }

  /**
   * Fetch from an EVO service with timeout, AbortController, and structured error logging.
   * @param {string} url - Full URL to fetch
   * @param {object} [options] - fetch options plus optional `timeout` (ms, default 10000)
   * @returns {Promise<Response>}
   */
  async fetch(url, options = {}) {
    const timeout = options.timeout || TIMEOUTS.MEMORY_DEFAULT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const { timeout: _t, ...fetchOpts } = options;

    try {
      // OpenAI-compatible gateways require a model ID; display labels are not API identifiers.
      const modelUrls = [this.urls.evoLlmUrl];
      if (this.urls.evoChatModel && modelUrls.some(base => url === `${base}/v1/chat/completions`) && typeof fetchOpts.body === 'string') {
        const body = JSON.parse(fetchOpts.body);
        fetchOpts.body = JSON.stringify({ model: this.urls.evoChatModel, ...body });
      }
      const resp = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...fetchOpts.headers },
      });

      if (!resp.ok) {
        // Upstream error bodies may echo prompts, credentials or document text.
        await resp.body?.cancel();
        const err = new Error(`EVO HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }

      return resp;
    } catch (err) {
      if (err.name === 'AbortError') {
        const abortErr = new Error(`EVO request timed out after ${timeout}ms: ${url}`);
        abortErr.name = 'AbortError';
        abortErr.code = 'TIMEOUT';
        logger.warn({ url, timeout }, 'evo request timed out');
        throw abortErr;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch that returns parsed JSON.
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async fetchJSON(url, options = {}) {
    const resp = await this.fetch(url, options);
    return resp.json();
  }

  /**
   * Check if llama-server (main LLM) is healthy.
   * @returns {Promise<boolean>}
   */
  async checkLlamaHealth() {
    return this.checkModelHealth(this.urls.evoLlmUrl);
  }

  async checkModelHealth(baseUrl) {
    try {
      const resp = await this.fetch(`${baseUrl}/health`, {
        timeout: TIMEOUTS.EVO_HEALTH_CHECK,
      });
      const data = await resp.json();
      return data.status === 'ok' || data.status === 'no slot available';
    } catch {
      // intentional: health check failure is not an error — caller uses boolean
      try {
        const response = await this.fetch(`${baseUrl}/v1/models`, { timeout: TIMEOUTS.EVO_HEALTH_CHECK });
        const data = await response.json();
        return Array.isArray(data.data) && data.data.some(model => typeof model.id === 'string' &&
          (!this.urls.evoChatModel || model.id === this.urls.evoChatModel));
      } catch { return false; }
    }
  }

  /**
   * Check if memory service is healthy.
   * @returns {Promise<object|null>} Health data or null on failure
   */
  async checkMemoryHealth() {
    try {
      const resp = await this.fetch(`${this.urls.evoMemoryUrl}/health`, {
        timeout: TIMEOUTS.MEMORY_HEALTH_CHECK,
      });
      const data = await resp.json();
      return data.status === 'online' ? data : null;
    } catch {
      // intentional: health check failure is not an error — caller uses null check
      return null;
    }
  }

  /**
   * Check if classifier (0.6B) is healthy.
   * @returns {Promise<boolean>}
   */
  async checkClassifierHealth() {
    try {
      const resp = await this.fetch(`${this.urls.evoClassifierUrl}/health`, {
        timeout: TIMEOUTS.EVO_HEALTH_CHECK,
      });
      const data = await resp.json();
      return data.status === 'ok' || data.status === 'no slot available';
    } catch {
      // intentional: health check failure is not an error — caller uses boolean
      return false;
    }
  }

  /**
   * Check if 4B planner/classifier is healthy.
   * @returns {Promise<boolean>}
   */
  async checkPlannerHealth() {
    try {
      const resp = await this.fetch(`${this.urls.evoPlannerUrl}/health`, {
        timeout: TIMEOUTS.EVO_HEALTH_CHECK,
      });
      const data = await resp.json();
      return data.status === 'ok' || data.status === 'no slot available';
    } catch {
      // intentional: health check failure is not an error — caller uses boolean
      return false;
    }
  }
}

// --- Singleton instance ---
const client = new EvoClient({
  evoLlmUrl: config.evoLlmUrl,
  evoClassifierUrl: config.evoClassifierUrl,
  evoPlannerUrl: config.evoPlannerUrl,
  evoMemoryUrl: config.evoMemoryUrl,
  evoChatModel: config.evoChatModel,
});

// --- Facade exports (same API as before — zero breaking changes) ---
export { EvoClient };
export const llamaBreaker = client.llamaBreaker;
export const memoryBreaker = client.memoryBreaker;
export const classifierBreaker = client.classifierBreaker;
export const plannerBreaker = client.plannerBreaker;
export const evoFetch = (url, opts) => client.fetch(url, opts);
export const evoFetchJSON = (url, opts) => client.fetchJSON(url, opts);
export const checkLlamaHealth = () => client.checkLlamaHealth();
export const checkMemoryHealth = () => client.checkMemoryHealth();
export const checkClassifierHealth = () => client.checkClassifierHealth();
export const checkPlannerHealth = () => client.checkPlannerHealth();
