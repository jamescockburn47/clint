import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeSandbox, SANDBOX_IMAGE } from '../code-sandbox.js';

async function withDirs(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'clint-sandbox-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a missing Docker binary is reported as unavailable and no cleanup is attempted', async () => {
  await withDirs(async dir => {
    const calls: string[][] = [];
    const execute = (async (_file: string, args: string[]) => {
      calls.push(args);
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    }) as never;
    const result = await runCodeSandbox({ workspace: dir, dependencies: dir, harness: dir, execute });
    assert.equal(result.unavailable, true);
    assert.equal(result.ok, false);
    assert.equal(result.output, 'sandbox_unavailable:docker_not_found');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], 'run');
  });
});

test('the container is always isolated, and a failing candidate is a verdict rather than unavailability', async () => {
  await withDirs(async dir => {
    const calls: string[][] = [];
    const execute = (async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'run') throw Object.assign(new Error('tests failed'), { code: 1, stdout: '# fail 2' });
      return { stdout: '', stderr: '' };
    }) as never;
    const result = await runCodeSandbox({ workspace: dir, dependencies: dir, harness: dir, execute });
    assert.equal(result.unavailable, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.output, '# fail 2');
    assert.equal(result.image, SANDBOX_IMAGE);
    const run = calls[0]!;
    for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) {
      assert.ok(run.includes(flag), `docker run must include ${flag}`);
    }
    assert.ok(run.some(arg => arg.startsWith('type=bind,') && arg.endsWith(',readonly')));
    assert.deepEqual(calls[1]!.slice(0, 2), ['rm', '-f']);
  });
});
