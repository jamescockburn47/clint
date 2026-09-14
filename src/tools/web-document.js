import { createHash } from 'node:crypto';
import { extractDocument } from './document-extract.js';
import { webPage } from './web-page.js';

/** The existing isolated worker receives only bounded bytes and a supported MIME type. */
export async function webDocument(body, mime, options, { extract = extractDocument } = {}) {
  const rawSha256 = createHash('sha256').update(body).digest('hex');
  const extracted = await extract(body, mime);
  if (extracted.state !== 'extracted') return JSON.stringify({ state: 'unavailable',
    url: options.url, finalUrl: options.finalUrl, observedAt: new Date().toISOString(),
    rawSha256, content: null, error: extracted.error });
  const page = JSON.parse(webPage(extracted.content, { ...options,
    sourceFingerprint: rawSha256 + '\0' + extracted.representation }));
  const details = {};
  for (const key of ['representation', 'completeExtraction', 'pageCount', 'ocrPages', 'unreadPages',
    'sheets', 'dateSystem', 'limitations']) {
    if (extracted[key] !== undefined) details[key] = extracted[key];
  }
  return JSON.stringify({ ...page, ...details, rawSha256, contentType: mime });
}
