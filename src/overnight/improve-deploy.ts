// src/overnight/improve-deploy.ts — branch-first deploy for IMPROVE (spec §5.3).
//
// Takes the artefacts from runImplementStage, classifies the change using
// tiering.ts, pushes the branch, runs CI, and always opens an approval proposal.
// No overnight-generated branch merges automatically; James approves explicitly.

import { classifyTier, type Tier, type TierClassification, type DiffSummary } from './tiering.js';
import type { FinalCandidate } from './improve-synthesis.js';
import type { ImplementArtifacts } from './improve-implement.js';
import type { RollingReplayResult } from './improve-replay.js';

/**
 * Parse a `git diff main --stat` output into a DiffSummary. Example input:
 *   " src/cortex.js    | 20 ++++++++++--------\n 2 files changed, 15 insertions(+), 5 deletions(-)\n"
 */
export function parseGitDiffStat(diffOutput: string): DiffSummary {
  const filesChanged: string[] = [];
  let linesChanged = 0;

  const lines = diffOutput.split('\n');
  for (const line of lines) {
    // Summary line: "2 files changed, 15 insertions(+), 5 deletions(-)"
    const summaryMatch = line.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
    if (summaryMatch) {
      linesChanged += parseInt(summaryMatch[1]!, 10) + parseInt(summaryMatch[2]!, 10);
      continue;
    }
    // Inline insertions/deletions-only summary
    const insertOnly = line.match(/(\d+) insertions?\(\+\)/);
    if (insertOnly && !summaryMatch) {
      linesChanged += parseInt(insertOnly[1]!, 10);
    }
    // File line: " path/to/file.js | 20 ++++++--"
    const fileMatch = line.match(/^\s*([^\s|]+)\s*\|\s*\d+/);
    if (fileMatch) {
      const path = fileMatch[1]!.trim();
      if (path && !filesChanged.includes(path)) {
        filesChanged.push(path);
      }
    }
  }

  return { filesChanged, linesChanged };
}

export type DeployVerdict =
  | 'proposal_opened'
  | 'rejected'
  | 'ci_failed'
  | 'no_change';

export interface DeployClient {
  /**
   * Push the worktree's branch to origin/<branchName>. Returns the pushed
   * branch ref on success, throws on failure.
   */
  pushBranch(branchName: string, worktreeDir: string): Promise<string>;
  /**
   * Run the branch-first CI script (scripts/forge-ci.sh) against the pushed
   * branch. Returns { ok: boolean, output: string }.
   */
  runCi(branchRef: string): Promise<{ ok: boolean; output: string }>;
  /**
   * Retained for older callers; proposal-only deploys must not call this.
   */
  mergeBranch(branchRef: string): Promise<void>;
  /**
   * Open a DM proposal card to James summarising the candidate, artefacts,
   * and CI output. Called for Tier C or any gate failure.
   */
  openProposal(payload: {
    candidate: FinalCandidate;
    tier: Tier;
    artifacts: ImplementArtifacts;
    replay: RollingReplayResult | null;
    ciOutput: string | null;
    reason: string;
  }): Promise<void>;
}

export interface DeployOptions {
  candidate: FinalCandidate;
  artifacts: ImplementArtifacts;
  replay: RollingReplayResult | null;
  client: DeployClient;
  /** Injectable classifier for tests. Defaults to tiering.classifyTier. */
  classifier?: (diff: DiffSummary) => TierClassification;
}

export interface DeployResult {
  verdict: DeployVerdict;
  tier: Tier;
  branchRef: string | null;
  reason: string;
  ciOutput: string | null;
}

/**
 * Run the deploy stage. Classifies, pushes, runs CI, and either merges
 * or opens a proposal card depending on tier and gate results.
 */
export async function runDeployStage(opts: DeployOptions): Promise<DeployResult> {
  const classifier = opts.classifier ?? classifyTier;
  const diff = parseGitDiffStat(opts.artifacts.gitDiff);
  const tierResult = classifier(diff);
  if (opts.artifacts.branch && (!opts.replay || ['blocked', 'skipped', 'reject'].includes(opts.replay.verdict))) {
    await opts.client.openProposal({ candidate: opts.candidate, tier: tierResult.tier,
      artifacts: opts.artifacts, replay: opts.replay, ciOutput: null,
      reason: 'Validation blocked: candidate replay is missing, incomplete or rejected. No publication.' });
    return { verdict: 'rejected', tier: tierResult.tier, branchRef: opts.artifacts.branch,
      reason: 'candidate replay not established', ciOutput: null };
  }

  if (!opts.artifacts.branch) {
    return {
      verdict: 'no_change',
      tier: tierResult.tier,
      branchRef: null,
      reason: 'no branch to deploy (artifacts.branch is null)',
      ciOutput: null,
    };
  }

  // Push the worktree branch to origin
  let pushedRef: string;
  try {
    pushedRef = await opts.client.pushBranch(
      opts.artifacts.branch,
      opts.artifacts.worktreePath,
    );
  } catch (err) {
    return {
      verdict: 'rejected',
      tier: tierResult.tier,
      branchRef: null,
      reason: `push failed: ${(err as Error).message}`,
      ciOutput: null,
    };
  }

  // Run CI against the pushed branch
  const ci = await opts.client.runCi(pushedRef);
  if (!ci.ok) {
    await opts.client.openProposal({
      candidate: opts.candidate,
      tier: tierResult.tier,
      artifacts: opts.artifacts,
      replay: opts.replay,
      ciOutput: ci.output,
      reason: 'CI failed — candidate requires manual review',
    });
    return {
      verdict: 'ci_failed',
      tier: tierResult.tier,
      branchRef: pushedRef,
      reason: 'CI failed',
      ciOutput: ci.output,
    };
  }

  const openApprovalProposal = async (reason: string): Promise<DeployResult> => {
    await opts.client.openProposal({
      candidate: opts.candidate,
      tier: tierResult.tier,
      artifacts: opts.artifacts,
      replay: opts.replay,
      ciOutput: ci.output,
      reason,
    });
    return {
      verdict: 'proposal_opened',
      tier: tierResult.tier,
      branchRef: pushedRef,
      reason,
      ciOutput: ci.output,
    };
  };

  // Tier gate. Even green Tier A/B branches require James's WhatsApp approval.
  switch (tierResult.tier) {
    case 'A': {
      return openApprovalProposal('approval required: Tier A branch passed CI');
    }
    case 'B': {
      // Source changes still need replay, but a pass only opens an approval proposal.
      if (!opts.replay) {
        await opts.client.openProposal({
          candidate: opts.candidate,
          tier: 'B',
          artifacts: opts.artifacts,
          replay: null,
          ciOutput: ci.output,
          reason: 'Tier B requires replay regression check but none was run',
        });
        return {
          verdict: 'proposal_opened',
          tier: 'B',
          branchRef: pushedRef,
          reason: 'no replay run',
          ciOutput: ci.output,
        };
      }
      if (opts.replay.verdict === 'reject') {
        await opts.client.openProposal({
          candidate: opts.candidate,
          tier: 'B',
          artifacts: opts.artifacts,
          replay: opts.replay,
          ciOutput: ci.output,
          reason: `replay regression check rejected: ${opts.replay.worseCount} worse judgments`,
        });
        return {
          verdict: 'rejected',
          tier: 'B',
          branchRef: pushedRef,
          reason: 'replay regression',
          ciOutput: ci.output,
        };
      }
      if (opts.replay.verdict === 'pass_with_warning') {
        return openApprovalProposal(
          `approval required: Tier B replay passed with warning (${opts.replay.warning ?? 'unknown'})`,
        );
      }
      // verdict === 'pass' or 'skipped'
      return openApprovalProposal('approval required: Tier B branch passed CI + replay');
    }
    case 'C': {
      // Always open a proposal — never auto-merge
      await opts.client.openProposal({
        candidate: opts.candidate,
        tier: 'C',
        artifacts: opts.artifacts,
        replay: opts.replay,
        ciOutput: ci.output,
        reason: `Tier C (${tierResult.reason}) — manual review required`,
      });
      return {
        verdict: 'proposal_opened',
        tier: 'C',
        branchRef: pushedRef,
        reason: tierResult.reason,
        ciOutput: ci.output,
      };
    }
  }
}
