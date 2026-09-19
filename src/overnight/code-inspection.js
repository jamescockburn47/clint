import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const redact = text => text.replace(/\b(?:xox[baprs]-[\w-]+|xapp-[\w-]+|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[credential-like literal redacted]');

/** Installed source only, not credentials, state databases, arbitrary paths or published GitHub claims. */
export async function inspectOwnCode(root = ROOT) {
  const files = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !['node_modules', 'data', '__tests__'].includes(entry.name)) await walk(path);
      else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8'), name = relative(root, path).replaceAll('\\', '/');
        files.set(name, { text, sha256: hash(text), bytes: Buffer.byteLength(text), lines: text.split('\n').length });
      }
    }
  }
  await walk(root);
  const inventory = [...files].map(([path, item]) => ({ path, sha256: item.sha256, bytes: item.bytes, lines: item.lines,
    symbols: [...item.text.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g)].map(match => match[1]) }));
  return { inventory, async read(paths) {
    const result = [];
    let used = 0;
    for (const path of [...new Set(paths)]) {
      const file = files.get(path);
      if (!file || (await lstat(join(root, path))).isSymbolicLink()) throw Error('code_path_not_in_snapshot');
      if (hash(await readFile(join(root, path), 'utf8')) !== file.sha256) throw Error('code_changed_during_inspection');
      if (used + file.text.length > 180000) {
        result.push({ id: `code-${result.length}`, type: 'installed_code', path, sha256: file.sha256, coverage: 'not_read_context_budget' });
        continue;
      }
      used += file.text.length;
      const text = redact(file.text);
      result.push({ id: `code-${result.length}`, type: 'installed_code', path, sha256: file.sha256,
        coverage: 'complete_file', credentialLikeLiteralsRedacted: text !== file.text, text });
    }
    return result;
  } };
}
