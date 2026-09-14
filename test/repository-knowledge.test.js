import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryStatus } from '../src/knowledge/repository.js';
import { createConversationContext } from '../src/conversation-context.js';
const scope = createConversationContext({ transport: 'slack', conversationId: 's', actorId: 'o',
  ownerId: 'o', audience: 'group', localOnly: true, readOnly: true });

test('live repository read sends only fixed public identifiers and preserves freshness/provenance', async () => {
  const calls = [];
  const result = await repositoryStatus({ id: 'clint' }, { scope, now: () => new Date('2026-09-14T00:00:00Z'),
    fetchFn: async (url, init) => {
      calls.push(url); assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined);
      return new Response(JSON.stringify(calls.length === 1 ? { private: false, default_branch: 'main' } : [
        { sha: 'a'.repeat(40), commit: { message: 'Published change\nDetails', committer: { date: null } } },
      ]));
    } });
  assert.equal(result.state, 'live_github_read'); assert.equal(calls.length, 2);
  assert.equal(result.commits[0].committedAt, null);
  assert.equal(result.evidenceType, 'published_repository_observation');
  assert.equal(result.observedAt, '2026-09-14T00:00:00.000Z');
  assert.deepEqual(result.verification, { publishedBranch: 'observed', deployment: 'not_checked',
    localWorkingTree: 'not_checked', codeBehavior: 'not_checked', commitMessages: 'author_reports' });
  assert.match(result.limit, /deployment are unverified/);
});

test('arbitrary repo, source-bearing extra arguments, missing scope and nonowner never make requests', async () => {
  for (const input of [{ id: 'evil' }, { id: 'clint', query: 'PRIVATE_SOURCE' }, { id: '../private' }]) {
    assert.equal((await repositoryStatus(input, { scope, fetchFn: () => assert.fail('request') })).state, 'invalid_repository');
  }
  assert.equal((await repositoryStatus({ id: 'clint' }, { scope: undefined,
    fetchFn: () => assert.fail('request') })).state, 'not_authorized');
});

test('inaccessible, private or malformed repositories cannot yield invented current state', async () => {
  for (const response of [new Response('', { status: 403 }), new Response('{bad'),
    new Response(JSON.stringify({ private: true, default_branch: 'main' }))]) {
    const result = await repositoryStatus({ id: 'clint' }, { scope,
      now: () => new Date('2026-09-14T00:00:00Z'), fetchFn: async () => response });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.observedAt, null, 'a failed read supplies no successful observation time');
    assert.equal(result.attemptedAt, '2026-09-14T00:00:00.000Z');
    assert.equal(result.verification.publishedBranch, 'unavailable');
    assert.equal(result.verification.deployment, 'not_checked');
  }
});
