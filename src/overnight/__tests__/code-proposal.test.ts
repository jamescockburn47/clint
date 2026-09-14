import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCodeProposal, assertProposalPath } from '../code-proposal.js';

test('isolated proposal compares distinct snapshots and retains a patch without altering the baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clint-code-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    await mkdir(join(dir, 'src')); await mkdir(join(dir, 'test'));
    await writeFile(join(dir, 'src', 'format.js'), 'export const format = n => `${n}s`;\n');
    await writeFile(join(dir, 'test', 'format.test.js'), '// synthetic acceptance fixture\n');
    await writeFile(join(dir, '.env'), 'DO_NOT_COPY=synthetic\n');
    git('init'); git('add', 'src', 'test');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'isolated fixture');
    const observed: string[] = [];
    const result = await createCodeProposal({ repoRoot: dir, sourcePath: 'src/format.js', problem: 'duration unit error',
      evidenceIds: ['real-fixture-event'], proposalDir: join(dir, 'proposals'), dependencies: '', harness: '',
      generate: async () => JSON.stringify({ content: 'export const format = n => `${Math.floor(n / 60)}m ${n % 60}s`;\n' }),
      evaluate: async options => {
        assert.ok(!(await readdir(options.workspace)).includes('.env'));
        observed.push(await readFile(join(options.workspace, 'src', 'format.js'), 'utf8'));
        return { ok: observed.length === 2, exitCode: observed.length === 2 ? 0 : 1, output: 'fixture verdict', image: 'fixture' };
      } });
    assert.equal(result.status, 'review_required');
    assert.notEqual(observed[0], observed[1]);
    assert.equal(await readFile(join(dir, 'src', 'format.js'), 'utf8'), observed[0]);
    assert.match(await readFile(join(result.path, 'candidate.patch'), 'utf8'), /Math.floor/);
    const proposal = JSON.parse(await readFile(join(result.path, 'proposal.json'), 'utf8'));
    assert.equal(proposal.automaticApplication, false);
    assert.equal(await readFile(join(proposal.worktree, 'src', 'format.js'), 'utf8'), observed[1]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('source policy excludes escape paths and executable authority boundaries', () => {
  for (const path of ['../src/helper.js', 'src/../config.js', 'src/config.js', 'src/overnight/improve.ts', 'test/acceptance.test.js', 'src/security.js']) {
    assert.throws(() => assertProposalPath(path), /owner_review/);
  }
});
