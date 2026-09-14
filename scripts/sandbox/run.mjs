/** Host-confined test execution. Results require independent review: candidate code can interfere with its own test process. */
import { cpSync, mkdirSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

mkdirSync('/tmp/work', { recursive: true });
cpSync('/source', '/tmp/work', { recursive: true, dereference: false });
symlinkSync('/opt/node_modules', '/tmp/work/node_modules');
process.chdir('/tmp/work');
const discover = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? discover(path) : /\.test\.(js|mjs|ts)$/.test(path) ? [path] : [];
}) : [];
const tests = ['test', 'src', 'scripts'].flatMap(discover).sort();
if (!tests.length) throw new Error('no_tests_discovered');
const result = spawnSync(process.execPath, ['--import', '/opt/node_modules/tsx/dist/loader.mjs',
  '--test', '--test-concurrency=1', ...tests], { encoding: 'utf8', timeout: 150000,
  maxBuffer: 1024 * 1024, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', CI: '1' } });
// Only test names/counts reach persistent logs; never dump arbitrary model/test output.
for (const line of (result.stdout ?? '').split('\n')) {
  if (/^# (tests|pass|fail|cancelled|skipped|duration_ms) \d/.test(line)) console.log(line);
}
if (result.error) console.log('test_execution_failed');
process.exit(result.status ?? 1);
