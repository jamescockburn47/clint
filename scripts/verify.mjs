/** Canonical test discovery: include nested JS/TS suites omitted by the old npm test. */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkFileSize } from '../hooks/checks/file-size.mjs';

const roots = ['test', 'src', 'scripts', 'hooks'];
function discover(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : discover(path);
    return /\.test\.(?:js|mjs|ts)$/.test(entry.name) ? [path] : [];
  });
}
const files = roots.flatMap(discover).sort();
if (!files.length) throw new Error('No tests discovered');
const exceptions = JSON.parse(readFileSync('hooks/legacy-source-limits.json', 'utf8'));
function checkSizes(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { checkSizes(path); continue; }
    if (!/\.(js|ts|mjs)$/.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    const warning = checkFileSize(path, text);
    const ceiling = exceptions[path.replaceAll('\\', '/')];
    if (warning && (!ceiling || text.split('\n').length > ceiling)) throw new Error(warning.message);
  }
}
checkSizes('src');
const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit', timeout: 120000 });
if (types.status !== 0) process.exit(types.status ?? 1);
console.log(`Verifying ${files.length} test files (including overnight contracts).`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', timeout: 600000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
