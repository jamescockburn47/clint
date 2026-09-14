import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(join(process.cwd(), 'scripts', 'deploy-clawdbot.sh'), 'utf8');

describe('deploy-clawdbot.sh', () => {
  it('only verifies or directs the operator to the approved release procedure', () => {
    assert.match(script, /exec npm run verify/);
    assert.match(script, /docs\/release-runbook\.md/);
    assert.match(script, /exit 2/);
    assert.doesNotMatch(script, /\b(systemctl|sudo|git|fuser|pkill)\b/);
    assert.doesNotMatch(script, /checkEvoHealth|refreshSystemKnowledge/);
  });
});
