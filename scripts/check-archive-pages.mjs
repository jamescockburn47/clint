import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { queryKnowledge } from '../src/knowledge/store.js';
import { boundToolResult } from '../src/tool-result.js';

const path = process.argv[2];
if (!path) throw new Error('archive_path_required');
const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = hash(), start = performance.now();
const db = new DatabaseSync(path, { readOnly: true });
const records = db.prepare('SELECT id,source,episode,reference FROM records WHERE part=0 AND parts>3').all();
let pages = 0, maxPageChars = 0, maxRecordParts = 0;
for (const row of records) {
  const expected = db.prepare('SELECT text FROM records WHERE source=? AND episode=? AND reference=? ORDER BY part,id')
    .all(row.source, row.episode, row.reference).map(r => r.text).join('');
  let input = { id: row.id }, output = '', consumed = 0;
  while (input) {
    const raw = queryKnowledge(path, 'record', input);
    const result = JSON.parse(boundToolResult('knowledge_read', JSON.stringify(raw)));
    if (result.state !== 'snapshot' || result.records?.[0]?.completeness !== 'partial_indexed_record' ||
        result.page?.startPart !== consumed || result.page.completeRecordInThisResponse !== false) {
      throw new Error('archive_page_contract_failed');
    }
    output += result.records[0].text;
    consumed = result.page.endPartExclusive;
    maxPageChars = Math.max(maxPageChars, result.records[0].text.length);
    maxRecordParts = Math.max(maxRecordParts, result.page.totalParts);
    input = result.page.nextRead;
    pages++;
  }
  if (output !== expected) throw new Error('archive_page_reconstruction_failed');
}
db.close();
if (before !== hash()) throw new Error('archive_mutated');
console.log(JSON.stringify({ state: 'passed', records: records.length, pages, maxPageChars, maxRecordParts,
  archiveSha256: before, unchanged: true, seconds: (performance.now() - start) / 1000,
  boundary: 'Exact reconstruction and bounded tool delivery, not a model recall or comprehension test.' }));
