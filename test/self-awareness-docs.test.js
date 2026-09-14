import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSystemPrompt } from '../src/prompt.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';

const ROOT = join(import.meta.dirname, '..');

function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'));
}

function readText(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf-8');
}

describe('self-awareness source of truth', () => {
  it('architecture knowledge says EVO is the primary host', () => {
    const architecture = readJson('data/system-knowledge/architecture.json');
    const summary = architecture.architecture.summary;
    assert.match(summary, /EVO X2 as the primary host/i);
    assert.doesNotMatch(summary, /Pi 5 runs Node\.js|Pi is the brain/i);
  });

  it('group knowledge reflects @mention-only policy across all groups', () => {
    const groups = readJson('data/system-knowledge/groups.json');
    const summary = groups.engagementClassifier.summary;
    assert.match(summary, /@mentioned|mention\/prefix/i);
    // The summary may describe the removed pipeline ("the ambient agency pipeline is gone");
    // what matters is it does not describe ambient agency as an active/opt-in behaviour.
    assert.doesNotMatch(summary, /can opt into ambient|may contribute unprompted|LQCore is the exception/i);
  });

  it('scheduler knowledge reflects the phase 5 overnight pipeline', () => {
    const scheduler = readJson('data/system-knowledge/scheduler.json');
    const tasks = scheduler.scheduler.tasks.join(' ');
    assert.match(tasks, /CONSOLIDATE at 02:30/i);
    assert.match(tasks, /PROBE at 03:15/i);
    assert.match(tasks, /REPORT at 06:50/i);
    assert.match(tasks, /IMPROVE at Saturday 22:00/i);
    assert.doesNotMatch(tasks, /Daily retrospective at 04:00|The Forge at 04:30|Self-improvement cycle at 01:00/i);
  });

  it('self-improvement knowledge reflects trace/PROBE/IMPROVE pipeline', () => {
    const selfImprovement = readJson('data/system-knowledge/self-improvement.json');
    const summary = selfImprovement.selfImprovement.summary;
    assert.match(summary, /weekly IMPROVE/i);
    assert.doesNotMatch(summary, /ambient agency/i);
    assert.doesNotMatch(summary, /Daily retrospective at 4 AM|old nightly self-improvement cycle/i);
  });

  it('Slack self-description follows its transport and refreshes runtime facts', () => {
    const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:test',
      actorId: 'owner', ownerId: 'owner', audience: 'group', localOnly: true, readOnly: true,
      policy: { mode: 'open' } });
    const prompt = withConversationContext(scope, () => getSystemPrompt('professional', true, true, 'system', scope.conversationId));
    assert.doesNotMatch(prompt, /mention\/prefix-only|this request uses local Qwen/);
    assert.match(prompt, /Every incoming owner message is directed to you/);
    assert.match(prompt, /Missing observations remain unknown/);
    assert.match(prompt, /Slack DMs are not connected/);
  });
});
