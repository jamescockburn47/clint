/** Execute untrusted candidate tests in a disposable CPU-only container, never on the host. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
export const SANDBOX_IMAGE = 'node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e';
export const SANDBOX_TIMEOUT_MS = 180000;
/** unavailable=true means the sandbox itself could not run (no Docker); it is not a test verdict. */
export interface SandboxResult { ok: boolean; exitCode: number; output: string; image: string; unavailable?: boolean }
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
  let started = false;
  try {
    started = true;
    const r = await run('docker', args, { timeout: SANDBOX_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, exitCode: 0, output: String(r.stdout), image: SANDBOX_IMAGE };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      // No Docker binary: a blocked capability, distinct from a failing candidate.
      started = false;
      return { ok: false, exitCode: 127, output: 'sandbox_unavailable:docker_not_found', image: SANDBOX_IMAGE, unavailable: true };
    }
    return { ok: false, exitCode: typeof e.code === 'number' ? e.code : 1,
      output: e.killed ? 'sandbox_timeout' : String(e.stdout ?? 'sandbox_execution_failed'), image: SANDBOX_IMAGE };
  } finally {
    // Timeout terminates the client, not necessarily the container. Remove only our UUID-owned job.
    if (started) {
      try { await run('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 10000 }); }
      catch (err) {
        const e = err as { code?: unknown; stderr?: string };
        if (e.code !== 'ENOENT' && !String(e.stderr).includes('No such container')) throw new Error('sandbox_cleanup_failed');
      }
    }
  }
}
