import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleRead } from '../src/tools/google-read.js';
import { createGoogleReader } from '../src/tools/google-client.js';
import { GOOGLE_READ_NAMES } from '../src/tools/google-definitions.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';
import { permitsTool } from '../src/conversation-tools.js';
import { executeTool } from '../src/tools/handler.js';
import { boundToolResult } from '../src/tool-result.js';

const scope = patch => createConversationContext({ transport: 'slack', conversationId: 'slack:test:private',
  actorId: 'owner', ownerId: 'owner', audience: 'group', policy: { mode: 'open' },
  localOnly: true, readOnly: true, ...patch });
const allowed = () => true;
const call = async (name, input, request) => JSON.parse(await googleRead(name, input, { allowed, request }));

test('Google read authority rejects wrong audience, owner and cloud execution; write calls stay denied', async () => {
  for (const patch of [{ actorId: 'other' }, { audience: 'unknown' }, { policy: { mode: 'colleague' } },
    { localOnly: false }, { webOnly: true }]) {
    for (const name of GOOGLE_READ_NAMES) assert.equal(permitsTool(name, {}, scope(patch)), false);
  }
  const own = scope({});
  for (const name of GOOGLE_READ_NAMES) assert.equal(permitsTool(name, {}, own), true);
  await withConversationContext(own, async () => {
    for (const name of ['calendar_create_event', 'calendar_update_event', 'gmail_draft', 'gmail_confirm_send',
      'send_file', 'soul_learn', 'lqc_start_debate']) {
      assert.equal(permitsTool(name, {}), false);
      assert.match(await executeTool(name, {}, 'owner', own.conversationId), /denied/);
    }
    assert.match(await executeTool('drive_read', { file_id: 'test' }, 'spoof', own.conversationId), /denied/);
  });
  assert.equal(JSON.parse(await googleRead('drive_read', {}, {
    allowed: () => false, request: () => assert.fail('network called') })).state, 'not_authorized');
});

test('Calendar preserves recurring instances, all-day exclusive ends, timezone and incomplete pages', async () => {
  const events = [{ id: 'a', recurringEventId: 'series', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } },
    { id: 'b', recurringEventId: 'series', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } }];
  const result = await call('calendar_read_events', { time_min: '2026-10-24T00:00:00+01:00', time_max: '2026-10-27T00:00:00Z' },
    async (path, params) => {
      assert.equal(path, '/calendar/v3/calendars/primary/events');
      assert.equal(params.timeMin, '2026-10-24T00:00:00+01:00');
      assert.equal(params.singleEvents, true);
      return { items: events, timeZone: 'Europe/London', nextPageToken: 'more' };
    });
  assert.deepEqual(result.events, events);
  assert.equal(result.completeWindow, false);
  assert.equal(result.availability, 'not_computed');
  assert.equal(result.endDatesExclusive, true);
  assert.equal(result.nextPageToken, 'more');
});

test('Invalid inputs fail before network access, including URL injection and missing continuation version', async () => {
  for (const [name, args] of [['drive_read', { file_id: 'https://evil.test' }],
    ['drive_read', { file_id: 'abc', offset: 1 }], ['drive_read', { file_id: 'abc', extra: 'x' }],
    ['calendar_read_events', { time_min: '2026-10-24', time_max: '2026-10-25' }],
    ['calendar_read_events', { time_min: '2026-10-25T00:00:00Z', time_max: '2026-10-24T00:00:00Z' }]]) {
    assert.equal((await call(name, args, () => assert.fail('network called'))).state, 'invalid_input');
  }
});
test('Subscribed calendar IDs are encoded as path data', async () => {
  const result = await call('calendar_read_events', { calendar_id: 'en.uk#holiday@group.v.calendar.google.com',
    time_min: '2026-10-24T00:00:00Z', time_max: '2026-10-27T00:00:00Z' }, async path => {
    assert.match(path, /en.uk%23holiday%40group.v.calendar.google.com\/events$/);
    return { items: [] };
  });
  assert.deepEqual(result.events, []);
});

test('Drive search escapes quoted query syntax and reports incomplete results', async () => {
  const result = await call('drive_search', { query: "x' or trashed = true or name = 'y", page_token: 'page2' }, async (_, params) => {
    assert.equal(params.q, "trashed = false and fullText contains 'x\\' or trashed = true or name = \\'y'");
    assert.equal(params.pageToken, 'page2');
    return { files: [], incompleteSearch: true, nextPageToken: 'page3' };
  });
  assert.equal(result.incompleteSearch, true);
  assert.equal(result.contentsRead, false);
});

const modifiedTime = '2026-09-14T10:00:00.000Z';
const file = { id: 'abc', name: 'Synthetic', mimeType: 'application/vnd.google-apps.document',
  modifiedTime, capabilities: { canDownload: true } };
test('Drive read carries source version, complete paged text and detects edits during export', async () => {
  const content = 'x'.repeat(13000);
  const request = async path => path.endsWith('/export') ? content : file;
  const first = await call('drive_read', { file_id: 'abc' }, request);
  const second = await call('drive_read', { file_id: 'abc', offset: first.nextOffset, modified_time: first.file.modifiedTime }, request);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(JSON.parse(boundToolResult('drive_read', JSON.stringify(first))), first);
  let calls = 0;
  const changed = await call('drive_read', { file_id: 'abc' }, async () => ++calls === 1 ? file
    : calls === 2 ? content : { modifiedTime: '2026-09-15T10:00:00.000Z' });
  assert.equal(changed.state, 'file_changed_restart_read');
  assert.equal(changed.content, undefined);
});

test('Unsupported files and upstream failures cannot masquerade as empty documents or empty calendars', async () => {
  assert.equal((await call('drive_read', { file_id: 'abc' }, async () => ({ ...file, mimeType: 'application/vnd.ms-excel' }))).state,
    'unsupported_format');
  const failure = await call('calendar_read_events', { time_min: modifiedTime, time_max: '2026-09-15T10:00:00Z' },
    async () => { throw new Error('credential: secret-token private-data'); });
  assert.equal(failure.state, 'unavailable');
  assert.equal(JSON.stringify(failure).includes('secret-token'), false);
  const status = await call('google_read_status', {}, async path => {
    if (path.startsWith('/drive')) throw new Error('google_permission_or_api_access_denied');
    return {};
  });
  assert.equal(status.calendar.state, 'connected');
  assert.equal(status.drive.state, 'unavailable');
});

test('Google client restricts hosts, methods, redirect behavior, token lifetime and response size', async () => {
  const calls = [];
  const reader = createGoogleReader({ core: { googleClientId: 'id', googleClientSecret: 'secret', googleRefreshToken: 'refresh' },
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'token', expires_in: 3600 } : { kind: 'ok' }));
    } });
  await assert.rejects(reader('//evil.test/path'), /invalid_api_path/);
  await reader('/drive/v3/files', { q: "'test'", fields: 'kind' });
  await reader('/calendar/v3/calendars/primary/events');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.method, 'POST');
  for (const entry of calls.slice(1)) {
    assert.equal(new URL(entry.url).hostname, 'www.googleapis.com');
    assert.equal(entry.options.method, 'GET');
  }
});

test('Google binary downloads preserve non-UTF8 bytes and enforce the binary size ceiling', async () => {
  let oversize = false;
  const bytes = Buffer.from([0, 255, 128, 10]);
  const reader = createGoogleReader({ core: { googleClientId: 'id', googleClientSecret: 'secret', googleRefreshToken: 'refresh' },
    fetchFn: async url => String(url).includes('/token')
      ? new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }))
      : new Response(oversize ? Buffer.alloc(20_000_001) : bytes) });
  assert.deepEqual(await reader('/drive/v3/files/abc', { alt: 'media' }, { binary: true }), bytes);
  oversize = true;
  await assert.rejects(reader('/drive/v3/files/abc', { alt: 'media' }, { binary: true }), /google_response_too_large/);
});
