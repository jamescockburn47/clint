import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('archive normalizer preserves full text and rejects invented dates', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('normalize','scripts/normalize-archives.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
text='source '*1500 + chr(0x1f600)*4001
rows=list(m.chunks('s','e','i','assistant',None,text,'ref','a'*64,'role_only'))
assert ''.join(r['text'] for r in rows)==text
assert len({r['id'] for r in rows})==len(rows)
assert all(r['role']=='assistant' and r['date'] is None for r in rows)
assert all(len(r['text'].encode('utf-16-le'))//2<=4000 for r in rows)
assert m.date_value('invented') is None
assert m.date_value('2026-09-14T00:00:00Z').startswith('2026-09-14')
`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('all archive adapters preserve roles, quotations/context and source hashes end to end', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['scripts/test-normalize-archives.py'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
