// Hashed-fingerprint leak guard (the canary gatekeeper, generalised): every private tool result is its own canary.
// Private text is normalised to lower-case letters and digits and fingerprinted by winnowing (Schleimer, Wilkerson and
// Aiken, 2003): k-gram hashes, keeping the minimum of every window of W. Any outbound text that shares a normalised span of
// at least K + W - 1 = 39 characters with private text shares at least one fingerprint, whatever its offset. JSON results
// are fingerprinted as their decoded strings too, so escapes cannot split a span. Outbound text is checked raw and after
// Unicode-tag, URL, base64 (every alignment) and hex (both alignments) decoding. Spans the owner typed are exempt.
// Residual, stated plainly: shorter spans (a phone number, a code); paraphrase and encodings not listed above (rot13,
// reversal, homoglyphs); pieces under 39 characters sent across turns, or within a turn with filler between them or out of
// order; and private context that never came from a tool result. Records live in memory: a restart clears them.

export const K = 24, W = 16, SPAN = K + W - 1;
const TTL_MS = 24 * 3600 * 1000, MAX_FINGERPRINTS = 400000, MAX_PRIVATE_CHARS = 600000;

export const normalise = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function hash(text, start) { // two FNV-1a passes combined into a 52-bit value (exact in a double)
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = start; i < start + K; i++) {
    const c = text.charCodeAt(i);
    a ^= c; a = Math.imul(a, 0x01000193);
    b ^= c; b = Math.imul(b, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0) * 0x100000 + ((b >>> 0) & 0xfffff);
}
export const kgramHashes = normalised => normalised.length < K ? []
  : Array.from({ length: normalised.length - K + 1 }, (_, i) => hash(normalised, i));

/** Winnowed fingerprints: the rightmost minimum hash of each window of W consecutive k-grams. */
export function fingerprints(text) {
  const hashes = kgramHashes(normalise(String(text ?? '').slice(0, MAX_PRIVATE_CHARS)));
  const out = new Set();
  if (!hashes.length) return out;
  if (hashes.length <= W) { out.add(Math.min(...hashes)); return out; }
  for (let i = 0; i + W <= hashes.length; i++) {
    let min = i;
    for (let j = i + 1; j < i + W; j++) if (hashes[j] <= hashes[min]) min = j;
    out.add(hashes[min]);
  }
  return out;
}

/** Every string inside a tool input: object keys and values, array items, numbers as text. */
export function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'bigint') out.push(String(value));
  else if (Array.isArray(value)) value.forEach(item => strings(item, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { out.push(key); strings(item, out); });
  return out;
}

/** The text and what it decodes to: Unicode tags, URL escapes (twice), base64/base64url runs at every alignment, hex runs. */
export function decodings(text) {
  // Unicode tag characters (U+E0020-E007E) can carry hidden ASCII: read them as the ASCII they encode.
  const tags = String(text).replace(/[\u{E0020}-\u{E007E}]/gu, ch => String.fromCharCode(ch.codePointAt(0) - 0xE0000));
  const out = tags === text ? [text] : [text, tags];
  let current = tags;
  for (let i = 0; i < 2; i++) {
    const next = current.replace(/(?:%[0-9a-f]{2})+/gi, run => { try { return decodeURIComponent(run); } catch { return run; } }).replace(/\+/g, ' ');
    if (next === current) break;
    out.push(current = next);
  }
  for (const source of [...out]) {
    for (const [run] of source.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
      const body = run.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
      for (let offset = 0; offset < 4; offset++) {
        // Garbage bytes before an aligned run decode to U+FFFD; normalisation drops them and the rest still matches.
        out.push(Buffer.from(body.slice(offset), 'base64').toString('utf8'));
      }
    }
    for (const [run] of source.matchAll(/[0-9a-f]{32,}/gi)) {
      for (let offset = 0; offset < 2; offset++) {
        out.push(Buffer.from(run.slice(offset, run.length - ((run.length - offset) % 2)), 'hex').toString('utf8'));
      }
    }
  }
  return out;
}

/** Private fingerprints per conversation, for 24 hours, so a later turn cannot send what an earlier turn read. */
export class LeakGuard {
  constructor({ now = Date.now } = {}) { this.now = now; this.byConversation = new Map(); this.total = 0; }

  record(conversationId, text) {
    const set = fingerprints(text);
    if (!set.size) return;
    const list = this.byConversation.get(conversationId) ?? [];
    list.push({ expires: this.now() + TTL_MS, set });
    this.byConversation.set(conversationId, list);
    this.total += set.size;
    this.prune();
  }

  /** A tool result: its text, and when it is JSON, its decoded strings joined, so escapes (\n, \uXXXX) cannot split a span. */
  recordResult(conversationId, result) {
    this.record(conversationId, result);
    try { this.record(conversationId, strings(JSON.parse(result)).join(' ')); } catch { /* not JSON: the raw text is recorded */ }
  }

  prune() {
    const now = this.now();
    const entries = [...this.byConversation].flatMap(([id, list]) => list.map(entry => ({ id, entry })))
      .sort((a, b) => a.entry.expires - b.entry.expires);
    for (const { id, entry } of entries) {
      if (entry.expires > now && this.total <= MAX_FINGERPRINTS) break;
      const list = this.byConversation.get(id);
      list.splice(list.indexOf(entry), 1);
      if (!list.length) this.byConversation.delete(id);
      this.total -= entry.set.size;
    }
  }

  /** True when any outbound text carries a private span of SPAN or more normalised characters the owner did not type. */
  leaks(conversationId, outboundTexts, ownerText = '') {
    this.prune();
    const list = this.byConversation.get(conversationId);
    if (!list?.length) return false;
    const owner = new Set(kgramHashes(normalise(ownerText)));
    for (const text of outboundTexts) {
      for (const variant of decodings(String(text))) {
        for (const h of kgramHashes(normalise(variant))) {
          if (!owner.has(h) && list.some(entry => entry.set.has(h))) return true;
        }
      }
    }
    return false;
  }
}
