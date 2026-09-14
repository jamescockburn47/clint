import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { extractDocument } from '../src/tools/document-extract.js';
import { googleRead } from '../src/tools/google-read.js';

test('Actual office extraction and available PDF/OCR integration fixtures', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['test/test-document-worker.py'],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Extractor uses framed bytes, fixed socket and redacts worker failures', async () => {
  const writes = [];
  const connect = options => {
    assert.deepEqual(options, { path: '/run/clint-extractor.sock' });
    const socket = new EventEmitter();
    socket.write = data => writes.push(data);
    socket.destroy = () => {};
    socket.end = data => {
      writes.push(data);
      queueMicrotask(() => {
        socket.emit('data', Buffer.from('{"state":"unavailable","error":"private document text"}'));
        socket.emit('end');
      });
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  const input = Buffer.from([0,255,10]);
  const result = await extractDocument(input, 'application/pdf', { connect });
  assert.equal(result.error, 'document_extraction_failed');
  assert.equal(writes[0].readUInt32BE(), writes[1].length);
  assert.deepEqual(JSON.parse(writes[1]), { mime: 'application/pdf', size: 3 });
  assert.deepEqual(writes[2], input);
});

test('Google Sheets exports every sheet as XLSX and carries extraction limits and source version', async () => {
  const file = { id: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet',
    modifiedTime: '2026-09-14T12:00:00Z', capabilities: { canDownload: true } };
  const result = JSON.parse(await googleRead('drive_read', { file_id: 'sheet' }, {
    allowed: () => true,
    request: async (path, params, options) => {
      if (!path.endsWith('/export')) return file;
      assert.equal(params.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.equal(options.binary, true);
      return Buffer.from('synthetic');
    },
    extract: async () => ({ state: 'extracted', content: 'A1=3', representation: 'xlsx_sheet_cell_records',
      completeExtraction: true, limitations: ['Cached formulas may be stale.'], sheets: [{ name: 'First' }, { name: 'Second' }] }),
  }));
  assert.equal(result.state, 'content');
  assert.equal(result.sheets.length, 2);
  assert.equal(result.file.modifiedTime, file.modifiedTime);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.limitations, ['Cached formulas may be stale.']);
});
