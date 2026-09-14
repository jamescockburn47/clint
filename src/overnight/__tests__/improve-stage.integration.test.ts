import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeImproveStage, type ImproveStageDeps } from '../improve.js';
import { appendObservation, type Observation } from '../probe-observations.js';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';
import type { ImplementResult } from '../improve-implement.js';
import type { DeployResult } from '../improve-deploy.js';

const RUN_DATE = '2026-04-27';
const RUN_WEEK = '2026-W18';

const FINAL_CANDIDATES = `[
  {
    "id": "c1",
    "title": "Add local telemetry smoke test",
    "category": "quality",
    "scope": "src/request-id.js",
    "evidence_refs": ["obs:telemetry-a", "obs:telemetry-b"],
    "predicted_benefit": "catches local Qwen observability regressions before deploy"
  }
]`;

function makeImplementResult(overrides: Partial<ImplementResult> = {}): ImplementResult {
  return {
    verdict: 'ok',
    reason: 'all artefacts consistent',
    artifacts: {
      gitLog: 'abc123 feat: add local telemetry smoke test',
      gitDiff: ' src/request-id.js | 20 ++++++++++++++++++++\n',
      testStdout: 'all tests passed',
      testExitCode: 0,
      claudeStdout: 'implemented',
      claudeStderr: '',
      worktreePath: '/tmp/worktree',
      branch: 'forge/wt-test',
    },
    ...overrides,
  };
}

function makeDeployResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return {
    verdict: 'proposal_opened',
    tier: 'B',
    reason: 'approval required: green CI and replay',
    branchRef: 'origin/forge/wt-test',
    ciOutput: null,
    ...overrides,
  };
}

function makeDeps(tmpRoot: string, evoResponse = FINAL_CANDIDATES): ImproveStageDeps {
  return {
    overnightDir: join(tmpRoot, 'overnight'),
    logDir: join(tmpRoot, 'logs'),
    repoRoot: tmpRoot,
    evoChatClient: { chat: async () => evoResponse },
    opusClient: {
      callOpus: async () => JSON.stringify({
        selected_id: 'c1',
        rationale: 'best evidence-backed candidate',
        objections_considered: 'small test-only scope',
      }),
    },
    claudeCliClient: {
      runSession: async () => ({ stdout: 'unused', stderr: '', exitCode: 0 }),
    },
    replayPairClient: {
      replayAgainstMain: async () => 'main response',
      replayAgainstWorktree: async () => 'better worktree response',
    },
    replayGrader: {
      grade: async () => ({ judged: 'better', reason: 'more precise' }),
    },
    deployClient: {
      pushBranch: async () => 'origin/forge/wt-test',
      runCi: async () => ({ ok: true, output: 'ok' }),
      mergeBranch: async () => {},
      openProposal: async () => {},
    },
  };
}

async function seedImproveObservations(overnightDir: string): Promise<void> {
  const observations: Observation[] = [
    {
      kind: 'candidate',
      date: RUN_DATE,
      title: 'Add local telemetry smoke test',
      category: 'quality',
      predicted_benefit: 'catch local Qwen observability regressions',
      scope: 'src/request-id.js',
      rough_cost: 'small',
      evidence_refs: ['obs:telemetry-a', 'obs:telemetry-b'],
      weight: 4,
    },
    {
      kind: 'pattern',
      date: RUN_DATE,
      observation: 'qwen telemetry requests need smoke coverage',
      evidence_refs: ['trace:qwen-a', 'trace:qwen-b'],
      weight: 3,
    },
    {
      kind: 'pattern',
      date: RUN_DATE,
      observation: 'qwen telemetry endpoint needs authenticated smoke coverage',
      evidence_refs: ['trace:qwen-c', 'trace:qwen-d'],
      weight: 3,
    },
    {
      kind: 'candidate',
      date: RUN_DATE,
      title: 'Improve recall trajectory smoke test',
      category: 'quality',
      predicted_benefit: 'memory_search drift caught earlier',
      scope: 'src/reasoning-trace.js',
      rough_cost: 'small',
      evidence_refs: ['obs:recall-a', 'obs:recall-b'],
      weight: 3,
    },
    {
      kind: 'drift',
      date: RUN_DATE,
      original_timestamp: `${RUN_DATE}T10:00:00Z`,
      input_hash: 'sha256:drift1',
      diff_summary: 'response lost memory citation',
      judged: 'worse',
      reason: 'memory recall got weaker',
      evidence_refs: ['sha256:drift1'],
      weight: 5,
    },
  ];

  for (const observation of observations) {
    await appendObservation(observation, { isoWeek: RUN_WEEK, overnightDir });
  }
}

async function runImprove(
  deps: ImproveStageDeps,
  options: Parameters<typeof makeImproveStage>[1] = {},
): Promise<Awaited<ReturnType<typeof queryEvents>>> {
  const runner = new OvernightRunner({
    mode: 'emergency',
    date: RUN_DATE,
    overnightDir: deps.overnightDir,
    repoRoot: deps.repoRoot,
    skipJanitor: true,
  });
  runner.register('improve', makeImproveStage(deps, { emergencyMode: true, ...options }));
  await runner.run(['improve']);
  return queryEvents({ date: RUN_DATE, overnightDir: deps.overnightDir, stage: 'improve' });
}

describe('overnight/improve full-stage orchestration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-improve-stage-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('records the happy-path phase sequence from grooming through deploy', async () => {
    const deps = makeDeps(tmpRoot);
    await seedImproveObservations(deps.overnightDir);

    const events = await runImprove(deps, {
      runImplement: async () => makeImplementResult(),
      sampleHistoricalExchanges: async () => [
        {
          userInput: 'what did we decide about Qwen?',
          botResponse: 'we decided to use Qwen locally',
          original_timestamp: `${RUN_DATE}T10:00:00Z`,
          inputHash: 'sha256:sample1',
        },
      ],
      runDeploy: async () => makeDeployResult(),
    });

    assert.deepEqual(events.map((event) => event.phase), [
      'groom',
      'synthesis',
      'opus-select',
      'implement',
      'replay',
      'deploy',
    ]);
    assert.equal(events.at(-1)?.verdict, 'ok');
    assert.equal(events.find((event) => event.phase === 'replay')?.outputs.includes('better:1'), true);
  });

  it('stops after synthesis and writes diagnostics when every candidate is rejected', async () => {
    const deps = makeDeps(tmpRoot, `[
      {"id":"bad","title":"weak evidence","category":"quality","scope":"src/x.ts","evidence_refs":["one"],"predicted_benefit":"none"}
    ]`);
    await seedImproveObservations(deps.overnightDir);

    const events = await runImprove(deps);

    assert.deepEqual(events.map((event) => event.phase), ['groom', 'synthesis']);
    const synthesis = events.find((event) => event.phase === 'synthesis');
    assert.equal(synthesis?.outputs.includes('final:0'), true);
    assert.equal(synthesis?.outputs.some((output) => output.includes('insufficient-evidence-refs=1')), true);
  });

  it('stops after Opus returns NULL without running implementation', async () => {
    const deps = makeDeps(tmpRoot);
    deps.opusClient = {
      callOpus: async () => JSON.stringify({
        selected_id: null,
        null_reason: 'none of the candidates clear the bar',
        rationale: '',
        objections_considered: '',
      }),
    };
    await seedImproveObservations(deps.overnightDir);

    const events = await runImprove(deps);

    assert.deepEqual(events.map((event) => event.phase), ['groom', 'synthesis', 'opus-select']);
    assert.equal(events.at(-1)?.verdict, 'null');
  });

  it('stops after a failed implementation and records the failed verdict', async () => {
    const deps = makeDeps(tmpRoot);
    await seedImproveObservations(deps.overnightDir);

    const events = await runImprove(deps, {
      runImplement: async () => makeImplementResult({
        verdict: 'failed',
        reason: 'npm test exited 1',
      }),
    });

    assert.deepEqual(events.map((event) => event.phase), ['groom', 'synthesis', 'opus-select', 'implement']);
    assert.equal(events.at(-1)?.verdict, 'failed');
    assert.match(events.at(-1)?.reason ?? '', /npm test exited 1/);
  });

  it('rejects after replay and does not deploy when any sample is worse', async () => {
    const deps = makeDeps(tmpRoot);
    await seedImproveObservations(deps.overnightDir);
    let deployCalls = 0;
    deps.replayGrader = {
      grade: async () => ({ judged: 'worse', reason: 'lost the memory citation' }),
    };

    const events = await runImprove(deps, {
      runImplement: async () => makeImplementResult(),
      sampleHistoricalExchanges: async () => [
        {
          userInput: 'recall this',
          botResponse: 'old response',
          original_timestamp: `${RUN_DATE}T10:00:00Z`,
          inputHash: 'sha256:worse1',
        },
      ],
      runDeploy: async () => {
        deployCalls += 1;
        return makeDeployResult();
      },
    });

    assert.deepEqual(events.map((event) => event.phase), ['groom', 'synthesis', 'opus-select', 'implement', 'replay']);
    assert.equal(events.at(-1)?.verdict, 'rejected');
    assert.equal(deployCalls, 0);
  });

  it('records a rejected deploy event when CI fails', async () => {
    const deps = makeDeps(tmpRoot);
    await seedImproveObservations(deps.overnightDir);

    const events = await runImprove(deps, {
      runImplement: async () => makeImplementResult(),
      sampleHistoricalExchanges: async () => [{ userInput: "fixture", botResponse: "baseline", original_timestamp: RUN_DATE, inputHash: "sha256:fixture" }],
      runDeploy: async () => makeDeployResult({
        verdict: 'ci_failed',
        tier: 'B',
        reason: 'ci failed: test errors',
      }),
    });

    assert.equal(events.at(-1)?.phase, 'deploy');
    assert.equal(events.at(-1)?.verdict, 'rejected');
    assert.match(events.at(-1)?.reason ?? '', /ci failed/);
  });
});
