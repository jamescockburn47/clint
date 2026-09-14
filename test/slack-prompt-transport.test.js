import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemPrompt } from '../src/prompt.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';

test('Slack has no contradictory legacy DM capability or WhatsApp notification instructions', () => {
  for (const mode of ['open', 'colleague']) {
    const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:test',
      actorId: 'owner', ownerId: 'owner', audience: 'group', localOnly: true, readOnly: true,
      policy: { mode } });
    for (const category of ['system', 'planning', 'conversational', 'task', 'email', 'travel', 'recall']) {
    const prompt = withConversationContext(scope, () => getSystemPrompt('professional', true, true, category, scope.conversationId));
    assert.match(prompt, /Slack DMs are not connected/);
    assert.doesNotMatch(prompt, /only available in DMs with James|change them via DM|You also DM James live notifications/);
    assert.match(prompt, /draft text in this channel/);
    assert.match(prompt, /SECURITY_MARKER/);
    assert.doesNotMatch(prompt, /## How to work with James|## Concrete calibration/,
      'the failed experimental personality profile must remain outside the release prompt');
    assert.doesNotMatch(prompt, /Reminders send a WhatsApp|## EMAIL RULES|## TRAVEL TOOLS|mention\/prefix-only/);
    assert.doesNotMatch(prompt, /READING is always safe|search and read emails\/calendar freely|check your calendar|then you summarised it|## LQ BOT COUNCIL — DEV GROUP CONTEXT/);
    }
  }
});
