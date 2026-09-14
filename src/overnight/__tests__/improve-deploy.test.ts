import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeployStage,
  parseGitDiffStat,
  type DeployClient,
} from '../improve-deploy.js';
import type { FinalCandidate } from '../improve-synthesis.js';
import type { ImplementArtifacts } from '../improve-implement.js';
import type { RollingReplayResult } from '../improve-replay.js';

function makeCandidate(overrides: Partial<FinalCandidate> = {}): FinalCandidate {
  return {
    id: 'c1',
    title: 'Cap cortex timeout at 15s',
    category: 'performance',
    scope: 'src/cortex.js:gather',
    evidence_refs: ['pattern:a', 'quality_failure:b'],
    predicted_benefit: 'faster',
    ...overrides,
  };
}

function makeArtifacts(overrides: Partial<ImplementArtifacts> = {}): ImplementArtifacts {
  return {
    gitLog: 'abc123 feat: add retry helper',
    // Use a non-banned source file so the default hits Tier B
    gitDiff: ' src/tasks/widgets.js | 20 ++++++--------\n 1 file changed, 12 insertions(+), 8 deletions(-)\n',
    testStdout: 'all tests pass',
    testExitCode: 0,
    claudeStdout: '',
    claudeStderr: '',
    worktreePath: '/tmp/worktree',
    branch: 'forge/wt-test',
    ...overrides,
  };
}

interface MockClient extends DeployClient {
  pushed: string[];
  merged: string[];
  proposals: number;
  ciOk: boolean;
}

function makeClient(): MockClient {
  const client: MockClient = {
    pushed: [],
    merged: [],
    proposals: 0,
    ciOk: true,
    pushBranch: async (branch) => {
      client.pushed.push(branch);
      return `origin/${branch}`;
    },
    runCi: async () => ({
      ok: client.ciOk,
      output: client.ciOk ? 'ci passed' : 'ci failed: test errors',
    }),
    mergeBranch: async (ref) => {
      client.merged.push(ref);
    },
    openProposal: async () => {
      client.proposals++;
    },
  };
  return client;
}

function makeReplay(verdict: 'pass' | 'pass_with_warning' | 'reject'): RollingReplayResult {
  return {
    verdict,
    betterCount: verdict === 'pass' ? 3 : 0,
    worseCount: verdict === 'reject' ? 2 : 0,
    neutralCount: verdict === 'pass_with_warning' ? 3 : 0,
    worseExchanges: [],
    perSampleResults: [],
    ...(verdict === 'pass_with_warning' ? { warning: 'no material effect' } : {}),
  };
}

describe('overnight/improve-deploy.parseGitDiffStat', () => {
  it('parses a standard git diff --stat output', () => {
    const input = ' src/cortex.js   | 20 ++++++--------\n src/router.js | 5 ++---\n 2 files changed, 12 insertions(+), 8 deletions(-)\n';
    const result = parseGitDiffStat(input);
    assert.deepEqual(result.filesChanged, ['src/cortex.js', 'src/router.js']);
    assert.equal(result.linesChanged, 20); // 12 + 8
  });

  it('returns empty when input is empty', () => {
    const result = parseGitDiffStat('');
    assert.deepEqual(result.filesChanged, []);
    assert.equal(result.linesChanged, 0);
  });
});

describe('overnight/improve-deploy.runDeployStage', () => {
  it('Tier A path opens an approval proposal on green CI', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate({ scope: 'data/prompts/system.txt' }),
      artifacts: makeArtifacts({
        gitDiff: ' data/prompts/system.txt | 5 ++\n 1 file changed, 5 insertions(+), 0 deletions(-)\n',
      }),
      replay: makeReplay('pass'),
      client,
    });
    assert.equal(result.verdict, 'proposal_opened');
    assert.equal(result.tier, 'A');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
    assert.match(result.reason, /approval required/i);
  });

  it('Tier B path with green CI + green replay opens an approval proposal', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: makeReplay('pass'),
      client,
    });
    assert.equal(result.verdict, 'proposal_opened');
    assert.equal(result.tier, 'B');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
    assert.match(result.reason, /approval required/i);
  });

  it('Tier B path rejects when replay verdict is reject', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: makeReplay('reject'),
      client,
    });
    assert.equal(result.verdict, 'rejected');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
  });

  it('Tier B path opens an approval proposal on pass_with_warning', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: makeReplay('pass_with_warning'),
      client,
    });
    assert.equal(result.verdict, 'proposal_opened');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
  });

  it('missing replay rejects before publishing a branch', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: null,
      client,
    });
    assert.equal(result.verdict, 'rejected');
    assert.equal(client.pushed.length, 0);
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
  });

  it('Tier C path always opens a proposal (banned file)', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate({ scope: 'src/cortex.js' }),
      artifacts: makeArtifacts({
        gitDiff: ' src/cortex.js | 5 ++---\n 1 file changed, 3 insertions(+), 2 deletions(-)\n',
      }),
      replay: makeReplay('pass'),
      client,
    });
    assert.equal(result.verdict, 'proposal_opened');
    assert.equal(result.tier, 'C');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
  });

  it('CI failure opens a proposal regardless of tier', async () => {
    const client = makeClient();
    client.ciOk = false;
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: makeReplay('pass'),
      client,
    });
    assert.equal(result.verdict, 'ci_failed');
    assert.equal(client.merged.length, 0);
    assert.equal(client.proposals, 1);
    assert.match(result.ciOutput ?? '', /ci failed/);
  });

  it('returns no_change when artifacts have no branch', async () => {
    const client = makeClient();
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts({ branch: null }),
      replay: null,
      client,
    });
    assert.equal(result.verdict, 'no_change');
    assert.equal(client.pushed.length, 0);
  });

  it('returns rejected when push fails', async () => {
    const client = makeClient();
    const failingClient: DeployClient = {
      ...client,
      pushBranch: async () => {
        throw new Error('no remote configured');
      },
    };
    const result = await runDeployStage({
      candidate: makeCandidate(),
      artifacts: makeArtifacts(),
      replay: makeReplay('pass'),
      client: failingClient,
    });
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /push failed/);
  });
});
