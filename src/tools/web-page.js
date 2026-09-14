import { createHash } from 'node:crypto';

export function validPageRequest(offset, sourceHash) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 2000000 &&
    (sourceHash === undefined ? offset === 0 : typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash));
}

export function webPage(text, { url, finalUrl = url, offset = 0, sourceHash, sourceFingerprint,
  now = () => new Date() }) {
  const hash = createHash('sha256').update(finalUrl + '\0' + text);
  if (sourceFingerprint) hash.update('\0' + sourceFingerprint);
  const digest = hash.digest('hex');
  const source = { url, finalUrl, observedAt: now().toISOString(), sourceHash: digest,
    representation: 'extracted_text', totalCharacters: text.length };
  if (sourceHash && sourceHash !== digest) return JSON.stringify({ state: 'source_changed', ...source,
    content: null, nextOffset: 0, instruction: 'Restart at offset 0; do not combine different source versions.' });
  if (offset > text.length) return JSON.stringify({ state: 'offset_out_of_range', ...source, content: null, nextOffset: null });
  const content = text.slice(offset, offset + 8000);
  return JSON.stringify({ state: text ? 'ready' : 'empty', ...source, offset, content,
    nextOffset: offset + content.length < text.length ? offset + content.length : null,
    limitations: ['Text extraction does not establish image, attachment or dynamically rendered content.'] });
}
