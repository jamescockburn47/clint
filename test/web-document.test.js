import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import esmock from 'esmock';
import { fetchPublicResource, fetchPublicText } from '../src/public-web-fetch.js';
import { webDocument } from '../src/tools/web-document.js';
import { validPageRequest } from '../src/tools/web-page.js';
import { BINARY_DOCUMENT_TYPES } from '../src/tools/document-extract.js';

function transport({ mime = 'application/pdf', body = Buffer.from('%PDF synthetic'), headers = {}, status = 200 } = {}) {
  return { resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (_url, options, callback) => {
      assert.equal(options.headers.Authorization, undefined);
      const req = new EventEmitter(); req.end = () => {
        const response = Readable.from([body]); response.statusCode = status;
        response.headers = { 'content-type': mime, ...headers }; callback(response);
      }; return req;
    }, binaryTypes: BINARY_DOCUMENT_TYPES, maxBytes: 4, maxBinaryBytes: 32 };
}

test('Public binary bytes use only supported MIME limits; text compatibility cannot opt in', async () => {
  const options = transport();
  const result = await fetchPublicResource('https://example.org/report', options);
  assert.deepEqual(result.body, Buffer.from('%PDF synthetic'));
  assert.equal(result.finalUrl, 'https://example.org/report');
  await assert.rejects(fetchPublicText('https://example.org/report', options), /too_large/);
  for (const mime of ['text/plain', 'application/octet-stream', 'image/png']) {
    await assert.rejects(fetchPublicResource('https://example.org/report', transport({ mime })), /too_large/);
  }
  for (const properties of [{ body: Buffer.alloc(33) }, { headers: { 'content-length': '33' } },
    { headers: { 'content-length': 'invalid' } }]) {
    await assert.rejects(fetchPublicResource('https://example.org/report', transport(properties)), /too_large/);
  }
});

test('Partial and compressed public documents are explicitly rejected', async () => {
  for (const properties of [{ status: 206 }, { headers: { 'content-range': 'bytes 0-2/900' } }]) {
    await assert.rejects(fetchPublicResource('https://example.org/report', transport(properties)), /partial_response/);
  }
  await assert.rejects(fetchPublicResource('https://example.org/report',
    transport({ headers: { 'content-encoding': 'gzip' } })), /encoding_unsupported/);
});

test('Document pagination retains coverage and rejects changes to bytes, text, representation or URL', async () => {
  const body = Buffer.from('synthetic document bytes'), url = 'https://example.org/report.pdf';
  let text = 'Page one\n'.repeat(120000) + 'Final text.', representation = 'pdf_pages_with_optional_ocr';
  const extract = async () => ({ state: 'extracted', content: text, representation,
    pageCount: 3, ocrPages: [2], unreadPages: [3], completeExtraction: false,
    limitations: ['Page 3 not read; diagrams not interpreted.'] });
  const first = JSON.parse(await webDocument(body, 'application/pdf', { url, finalUrl: url }, { extract }));
  assert.equal(first.completeExtraction, false); assert.deepEqual(first.unreadPages, [3]);
  assert.deepEqual(first.limitations, ['Page 3 not read; diagrams not interpreted.']);
  assert.match(first.rawSha256, /^[a-f0-9]{64}$/);
  const end = JSON.parse(await webDocument(body, 'application/pdf', { url, finalUrl: url,
    offset: 1080000, sourceHash: first.sourceHash }, { extract }));
  assert.equal(validPageRequest(1080000, first.sourceHash), true);
  assert.equal(end.content, 'Final text.'); assert.equal(end.nextOffset, null);
  const options = { url, finalUrl: url, offset: 8000, sourceHash: first.sourceHash };
  for (const [data, changed] of [[Buffer.from('changed bytes'), {}], [body, { finalUrl: url + '?v=2' }]]) {
    const value = JSON.parse(await webDocument(data, 'application/pdf', { ...options, ...changed }, { extract }));
    assert.equal(value.state, 'source_changed'); assert.equal(value.content, null);
  }
  text += 'Changed extraction';
  assert.equal(JSON.parse(await webDocument(body, 'application/pdf', options, { extract })).state, 'source_changed');
  text = text.replace('Changed extraction', ''); representation = 'changed_extractor_representation';
  assert.equal(JSON.parse(await webDocument(body, 'application/pdf', options, { extract })).state, 'source_changed');
});

test('Actual web entry routes supported bytes to extraction and keeps extraction failure explicit', async () => {
  let mime = 'application/pdf', failed = false;
  const body = Buffer.from('synthetic bytes'), seen = [];
  const { webFetch } = await esmock('../src/tools/search.js', {
    '../src/conversation-context.js': { currentConversation: () => ({ transport: 'slack' }) },
    '../src/public-web-fetch.js': { fetchPublicResource: async (_url, options) => {
      assert.ok(options.binaryTypes.has(mime));
      return { status: 200, contentType: mime, finalUrl: 'https://example.org/final', body };
    } },
  }, { '../src/tools/document-extract.js': {
    extractDocument: async (data, type) => {
      seen.push(type); assert.deepEqual(data, body);
      return failed ? { state: 'unavailable', error: 'document_extractor_unavailable' }
        : { state: 'extracted', content: 'Verified synthetic passage.', representation: 'fixture',
          completeExtraction: true, limitations: [] };
    },
  } });
  for (const type of BINARY_DOCUMENT_TYPES) {
    mime = type;
    const result = JSON.parse(await webFetch({ url: 'https://example.org/report' }));
    assert.equal(result.content, 'Verified synthetic passage.');
    assert.equal(result.finalUrl, 'https://example.org/final'); assert.equal(result.contentType, mime);
  }
  assert.deepEqual(seen, [...BINARY_DOCUMENT_TYPES]);
  failed = true;
  const failure = JSON.parse(await webFetch({ url: 'https://example.org/report' }));
  assert.equal(failure.state, 'unavailable'); assert.equal(failure.content, null);
  assert.equal(failure.error, 'document_extractor_unavailable');
});
