/** Execute untrusted candidate tests in a disposable CPU-only container, never on the host. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
export const SANDBOX_IMAGE = 'node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e';
export const SANDBOX_TIMEOUT_MS = 180000;
export interface SandboxResult { ok: boolean; exitCode: number; output: string; image: string }
export interface SandboxOptions {
  workspace: string;
  dependencies: string;
  harness: string;
  execute?: typeof execute;
}

/** No network, GPU, host credentials, Docker socket, writable host mounts or elevated capabilities. */
export async function runCodeSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const run = options.execute ?? execute;
  const [workspace, dependencies, harness] = await Promise.all([
    realpath(options.workspace), realpath(options.dependencies), realpath(options.harness),
  ]);
  for (const path of [workspace, dependencies, harness]) {
    if (path.includes(',') || /[\r\n]/.test(path)) throw new Error('unsupported sandbox mount path');
  }
  const name = `clint-check-${randomUUID()}`;
  const args = ['run', '--rm', '--name', name, '--network=none', '--read-only', '--user=1000:1000',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--memory-swap=2g', '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000',
    '--mount', `type=bind,source=${workspace},target=/source,readonly`,
    '--mount', `type=bind,source=${dependencies},target=/opt/node_modules,readonly`,
    '--mount', `type=bind,source=${harness},target=/harness,readonly`,
    '--env=HOME=/tmp', '--env=CI=1', '--workdir=/tmp', SANDBOX_IMAGE,
    'node', '/harness/run.mjs'];
  try {
    const r = await run('docker', args, { timeout: SANDBOX_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, exitCode: 0, output: String(r.stdout), image: SANDBOX_IMAGE };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; killed?: boolean };
    return { ok: false, exitCode: typeof e.code === 'number' ? e.code : 1,
      output: e.killed ? 'sandbox_timeout' : String(e.stdout ?? 'sandbox_execution_failed'), image: SANDBOX_IMAGE };
  } finally {
    // Timeout terminates the client, not necessarily the container. Remove only our UUID-owned job.
    try { await run('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 10000 }); }
    catch (err) {
      const e = err as { stderr?: string };
      if (!String(e.stderr).includes('No such container')) throw new Error('sandbox_cleanup_failed');
    }
  }
}
