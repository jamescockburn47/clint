import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { queryKnowledge } from './store.js';
import { embedQuery } from './embedding.js';

export function fuseCandidates(...rankings) {
  const scores = new Map();
  for (const ranking of rankings) {
    const seen = new Set();
    let rank = 0;
    for (const row of ranking) {
      if (seen.has(row.recordKey)) continue;
      seen.add(row.recordKey);
      const prior = scores.get(row.recordKey) ?? { id: row.id, recordKey: row.recordKey, score: 0 };
      prior.score += 1 / (60 + ++rank);
      scores.set(row.recordKey, prior);
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 48);
}

export function denseWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dense-scan.js', import.meta.url),
      { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('dense_search_timeout')), 15000);
    worker.once('message', message => finish(message.ok ? null : new Error('dense_search_failed'), message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', () => finish(new Error('dense_worker_exit')));
  });
}

/** Dense ranking only selects original archive records; it does not generate facts. */
export async function hybridSearch(path, input, { embed = embedQuery, scan = denseWorker,
  densePath = join(path, '..', 'dense.sqlite'), query = queryKnowledge, exists = existsSync } = {}) {
  const args = z.object({ query: z.string().min(1).max(300) }).strict().parse(input);
  const lexical = query(path, 'candidates', args);
  if (lexical.state !== 'snapshot') return lexical;
  let dense, fallbackReason;
  if (!exists(densePath)) fallbackReason = 'dense_index_not_built';
  else {
    try {
      const vector = await embed(args.query);
      dense = await scan({ path: densePath, inputSha256: lexical.inputSha256, vector });
    } catch { fallbackReason = 'dense_search_unavailable'; }
  }
  const ranking = dense ? fuseCandidates(lexical.candidates, dense.candidates) : lexical.candidates;
  const result = query(path, 'ranked', { ids: ranking.map(row => row.id) });
  return { ...result, retrieval: { strategy: dense ? 'bm25_dense_rrf' : 'bm25',
    ...(dense ? { coverage: { mode: dense.mode, indexedChunks: dense.indexedChunks,
      totalChunks: dense.totalChunks }, model: dense.model, dimensions: dense.dimensions } : { fallbackReason }),
    interpretation: 'Ranking measures relevance, not truth. Partial dense coverage can miss unembedded records; lexical search still covers the full snapshot.' } };
}
