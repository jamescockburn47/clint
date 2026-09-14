// test/evo-client.test.js — EVO shared HTTP client: fetch, timeout, health checks, circuit breakers
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let evoFetch, evoFetchJSON, checkLlamaHealth, checkMemoryHealth, checkClassifierHealth;
let llamaBreaker, memoryBreaker, classifierBreaker;
let originalFetch;

async function loadModules() {
  const mod = await import('../src/evo-client.js');
  ({ evoFetch, evoFetchJSON, checkLlamaHealth, checkMemoryHealth, checkClassifierHealth,
    llamaBreaker, memoryBreaker, classifierBreaker } = mod);
}

describe('evoFetch', () => {
  beforeEach(async () => {
    if (!evoFetch) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns response on successful fetch', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: 'ok' }),
      text: async () => '{"result":"ok"}',
    });

    const resp = await evoFetch('http://10.0.0.2:8080/health');
    const data = await resp.json();
    assert.equal(data.result, 'ok');
  });

  it('throws the HTTP status without logging the upstream response body', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable: model loading',
    });

    await assert.rejects(
      () => evoFetch('http://10.0.0.2:8080/v1/chat'),
      (err) => {
        assert.ok(err.message.includes('EVO HTTP 503'));
        assert.equal(err.message, 'EVO HTTP 503');
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  it('throws timeout error with code TIMEOUT on abort', async () => {
    globalThis.fetch = async (url, opts) => {
      // Simulate AbortError (as if the AbortController fired)
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      () => evoFetch('http://10.0.0.2:8080/slow', { timeout: 100 }),
      (err) => {
        assert.equal(err.name, 'AbortError');
        assert.equal(err.code, 'TIMEOUT');
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
  });

  it('passes custom headers through to fetch', async () => {
    let capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({}) };
    };

    await evoFetch('http://10.0.0.2:5100/store', {
      method: 'POST',
      headers: { 'X-Custom': 'test' },
    });

    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.equal(capturedHeaders['X-Custom'], 'test');
  });

  it('propagates non-abort errors unchanged', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    await assert.rejects(
      () => evoFetch('http://10.0.0.2:8080/health'),
      (err) => {
        assert.equal(err.message, 'ECONNREFUSED');
        return true;
      },
    );
  });
});

describe('evoFetchJSON', () => {
  beforeEach(async () => {
    if (!evoFetchJSON) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed JSON from successful response', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ memories: [{ fact: 'test' }] }),
    });

    const data = await evoFetchJSON('http://10.0.0.2:5100/search');
    assert.equal(data.memories.length, 1);
    assert.equal(data.memories[0].fact, 'test');
  });

  it('throws on invalid JSON', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    await assert.rejects(
      () => evoFetchJSON('http://10.0.0.2:5100/search'),
      SyntaxError,
    );
  });
});

describe('checkLlamaHealth', () => {
  beforeEach(async () => {
    if (!checkLlamaHealth) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns true when status is ok', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    assert.equal(await checkLlamaHealth(), true);
  });

  it('returns true when status is "no slot available" (model loaded but busy)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'no slot available' }),
    });

    assert.equal(await checkLlamaHealth(), true);
  });

  it('returns false when status is unexpected', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'loading model' }),
    });

    assert.equal(await checkLlamaHealth(), false);
  });

  it('returns false on network error', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await checkLlamaHealth(), false);
  });

  it('returns false on HTTP error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    assert.equal(await checkLlamaHealth(), false);
  });
});

describe('checkMemoryHealth', () => {
  beforeEach(async () => {
    if (!checkMemoryHealth) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns health data when online', async () => {
    const healthData = { status: 'online', memories: 482, uptime: 3600 };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => healthData,
    });

    const result = await checkMemoryHealth();
    assert.deepEqual(result, healthData);
  });

  it('returns null when status is not online', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'starting' }),
    });

    assert.equal(await checkMemoryHealth(), null);
  });

  it('returns null on error', async () => {
    globalThis.fetch = async () => { throw new Error('timeout'); };
    assert.equal(await checkMemoryHealth(), null);
  });
});

describe('checkClassifierHealth', () => {
  beforeEach(async () => {
    if (!checkClassifierHealth) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns true when ok', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });
    assert.equal(await checkClassifierHealth(), true);
  });

  it('returns false on failure', async () => {
    globalThis.fetch = async () => { throw new Error('down'); };
    assert.equal(await checkClassifierHealth(), false);
  });
});

describe('CircuitBreaker integration', () => {
  beforeEach(async () => {
    if (!llamaBreaker) await loadModules();
    llamaBreaker.reset();
  });

  it('starts in closed state', () => {
    assert.equal(llamaBreaker.state, 'closed');
    assert.equal(llamaBreaker.failures, 0);
  });

  it('opens after threshold failures', async () => {
    for (let i = 0; i < 3; i++) {
      await llamaBreaker.call(() => { throw new Error('fail'); }, null);
    }
    assert.equal(llamaBreaker.state, 'open');
    assert.equal(llamaBreaker.failures, 3);
  });

  it('returns fallback when open', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await llamaBreaker.call(() => { throw new Error('fail'); }, null);
    }

    const result = await llamaBreaker.call(
      () => { throw new Error('should not be called'); },
      'fallback-value',
    );
    assert.equal(result, 'fallback-value');
  });

  it('resets to closed on success after half-open', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await llamaBreaker.call(() => { throw new Error('fail'); }, null);
    }
    // Force half-open by backdating lastFailure
    llamaBreaker.lastFailure = Date.now() - 120000; // 2 min ago (past 60s reset)

    const result = await llamaBreaker.call(async () => 'recovered', null);
    assert.equal(result, 'recovered');
    assert.equal(llamaBreaker.state, 'closed');
    assert.equal(llamaBreaker.failures, 0);
  });

  it('all three breakers are independent', () => {
    assert.notEqual(llamaBreaker.name, memoryBreaker.name);
    assert.notEqual(memoryBreaker.name, classifierBreaker.name);
  });
});
