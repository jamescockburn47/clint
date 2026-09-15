import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, chmodSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backgroundEmbeddingAllowed } from '../src/knowledge/background-admission.js';
import { embedText, passageSegments, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
  QUERY_INSTRUCTION, verifyEmbeddingRuntime } from '../src/knowledge/embedding.js';

/** Resumable derived index. Commit each complete source chunk atomically, never edit source. */
export async function buildDenseKnowledge(sourcePath, targetPath, { embed = embedText, segment = passageSegments,
  maxChunks = 1000, maxSeconds = 900, yieldMs = 100, admit = async () => true, now = Date.now } = {}) {
  if (resolve(sourcePath) === resolve(targetPath)) throw new Error('index_cannot_replace_source');
  if (!existsSync(sourcePath)) throw new Error('archive_missing');
  if (existsSync(targetPath)) {
    const sourceStat = statSync(sourcePath), targetStat = statSync(targetPath);
    if (realpathSync(sourcePath) === realpathSync(targetPath) ||
        sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) throw new Error('index_cannot_replace_source');
  }
  if (embed === embedText) await verifyEmbeddingRuntime();
  const archiveHash = createHash('sha256');
  for await (const bytes of createReadStream(sourcePath)) archiveHash.update(bytes);
  const archiveSha256 = archiveHash.digest('hex');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const target = new DatabaseSync(targetPath);
  chmodSync(targetPath, 0o600);
  const start = now();
  let embedded = 0, segments = 0;
  try {
    const input = Object.fromEntries(source.prepare('SELECT key,value FROM metadata').all().map(r => [r.key, JSON.parse(r.value)]));
    if (input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.inputSha256)) throw new Error('archive_metadata_invalid');
    const meta = { version: 1, inputSha256: input.inputSha256, archiveSha256, model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS, queryInstruction: QUERY_INSTRUCTION,
      totalChunks: source.prepare('SELECT count(*) AS n FROM records').get().n };
    target.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,recordKey TEXT NOT NULL,textSha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors(id TEXT NOT NULL,segment INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,segment));`);
    for (const [key, value] of Object.entries(meta)) {
      const existing = target.prepare('SELECT value FROM metadata WHERE key=?').get(key);
      if (existing && existing.value !== JSON.stringify(value)) throw new Error('dense_index_mismatch');
      target.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run(key, JSON.stringify(value));
    }
    // Long records first, then stable IDs. Missing parts of partial builds remain in lexical search.
    for (const row of source.prepare('SELECT * FROM records ORDER BY (parts>3) DESC,id').iterate()) {
      if (embedded >= maxChunks || now() - start >= maxSeconds * 1000) break;
      const existing = target.prepare('SELECT * FROM chunks WHERE id=?').get(row.id);
      if (existing) {
        if (existing.textSha256 !== createHash('sha256').update(row.text).digest('hex') ||
            existing.recordKey !== JSON.stringify([row.source, row.episode, row.reference])) throw new Error('dense_index_mismatch');
        continue;
      }
      if (!await admit()) break;
      const pieces = await segment(row.text);
      if (!pieces.length || pieces.join('') !== row.text) throw new Error('segmentation_changed_source');
      const vectors = [];
      for (const piece of pieces) {
        const vector = await embed(piece);
        if (vector.length !== EMBEDDING_DIMENSIONS || vector.some(n => !Number.isFinite(n))) throw new Error('invalid_embedding');
        const buffer = Buffer.alloc(vector.length * 4);
        vector.forEach((n, i) => buffer.writeFloatLE(n, i * 4));
        vectors.push(buffer);
      }
      target.exec('BEGIN IMMEDIATE');
      try {
        target.prepare('INSERT INTO chunks VALUES(?,?,?)').run(row.id,
          JSON.stringify([row.source, row.episode, row.reference]), createHash('sha256').update(row.text).digest('hex'));
        vectors.forEach((vector, index) => target.prepare('INSERT INTO vectors VALUES(?,?,?)').run(row.id, index, vector));
        target.exec('COMMIT');
      } catch (error) { target.exec('ROLLBACK'); throw error; }
      embedded++; segments += vectors.length;
      if (yieldMs) await new Promise(resolve => setTimeout(resolve, yieldMs));
    }
    const indexedChunks = target.prepare('SELECT count(*) AS n FROM chunks').get().n;
    return { state: indexedChunks === meta.totalChunks ? 'complete' : 'partial', indexedChunks,
      totalChunks: meta.totalChunks, addedChunks: embedded, addedSegments: segments, seconds: (now() - start) / 1000,
      inputSha256: meta.inputSha256, model: meta.model, dimensions: meta.dimensions };
  } finally { target.close(); source.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [source, target, count = '1000'] = process.argv.slice(2);
    if (!source || !target || !/^\d{1,5}$/.test(count) || +count < 1 || +count > 10000) throw new Error('invalid_arguments');
    await verifyEmbeddingRuntime();
    console.log(JSON.stringify(await buildDenseKnowledge(source, target, { maxChunks: +count, admit: backgroundEmbeddingAllowed })));
  } catch (error) {
    const known = ['invalid_arguments', 'embedding_runtime_mismatch', 'embedding_unavailable',
      'invalid_tokenizer_result', 'invalid_embedding_count', 'invalid_embedding', 'invalid_embedding_norm',
      'archive_metadata_invalid', 'dense_index_mismatch', 'segmentation_changed_source'];
    console.error(JSON.stringify({ state: 'failed', errorType: error.name,
      reason: known.includes(error.message) ? error.message : 'index_build_failed' }));
    process.exitCode = 1;
  }
}
