import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let config;
async function load() { config = (await import('../src/config.js')).default; }

describe('config — moorstead keys', () => {
  beforeEach(async () => { if (!config) await load(); });

  it('exposes moorsteadEnabled as a boolean (default true)', () => {
    assert.equal(typeof config.moorsteadEnabled, 'boolean');
    assert.equal(config.moorsteadEnabled, true);
  });

  it('exposes moorsteadJid as a string (default empty)', () => {
    assert.equal(typeof config.moorsteadJid, 'string');
  });
});
