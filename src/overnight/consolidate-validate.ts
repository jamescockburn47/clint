// src/overnight/consolidate-validate.ts — schema validator for extracted memory candidates.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1 evidence-chain invariant.
//
// Every candidate must carry at least one source (hash + excerpt). Candidates
// that fail validation are rejected and will be written to data/overnight/rejected-<date>.jsonl
// by the store module. This is the hard schema gate for the consolidate stage.

export const MAX_EXCERPT_CHARS = 200;

export interface MemorySource {
  hash: string;     // content hash of the conversation log line, e.g. "sha256:abc..."
  excerpt: string;  // short quoted excerpt, ≤MAX_EXCERPT_CHARS
  message_id?: string;
  file?: string;
  line?: number;
  sender?: string | null;
  senderJid?: string | null;
  timestamp?: string | null;
  chatJid?: string | null;
}

export interface MemoryCandidate {
  text: string;
  category: string;
  confidence: number;
  sources: MemorySource[];
  // Optional fields the extractor may supply; not validated here.
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate one extracted memory candidate against the evidence-chain invariant.
 * Returns `{ valid: true }` or `{ valid: false, reason: "..." }` — never throws.
 */
export function validateCandidate(candidate: unknown): ValidationResult {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'not_object' };
  }
  const c = candidate as Partial<MemoryCandidate>;

  if (typeof c.text !== 'string' || c.text.length === 0) {
    return { valid: false, reason: 'text_missing_or_empty' };
  }
  if (typeof c.category !== 'string' || c.category.length === 0) {
    return { valid: false, reason: 'category_missing_or_empty' };
  }
  if (typeof c.confidence !== 'number' || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
    return { valid: false, reason: `confidence_out_of_range: ${c.confidence}` };
  }

  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    return { valid: false, reason: 'no_evidence: missing or empty sources[]' };
  }

  for (let i = 0; i < c.sources.length; i++) {
    const s = c.sources[i];
    if (!s || typeof s !== 'object') {
      return { valid: false, reason: `sources[${i}]_not_object` };
    }
    const src = s as Partial<MemorySource>;
    if (typeof src.hash !== 'string' || src.hash.length === 0) {
      return { valid: false, reason: `sources[${i}]_hash_missing_or_empty` };
    }
    if (typeof src.excerpt !== 'string' || src.excerpt.length === 0) {
      return { valid: false, reason: `sources[${i}]_excerpt_missing_or_empty` };
    }
    if (src.excerpt.length > MAX_EXCERPT_CHARS) {
      return {
        valid: false,
        reason: `sources[${i}]_excerpt_too_long: ${src.excerpt.length} exceeds ${MAX_EXCERPT_CHARS}`,
      };
    }
  }

  return { valid: true };
}
