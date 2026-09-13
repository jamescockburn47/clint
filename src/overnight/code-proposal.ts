/** Generate source edits as data, then test baseline and candidate in isolation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withWorktree } from './worktree.js';
import { runCodeSandbox, type SandboxResult } from './code-sandbox.js';

const git = promisify(execFile);
const MAX_SOURCE_BYTES = 24000;
export interface CodeProposalOptions {
  repoRoot: string;
  sourcePath: string;
  problem: string;
  evidenceIds: string[];
  proposalDir: string;
  dependencies: string;
  harness: string;
  generate: (system: string, input: string) => Promise<string | null>;
  evaluate?: typeof runCodeSandbox;
}

/** Source edits never include config, credentials, policies, test gates or autonomous execution code. */
export function assertProposalPath(path: string): void {
  if (!/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|ts)$/.test(path) ||
    /(?:^|\/)(?:config|constants|index|http-|channel-|auth|security|policy|permissions|output-filter|group-tool-policy|project-access|pending-action|memory|cortex|router|prompt|message-handler|scheduler|evolution|overnight|self-improve)/.test(path)) {
    throw new Error('source_path_requires_owner_review');
  }
}

async function sourceFile(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  if (relative(await realpath(root), await realpath(absolute)).startsWith('..')) throw new Error('source_escapes_workspace');
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    if ((await lstat(join(root, ...parts.slice(0, i)))).isSymbolicLink()) throw new Error('source_symlink_forbidden');
  }
  return absolute;
}

async function snapshot(root: string, destination: string): Promise<void> {
  const { stdout } = await git('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1024 * 1024 });
  for (const path of stdout.split('\0').filter(Boolean)) {
    if (!/^(src\/|test\/|scripts\/|package(?:-lock)?\.json$|tsconfig\.json$)/.test(path)) continue;
    if (/(^|\/)(?:\.env|auth_state|node_modules)(\/|$)/.test(path)) continue;
    const from = await sourceFile(root, path);
    const to = join(destination, path);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, await readFile(from));
  }
}

/** Model output cannot run commands. Retain code, exact patch and both sandbox verdicts. */
export async function createCodeProposal(opts: CodeProposalOptions): Promise<{
  status: 'review_required' | 'validation_failed'; path: string; baseline: SandboxResult; candidate: SandboxResult;
}> {
  assertProposalPath(opts.sourcePath);
  if (!opts.evidenceIds.length) throw new Error('observed_evidence_required');
  const { stdout: dirty } = await git('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: opts.repoRoot });
  if (dirty.trim()) throw new Error('baseline_has_uncommitted_changes');
  const { stdout: revision } = await git('git', ['rev-parse', 'HEAD'], { cwd: opts.repoRoot });
  const baseSha = revision.trim();
  const original = await readFile(await sourceFile(opts.repoRoot, opts.sourcePath), 'utf8');
  if (Buffer.byteLength(original) > MAX_SOURCE_BYTES) throw new Error('source_exceeds_bounded_trial');
  const raw = await opts.generate('Return only JSON {"content":"complete replacement source"}. Repair the documented failure in this one file. Do not change exports or introduce network/filesystem/process access. No shell commands or markdown.',
    JSON.stringify({ path: opts.sourcePath, problem: opts.problem, evidence: opts.evidenceIds, source: original }));
  if (!raw) throw new Error('code_generator_unavailable');
  const output: unknown = JSON.parse(raw);
  if (!output || typeof output !== 'object' || typeof (output as { content?: unknown }).content !== 'string') throw new Error('invalid_code_proposal');
  const content = (output as { content: string }).content;
  if (!content.trim() || content === original || Buffer.byteLength(content) > MAX_SOURCE_BYTES || content.split('\n').length > 300) throw new Error('invalid_or_unchanged_source');
  const id = randomUUID();
  const folder = join(opts.proposalDir, `code-${id}`);
  await mkdir(folder, { recursive: true });
  const baselineDir = join(folder, 'baseline');
  await snapshot(opts.repoRoot, baselineDir);
  const evaluate = opts.evaluate ?? runCodeSandbox;
  const baseline = await evaluate({ workspace: baselineDir, dependencies: opts.dependencies, harness: opts.harness });
  return withWorktree({ repoRoot: opts.repoRoot, baseRef: baseSha, retain: true }, async handle => {
    await writeFile(await sourceFile(handle.path, opts.sourcePath), content, 'utf8');
    const candidateDir = join(folder, 'candidate');
    await snapshot(handle.path, candidateDir);
    const candidate = await evaluate({ workspace: candidateDir, dependencies: opts.dependencies, harness: opts.harness });
    const { stdout: patch } = await git('git', ['diff', '--binary', '--', opts.sourcePath], { cwd: handle.path });
    const patchHash = createHash('sha256').update(patch).digest('hex');
    await writeFile(join(folder, 'candidate.patch'), patch, 'utf8');
    const status = candidate.ok ? 'review_required' : 'validation_failed';
    await writeFile(join(folder, 'proposal.json'), JSON.stringify({
      id, status, baseSha, patchHash, sourcePath: opts.sourcePath, evidenceIds: opts.evidenceIds,
      branch: handle.branch, worktree: handle.path, baseline, candidate,
      automaticApplication: false, reason: 'Executable source requires independent review and release approval; no candidate-specific acceptance fixture has been approved yet.',
    }, null, 2), 'utf8');
    return { status, path: folder, baseline, candidate };
  });
}
