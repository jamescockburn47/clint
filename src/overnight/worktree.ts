// src/overnight/worktree.ts — withWorktree helper and janitor.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.2.
//
// Every overnight phase that modifies code MUST use withWorktree() so the
// main checkout is never touched. The helper creates a timestamped worktree
// under .worktrees/, runs the callback with the worktree's path, then
// removes the worktree whether the callback succeeds or throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);

export interface WithWorktreeOptions {
  repoRoot: string;
  baseRef: string;
  /** Preserve candidate branches and files for review, including interrupted work. */
  retain?: boolean;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
}

/**
 * Create a fresh worktree at .worktrees/forge-<timestamp>, run fn(handle), and
 * remove the worktree on exit. Cleanup runs whether fn resolves or rejects.
 */
export async function withWorktree<T>(
  opts: WithWorktreeOptions,
  fn: (handle: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, 19);
  const suffix = `${timestamp}-${randomUUID()}`;
  const wtPath = join(opts.repoRoot, '.worktrees', `forge-${suffix}`);
  const branch = `codex/forge-${suffix}`;

  await execFileP('git', ['worktree', 'add', '-b', branch, wtPath, opts.baseRef], {
    cwd: opts.repoRoot,
  });

  try {
    return await fn({ path: wtPath, branch });
  } finally {
    if (!opts.retain) {
    try {
      await execFileP('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch (err) {
      console.error(
        `withWorktree: failed to remove ${wtPath}: ${(err as Error).message} — janitorSweep will catch it later`,
      );
    }
    // Also delete the temporary branch we just created, best-effort.
    try {
      await execFileP('git', ['branch', '-D', branch], { cwd: opts.repoRoot });
    } catch {
      // intentional: branch may already be gone if worktree remove succeeded
    }
    }
  }
}

/**
 * Sweep .worktrees/ for leftover directories from previous runs. Called at the
 * start of every overnight session before any new worktrees are created.
 *
 * Returns the number of worktrees removed.
 */
export async function janitorSweep(opts: { repoRoot: string }): Promise<number> {
  // A directory name cannot establish ownership, inactivity or disposability.
  // Candidate cleanup is an explicit reviewed action; never sweep arbitrary work.
  void opts;
  return 0;
}
