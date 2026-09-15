import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, QUERY_INSTRUCTION } from './embedding.js';

/** Exact cosine scan on a worker: no ANN approximation, model load or private text output. */
export function scanDense({ path, inputSha256, vector, limit = 48 }) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(r => [r.key, JSON.parse(r.value)]));
    if (meta.version !== 1 || meta.inputSha256 !== inputSha256 || meta.dimensions !== EMBEDDING_DIMENSIONS ||
        meta.model !== EMBEDDING_MODEL || meta.queryInstruction !== QUERY_INSTRUCTION) throw new Error('dense_index_mismatch');
    const total = db.prepare('SELECT count(*) AS n FROM chunks').get().n;
    const status = { mode: total === meta.totalChunks ? 'dense_complete' : 'dense_partial',
      indexedChunks: total, totalChunks: meta.totalChunks, model: meta.model, dimensions: meta.dimensions };
    if (!vector) return { ...status, candidates: [] };
    if (vector.length !== EMBEDDING_DIMENSIONS || vector.some(n => !Number.isFinite(n))) throw new Error('invalid_query_vector');
    const best = new Map();
    for (const row of db.prepare('SELECT v.id,c.recordKey,v.vector FROM vectors v JOIN chunks c ON c.id=v.id').iterate()) {
      if (row.vector.byteLength !== EMBEDDING_DIMENSIONS * 4) throw new Error('invalid_index_vector');
      const bytes = row.vector.byteOffset % 4 ? Uint8Array.from(row.vector) : row.vector;
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, EMBEDDING_DIMENSIONS);
      let score = 0;
      for (let i = 0; i < values.length; i++) score += values[i] * vector[i];
      if (!Number.isFinite(score)) throw new Error('invalid_index_score');
      const prior = best.get(row.recordKey);
      if (!prior || score > prior.score || score === prior.score && row.id < prior.id) {
        best.set(row.recordKey, { id: row.id, recordKey: row.recordKey, score });
      }
    }
    return { ...status, candidates: [...best.values()].sort((a, b) => b.score - a.score ||
      a.id.localeCompare(b.id)).slice(0, limit).map(({ score, ...row }) => row) };
  } finally { db.close(); }
}

if (parentPort && workerData) {
  try { parentPort.postMessage({ ok: true, result: scanDense(workerData) }); }
  catch { parentPort.postMessage({ ok: false }); }
}
