/** Build a NEW private snapshot from normalized JSONL. Never modifies source or replaces an existing DB. */
import { createReadStream, existsSync, mkdirSync, unlinkSync, chmodSync, linkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { initializeKnowledge, sourceRecord } from '../src/knowledge/store.js';

export async function buildKnowledge(input, destination, now = new Date()) {
  if (existsSync(destination)) throw new Error('knowledge_destination_exists');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.' + randomUUID() + '.partial';
  const db = new DatabaseSync(temporary);
  chmodSync(temporary, 0o600);
  let count = 0;
  const digest = createHash('sha256');
  try {
    initializeKnowledge(db);
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const r = sourceRecord.parse(JSON.parse(line));
      insert.run(r.id, r.source, r.episode, r.role, r.date, r.text, r.reference,
        r.sourceHash, r.attribution, r.part, r.parts);
      digest.update(line + '\n'); count++;
    }
    if (!count) throw new Error('knowledge_empty_source');
    db.exec("INSERT INTO lookup(lookup) VALUES('rebuild')");
    const add = db.prepare('INSERT INTO metadata VALUES(?,?)');
    for (const [key, value] of Object.entries({ version: 1, records: count,
      recordedAt: now.toISOString(), inputSha256: digest.digest('hex') })) add.run(key, JSON.stringify(value));
    db.exec('COMMIT');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('knowledge_integrity_failure');
    db.close();
    // Atomic publication without overwriting a previous snapshot, even under overlapping runs.
    linkSync(temporary, destination);
    return { records: count, destination };
  } finally {
    try { db.close(); } catch { /* already closed after successful validation */ }
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(await buildKnowledge(process.argv[2], process.argv[3]))); }
  catch { console.error('knowledge_build_failed'); process.exitCode = 1; }
}
