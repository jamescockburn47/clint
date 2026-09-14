import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { publicIPv4, publicDestination, fetchPublicText } from '../src/public-web-fetch.js';
import { resolveProjectFile } from '../src/project-file-boundary.js';

test('public network boundary excludes private, loopback, reserved, mapped IPv6 and alternative URL forms', async () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.1.2', '169.254.169.254',
    '172.31.1.2', '192.168.1.2', '198.18.1.2', '224.1.1.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(publicIPv4(address), false);
  }
  assert.equal(publicIPv4('93.184.216.34'), true);
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.com', 'http://example.com:5100']) {
    await assert.rejects(publicDestination(url, async () => assert.fail('DNS should not run')));
  }
  const loopback = async host => [{ address: host, family: 4 }];
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://127.1']) {
    await assert.rejects(publicDestination(url, loopback), /denied/);
  }
  await assert.rejects(publicDestination('https://example.com', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 },
  ]), /denied/);
});

test('connections pin verified DNS and reject redirects into the EVO network', async () => {
  let sent = 0;
  const request = (_url, options, callback) => {
    sent++;
    options.lookup('example.com', { all: true }, (_err, result) => {
      assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
    });
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from([]);
      response.statusCode = 302; response.headers = { location: 'http://127.0.0.1/private' };
      callback(response);
    };
    return req;
  };
  await assert.rejects(fetchPublicText('https://example.com', { request,
    resolve: async host => [{ address: host === 'example.com' ? '93.184.216.34' : host, family: 4 }],
  }), /denied/);
  assert.equal(sent, 1);
});

test('public fetch bounds body bytes and DNS wait', async () => {
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const request = (_url, _opts, callback) => {
    const req = new EventEmitter(); req.end = () => {
      const response = Readable.from([Buffer.from('too much content')]);
      response.statusCode = 200; response.headers = {}; callback(response);
    }; return req;
  };
  await assert.rejects(fetchPublicText('https://example.com', { resolve, request, maxBytes: 4 }), /too_large/);
  await assert.rejects(fetchPublicText('https://example.com', {
    resolve: () => new Promise(() => {}), timeoutMs: 10,
  }), /timeout/);
});

test('project root boundary rejects sibling prefixes and symlink escapes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'clint-file-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'), other = join(dir, 'project-private');
  mkdirSync(root); mkdirSync(other);
  writeFileSync(join(root, 'visible.md'), 'public'); writeFileSync(join(other, 'secret.json'), 'private');
  assert.equal(resolveProjectFile(root, 'visible.md'), join(root, 'visible.md'));
  assert.throws(() => resolveProjectFile(root, '../project-private/secret.json'), /outside/);
  symlinkSync(other, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveProjectFile(root, 'link/secret.json'), /outside/);
});
