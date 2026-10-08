// test/evo-llm-routing.test.js — local Qwen routing safeguards for report/research requests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const {
  buildForcedLiveBriefingInput,
  isForcedLiveBriefingRequest,
  toolLoopExhaustedMessage,
} = await import('../src/evo-llm.js');

describe('forced live briefing routing', () => {
  it('routes up-to-date research report requests to live_briefing', () => {
    assert.equal(
      isForcedLiveBriefingRequest('126131059593382 do some up to date research on G42 and reputational risks of association'),
      true,
    );
  });

  it('builds a clean deep briefing topic from a WhatsApp mention-prefixed request', () => {
    assert.deepEqual(
      buildForcedLiveBriefingInput('@126131059593382 do some up to date research on G42 and reputational risks of association'),
      {
        topic: 'G42 and reputational risks of association',
        depth: 'deep',
      },
    );
  });
});

describe('tool loop exhaustion', () => {
  it('returns a user-visible failure message instead of silent null output', () => {
    assert.match(toolLoopExhaustedMessage(), /ran out of tool steps/i);
  });
});
