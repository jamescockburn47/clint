import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOvernightResearch } from '../overnight-research.js';

test('production research allowlist prevents private conversation text from becoming a web query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clint-research-policy-'));
  try {
    const logs = join(root, 'logs'); await mkdir(logs);
    await writeFile(join(logs, '2026-09-12_owner.jsonl'), JSON.stringify({ text: 'Private synthetic client matter, do not publish.', isBot: false }));
    const queries: string[] = [];
    const result = await runOvernightResearch({ date: '2026-09-13', logDir: logs, overnightDir: join(root, 'overnight'),
      approvedTopics: ['local agent reliability'], chooseTopics: async () => { throw new Error('private inference must not run'); },
      search: async ({ query }) => { queries.push(query); return 'Result\n   https://example.invalid/source'; },
      fetchPage: async () => 'Synthetic public research text', chat: async (_system, input) => {
        assert.ok(!input.includes('Private synthetic')); return 'Fixture synthesis, needs review';
      } });
    assert.deepEqual(queries, ['local agent reliability']);
    assert.equal(result.topics.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
