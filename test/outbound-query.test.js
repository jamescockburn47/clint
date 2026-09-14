import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outboundQuerySafe } from '../src/outbound-query.js';
import { createConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
test('Contextual search permits normal prose and percentages but blocks recognizable and configured secrets', () => {
  for (const value of ['5% commercial interest', 'compare our Qwen model with Flash Next', 'Google refresh token documentation']) {
    assert.equal(outboundQuerySafe(value), true);
  }
  for (const secret of ['Bearer synthetic-token-long', 'refresh_token=synthetic-secret-value',
    '-----BEGIN PRIVATE KEY-----', 'xoxb-synthetic-token-for-test', '1//synthetic-refresh-token-value']) {
    for (const value of [secret, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret))]) {
      assert.equal(outboundQuerySafe(value), false);
    }
  }
  assert.equal(outboundQuerySafe('Find opaque-example-credential', { googleRefreshToken: 'opaque-example-credential' }), false);
  assert.equal(outboundQuerySafe('{"client_secret":"synthetic-review-credential-1234567890"}'), false);
  assert.equal(outboundQuerySafe('5% ' + encodeURIComponent('Bearer synthetic-review-credential-1234567890')), false);
});
test('Real Slack policy allows percentage research while rejecting secret queries and encoded URL credentials', () => {
  const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:test:private',
    actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'open' }, localOnly: true, readOnly: true });
  assert.equal(permitsTool('web_search', { query: '5% commercial interest' }, scope), true);
  assert.equal(permitsTool('web_search', { query: 'Bearer synthetic-token-for-test' }, scope), false);
  assert.equal(permitsTool('web_search', { query: 'reference', include_domains: ['xoxb-synthetic-token-for-test.example.org'] }, scope), false);
  assert.equal(permitsTool('web_search', { query: 'reference', include_domains: ['docs.python.org'] }, scope), true);
  assert.equal(permitsTool('web_fetch', { url: 'https://example.com/?refresh_token=synthetic-secret-value' }, scope), false);
});
