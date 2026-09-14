import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWorktree, janitorSweep } from '../worktree.js';

// These tests stand up a fresh git repo in tmp and exercise real git worktree
// commands. They are slower than pure unit tests (~1-2s each) but the contract
// is inseparable from real git behaviour — mocking git would defeat the point.
describe('overnight/worktree', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compound-dream-wt-'));
    execSync('git init -b main', { cwd: repoRoot });
    execSync('git config user.email "test@test.test"', { cwd: repoRoot });
    execSync('git config user.name "Test"', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'file.txt'), 'initial\n');
    execSync('git add file.txt', { cwd: repoRoot });
    execSync('git commit -m init', { cwd: repoRoot });
  });

  afterEach(() => {
    try {
      execSync('git worktree prune', { cwd: repoRoot });
    } catch {
      // intentional: best-effort cleanup
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('creates a worktree, runs the callback inside it, and removes it on success', async () => {
    let cbWorktreePath = '';

    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => {
      cbWorktreePath = wt.path;
      assert.ok(existsSync(wt.path), 'worktree directory should exist during callback');
      assert.ok(existsSync(join(wt.path, 'file.txt')), 'worktree should contain repo files');
      // Modify a file inside the worktree; main checkout should be unaffected.
      writeFileSync(join(wt.path, 'file.txt'), 'modified\n');
    });

    assert.ok(!existsSync(cbWorktreePath), 'worktree should be removed after callback');
    assert.equal(readFileSync(join(repoRoot, 'file.txt'), 'utf8'), 'initial\n');
  });

  it('removes the worktree even if the callback throws', async () => {
    let cbWorktreePath = '';

    await assert.rejects(
      withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => {
        cbWorktreePath = wt.path;
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.ok(!existsSync(cbWorktreePath), 'worktree should be removed after thrown error');
  });

  it('worktrees from different calls do not collide', async () => {
    const paths: string[] = [];
    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => {
      paths.push(wt.path);
      // Force a detectable time difference so the next timestamp is unique.
      await new Promise((r) => setTimeout(r, 1100));
    });
    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => { paths.push(wt.path); });
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
  });

  describe('janitorSweep', () => {
    it('preserves worktrees whose ownership and disposal have not been established', async () => {
      // Manually create a stale worktree that never got cleaned up.
      // Use a dedicated branch so it doesn't collide with main (which is
      // already checked out in the repo root).
      const staleDir = join(repoRoot, '.worktrees', 'forge-stale');
      mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
      execSync(`git worktree add -b stale-branch "${staleDir}" main`, { cwd: repoRoot });
      assert.ok(existsSync(staleDir));

      const swept = await janitorSweep({ repoRoot });
      assert.equal(swept, 0);
      assert.ok(existsSync(staleDir));
    });

    it('returns 0 when there are no orphans', async () => {
      const swept = await janitorSweep({ repoRoot });
      assert.equal(swept, 0);
    });
  });

  it('retains successful candidate commits and workspace until review', async () => {
    let candidatePath = '', branch = '';
    await withWorktree({ repoRoot, baseRef: 'main', retain: true }, async wt => {
      candidatePath = wt.path; branch = wt.branch;
      writeFileSync(join(wt.path, 'file.txt'), 'reviewable improvement\n');
      execSync('git add file.txt', { cwd: wt.path });
      execSync('git commit -m candidate', { cwd: wt.path });
    });
    assert.ok(existsSync(candidatePath));
    assert.match(execSync(`git show ${branch}:file.txt`, { cwd: repoRoot }).toString(), /reviewable improvement/);
    assert.equal(readFileSync(join(repoRoot, 'file.txt'), 'utf8'), 'initial\n');
  });
});
