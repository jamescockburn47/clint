import net from 'node:net';

export const BINARY_DOCUMENT_TYPES = new Set(['application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A separate DynamicUser, empty root filesystem, no network, bounded CPU/RAM/lifetime.
// The Slack process sends bytes only; no credentials, paths or commands enter the worker.
export function extractDocument(data, mime, { connect = options => net.createConnection(options) } = {}) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 20_000_000 || !BINARY_DOCUMENT_TYPES.has(mime)) {
    return Promise.resolve({ state: 'unavailable', error: 'document_input_invalid_or_too_large' });
  }
  return new Promise(resolve => {
    const socket = connect({ path: '/run/clint-extractor.sock' });
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ state: 'unavailable', error: 'document_extraction_timeout' }), 125000);
    socket.on('error', () => finish({ state: 'unavailable', error: 'document_extractor_unavailable' }));
    socket.on('connect', () => {
      const header = Buffer.from(JSON.stringify({ mime, size: data.length }));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(header.length);
      socket.write(size);
      socket.write(header);
      socket.end(data);
    });
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 6_000_000) return finish({ state: 'unavailable', error: 'document_output_too_large' });
      chunks.push(chunk);
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.state === 'extracted' && typeof result.content === 'string'
          && typeof result.representation === 'string' && typeof result.completeExtraction === 'boolean'
          && Buffer.byteLength(result.content) <= 2_000_000) return finish(result);
        // Keep parser errors in a closed vocabulary; never return arbitrary subprocess output.
        const errors = new Set(['extraction_limit', 'invalid_document', 'ambiguous_package', 'macros_not_supported',
          'unsafe_xml', 'external_sheet_not_supported', 'unsupported_sheet', 'unsupported_format',
          'unsupported_document_namespace', 'unsupported_embedded_content', 'document_extraction_failed']);
        finish({ state: 'unavailable', error: errors.has(result.error) ? result.error : 'document_extraction_failed' });
      } catch { finish({ state: 'unavailable', error: 'document_extraction_failed' }); }
    });
  });
}
