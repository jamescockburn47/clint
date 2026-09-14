/** Persist attributed statements with full provenance in the existing string source field. */
import type { StoreClient } from './consolidate-store.js';
import type { MemoryCandidate } from './consolidate-validate.js';

export interface PromotedSinkDeps {
  storeMemory(fact: string, category: string, tags: string[], confidence: number, source: string):
    Promise<{ stored?: boolean; queued?: boolean; offline?: boolean; error?: string } | void>;
}
export interface PromotedSinkOptions { source?: string; chatJid?: string; deps: PromotedSinkDeps }

export class PromotedSink implements StoreClient {
  constructor(private readonly opts: PromotedSinkOptions) {}

  /** An acknowledgement is required; queued/offline writes never count as persisted. */
  async storeValidated(candidate: MemoryCandidate): Promise<void> {
    if (candidate.verification !== 'source_verified' || !candidate.sources.length || candidate.sources.some(s => !s.message_id)) {
      throw new Error('unverified_candidate_not_promotable');
    }
    if (candidate.sources.some(source => !source.chatJid?.endsWith('@g.us'))) throw new Error('private_or_unknown_source_requires_local_archive');
    const source = JSON.stringify({
      kind: this.opts.source ?? 'consolidate-extractive',
      verification: candidate.verification, factual_status: candidate.factual_status,
      version: candidate.extraction_version, sources: candidate.sources,
    });
    const speaker = candidate.sources[0]?.sender ?? 'Unidentified speaker';
    const fact = `Recorded statement by ${speaker} (unverified claim): ${JSON.stringify(candidate.text)}`;
    const result = await this.opts.deps.storeMemory(fact, candidate.category,
      ['source_verified', ...candidate.sources.map(s => `src:${s.hash}`),
        ...[...new Set(candidate.sources.map(s => s.chatJid).filter(Boolean))].map(jid => `chat:${jid}`)], 1, source);
    if (result?.error) throw new Error('memory_store_failed');
    if (!result?.stored || result.queued || result.offline) throw new Error('memory_not_persisted');
  }
}
