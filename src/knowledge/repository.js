import { z } from 'zod';
import { currentConversation } from '../conversation-context.js';

// Operator-reviewed public repository. Model/source text cannot choose a destination or request path.
const REPOSITORIES = Object.freeze({ clint: 'jamescockburn47/clawd-admin' });
export const REPOSITORY_DEFINITION = {
  name: 'repository_status',
  description: 'Read current published GitHub branch and five recent commits for the registered Clint repository. This cannot see unpushed local work or prove deployment. Returns observation date, commit dates and source links. No credentials, writes or arbitrary searches.',
  input_schema: { type: 'object', properties: { id: { type: 'string', enum: ['clint'] } },
    required: ['id'], additionalProperties: false },
};
export const repositoryAllowed = (scope = currentConversation()) =>
  !!scope?.isOwner && !!scope.localOnly && !scope.webOnly && scope.audience !== 'unknown';

async function publicJson(url, fetchFn) {
  const response = await fetchFn(url, { method: 'GET', redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Clint',
      'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('repository_unavailable');
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256000) throw new Error('repository_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function repositoryStatus(input, { scope = currentConversation(), fetchFn = fetch,
  now = () => new Date() } = {}) {
  if (!repositoryAllowed(scope)) return { state: 'not_authorized' };
  const parsed = z.object({ id: z.enum(['clint']) }).strict().safeParse(input);
  if (!parsed.success) return { state: 'invalid_repository' };
  const repository = REPOSITORIES[parsed.data.id];
  try {
    const base = `https://api.github.com/repos/${repository}`;
    const meta = z.object({ private: z.literal(false), default_branch: z.string().min(1).max(200) })
      .parse(await publicJson(base, fetchFn));
    const commits = z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/),
      commit: z.object({ message: z.string().max(50000), committer: z.object({
        date: z.string().datetime({ offset: true }).nullable(),
      }).nullable() }) })).max(5).parse(await publicJson(
        `${base}/commits?per_page=5&sha=${encodeURIComponent(meta.default_branch)}`, fetchFn));
    return { state: 'live_github_read', repository, branch: meta.default_branch,
      evidenceType: 'published_repository_observation',
      verification: { publishedBranch: 'observed', deployment: 'not_checked',
        localWorkingTree: 'not_checked', codeBehavior: 'not_checked', commitMessages: 'author_reports' },
      observedAt: now().toISOString(), source: `https://github.com/${repository}`,
      commits: commits.map(c => ({ sha: c.sha, subject: c.commit.message.split('\n')[0],
        committedAt: c.commit.committer?.date ?? null, source: `https://github.com/${repository}/commit/${c.sha}` })),
      limit: 'Published GitHub state only; local changes and deployment are unverified. Commit messages are author claims, not proof that code works.' };
  } catch { return { state: 'unavailable', repository, observedAt: null, attemptedAt: now().toISOString(),
    evidenceType: 'failed_repository_read',
    verification: { publishedBranch: 'unavailable', deployment: 'not_checked',
      localWorkingTree: 'not_checked', codeBehavior: 'not_checked', commitMessages: 'unavailable' },
    error: 'github_read_failed', commits: [] }; }
}
