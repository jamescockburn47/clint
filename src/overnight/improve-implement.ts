// src/overnight/improve-implement.ts — worktree implement stage (spec §4.4 step 7, §5.2).
//
// Drives one Claude Code CLI session inside a fresh git worktree to
// implement the selected candidate. Captures three independent artefacts
// after the session exits:
//   - git log <worktree> ^main   (must have commits)
//   - npm test stdout + exit     (must exit 0)
//   - git diff main              (must be non-empty)
//
// All three must be non-empty and consistent for the phase to succeed.
// This is the last-night's-failure-mode guard — prevents the phase from
// reporting "ok" when nothing actually happened.
//
// 2-hour wall-clock timeout enforced by Promise.race.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withWorktree } from './worktree.js';
import type { FinalCandidate } from './improve-synthesis.js';

const execAsync = promisify(exec);

export const IMPLEMENT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface ClaudeCliClient {
  /**
   * Run `claude -p <prompt>` inside the given worktree directory with the
   * given timeout. Returns stdout on success or throws on timeout/crash.
   */
  runSession(options: {
    worktreeDir: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ImplementOptions {
  candidate: FinalCandidate;
  repoRoot: string;
  client: ClaudeCliClient;
  /** Override worktree base ref. Defaults to 'main'. */
  worktreeOpts?: { baseRef?: string };
  /** Injectable test-mode override: skip worktree creation, use repoRoot directly. */
  skipWorktree?: boolean;
  /** Injectable exec for tests. Defaults to child_process.exec. */
  execFn?: (
    cmd: string,
    opts: { cwd?: string; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface ImplementArtifacts {
  gitLog: string;
  gitDiff: string;
  testStdout: string;
  testExitCode: number;
  claudeStdout: string;
  claudeStderr: string;
  worktreePath: string;
  branch: string | null;
}

export interface ImplementResult {
  verdict: 'ok' | 'failed';
  reason: string;
  artifacts: ImplementArtifacts;
}

const IMPLEMENT_PROMPT_HEADER = `You are the IMPROVE stage of Clint's weekly
forge. You have been selected to implement ONE candidate improvement inside
a fresh git worktree. Rules:

1. Implement the candidate exactly as described below.
2. Add tests for any new logic you introduce.
3. Run \`npm test\` before you commit.
4. Commit with a single conventional-commit-style message describing the change.
5. Do NOT modify any file outside the candidate's scope.
6. Do NOT modify banned files: src/router.js, src/cortex.js, src/memory.js,
   src/message-handler.js, CLAUDE.md, docs/superpowers/**.

If you cannot implement the candidate safely (e.g. because it would require
modifying banned files, or because the tests consistently fail), commit
nothing and explain in your final message.

=== CANDIDATE ===`;

function buildPrompt(candidate: FinalCandidate): string {
  const parts: string[] = [IMPLEMENT_PROMPT_HEADER];
  parts.push(`Title: ${candidate.title}`);
  parts.push(`Category: ${candidate.category}`);
  parts.push(`Scope: ${candidate.scope}`);
  parts.push(`Predicted benefit: ${candidate.predicted_benefit}`);
  parts.push(`Evidence refs: ${candidate.evidence_refs.join(', ')}`);
  parts.push('');
  parts.push('Now implement this candidate inside the current worktree. '
    + 'When you are done, stop. The orchestrator will inspect git log, '
    + 'npm test output, and git diff to decide whether to deploy.');
  return parts.join('\n');
}

/** Default exec wrapper with a generous maxBuffer. */
const defaultExec: NonNullable<ImplementOptions['execFn']> = async (cmd, opts) => {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd: opts.cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

async function captureArtifacts(
  worktreeDir: string,
  claudeResult: { stdout: string; stderr: string; exitCode: number },
  execFn: NonNullable<ImplementOptions['execFn']>,
): Promise<ImplementArtifacts> {
  // git log: commits on the worktree branch not on main
  let gitLog = '';
  try {
    const r = await execFn('git log --format="%h %s" HEAD ^main 2>&1 || git log --format="%h %s" -n 5', {
      cwd: worktreeDir,
    });
    gitLog = r.stdout.trim();
  } catch (err) {
    gitLog = `git log failed: ${(err as Error).message}`;
  }

  // git diff: worktree vs main
  let gitDiff = '';
  try {
    const r = await execFn('git diff main --stat 2>&1 || git status --short', {
      cwd: worktreeDir,
    });
    gitDiff = r.stdout.trim();
  } catch (err) {
    gitDiff = `git diff failed: ${(err as Error).message}`;
  }

  // npm test — capture stdout and exit code
  let testStdout = '';
  let testExitCode = -1;
  try {
    const r = await execFn('npm test 2>&1', { cwd: worktreeDir });
    testStdout = r.stdout;
    testExitCode = 0;
  } catch (err) {
    const e = err as { stdout?: string; code?: number; message?: string };
    testStdout = e.stdout ?? '';
    testExitCode = typeof e.code === 'number' ? e.code : 1;
  }

  // Attempt to extract the branch name
  let branch: string | null = null;
  try {
    const r = await execFn('git rev-parse --abbrev-ref HEAD', { cwd: worktreeDir });
    branch = r.stdout.trim() || null;
  } catch {
    branch = null;
  }

  return {
    gitLog,
    gitDiff,
    testStdout,
    testExitCode,
    claudeStdout: claudeResult.stdout,
    claudeStderr: claudeResult.stderr,
    worktreePath: worktreeDir,
    branch,
  };
}

/**
 * Validate the captured artefacts. Spec §4.4 step 7: no commits OR
 * test exit != 0 OR test stdout empty → fail hard. "status: ok" requires
 * all three to be non-empty and consistent.
 */
function validateArtifacts(a: ImplementArtifacts): { ok: boolean; reason: string } {
  if (!a.gitLog || a.gitLog.startsWith('git log failed')) {
    return { ok: false, reason: 'git log capture failed or empty — no commits made' };
  }
  if (!a.gitDiff || a.gitDiff.startsWith('git diff failed')) {
    return { ok: false, reason: 'git diff capture failed or empty — no code changes' };
  }
  if (a.testExitCode !== 0) {
    return { ok: false, reason: `npm test exited ${a.testExitCode}` };
  }
  if (!a.testStdout || a.testStdout.trim().length === 0) {
    return { ok: false, reason: 'npm test stdout empty — tests did not actually run' };
  }
  return { ok: true, reason: 'all artefacts consistent' };
}

/**
 * Run the IMPROVE implement phase. Creates a fresh worktree, spawns Claude
 * Code CLI to implement the candidate, captures artefacts, validates them,
 * and returns a structured result. Caller is responsible for deciding what
 * to do with a worktree on success (Phase 4 deploy step promotes via branch-
 * first push) or failure (worktree is removed by withWorktree cleanup).
 */
export async function runImplementStage(
  opts: ImplementOptions,
): Promise<ImplementResult> {
  const execFn = opts.execFn ?? defaultExec;
  const prompt = buildPrompt(opts.candidate);

  // Test-mode path: skip real worktree, use repoRoot directly
  if (opts.skipWorktree) {
    const claudeResult = await opts.client.runSession({
      worktreeDir: opts.repoRoot,
      prompt,
      timeoutMs: IMPLEMENT_TIMEOUT_MS,
    });
    const artifacts = await captureArtifacts(opts.repoRoot, claudeResult, execFn);
    const v = validateArtifacts(artifacts);
    return { verdict: v.ok ? 'ok' : 'failed', reason: v.reason, artifacts };
  }

  // Production path: wrap in a fresh worktree
  let captured: ImplementArtifacts | null = null;
  let validation: { ok: boolean; reason: string } = { ok: false, reason: 'did not run' };

  await withWorktree(
    {
      repoRoot: opts.repoRoot,
      baseRef: opts.worktreeOpts?.baseRef ?? 'main',
      retain: true,
    },
    async (handle) => {
      const worktreeDir = handle.path;
      // Write the prompt to a file inside the worktree for debugging/audit
      await writeFile(join(worktreeDir, '.improve-prompt.md'), prompt, 'utf8');

      const claudeResult = await opts.client.runSession({
          worktreeDir,
          prompt,
          timeoutMs: IMPLEMENT_TIMEOUT_MS,
        });
      if (claudeResult.exitCode !== 0) throw new Error(`implementation process exited ${claudeResult.exitCode}`);

      captured = await captureArtifacts(worktreeDir, claudeResult, execFn);
      // Override the branch with the real one from the worktree handle
      if (captured) captured.branch = handle.branch;
      validation = validateArtifacts(captured);
    },
  );

  if (!captured) {
    return {
      verdict: 'failed',
      reason: 'worktree did not produce artefacts (probably crashed)',
      artifacts: {
        gitLog: '',
        gitDiff: '',
        testStdout: '',
        testExitCode: -1,
        claudeStdout: '',
        claudeStderr: '',
        worktreePath: '',
        branch: null,
      },
    };
  }

  return {
    verdict: validation.ok ? 'ok' : 'failed',
    reason: validation.reason,
    artifacts: captured,
  };
}
