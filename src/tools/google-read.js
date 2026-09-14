import { z } from 'zod';
import { createGoogleReader, googleError } from './google-client.js';
import { knowledgeAllowed } from '../knowledge/tools.js';
import { BINARY_DOCUMENT_TYPES, XLSX_MIME, extractDocument } from './document-extract.js';

const page = z.string().max(4096).optional();
const id = z.string().regex(/^[\w@.+-]{1,512}$/);
const calendarId = z.string().min(1).max(512).refine(value => !/[\s\x00-\x1f]/.test(value));
const date = z.string().datetime({ offset: true });
const schemas = {
  google_read_status: z.object({}).strict(),
  calendar_list_calendars: z.object({ page_token: page }).strict(),
  calendar_read_events: z.object({ calendar_id: calendarId.default('primary'), time_min: date, time_max: date,
    query: z.string().max(1000).optional(), page_token: page }).strict()
    .refine(input => Date.parse(input.time_max) > Date.parse(input.time_min), 'invalid_window'),
  drive_search: z.object({ query: z.string().max(1000).optional(), folder_id: id.optional(), page_token: page }).strict(),
  drive_read: z.object({ file_id: id, offset: z.number().int().min(0).max(2_000_000).default(0),
    modified_time: date.optional() }).strict().refine(input => !input.offset || input.modified_time, 'continuation_requires_version'),
};
const escapeQuery = text => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const fields = 'id,name,mimeType,modifiedTime,webViewLink,size,capabilities(canDownload)';
const read = createGoogleReader();

export async function googleRead(name, input, { request = read, allowed = knowledgeAllowed, extract = extractDocument,
  now = () => new Date() } = {}) {
  if (!allowed()) return JSON.stringify({ state: 'not_authorized' });
  const parsed = schemas[name]?.safeParse(input);
  if (!parsed?.success) return JSON.stringify({ state: 'invalid_input' });
  const args = parsed.data;
  const observedAt = now().toISOString();
  const wrap = data => JSON.stringify({ observedAt, source: 'live_google_api', ...data });
  try {
    if (name === 'google_read_status') {
      const probe = async (path, params) => {
        try { await request(path, params); return { state: 'connected' }; }
        catch (error) { return { state: 'unavailable', error: googleError(error) }; }
      };
      return wrap({ calendar: await probe('/calendar/v3/calendars/primary/events', { maxResults: 1, fields: 'kind' }),
        drive: await probe('/drive/v3/files', { pageSize: 1, fields: 'kind' }) });
    }
    if (name === 'calendar_list_calendars') {
      const data = await request('/calendar/v3/users/me/calendarList', { maxResults: 100, pageToken: args.page_token,
        fields: 'items(id,summary,timeZone,primary,accessRole),nextPageToken' });
      return wrap({ calendars: data.items || [], nextPageToken: data.nextPageToken || null });
    }
    if (name === 'calendar_read_events') {
      const data = await request(`/calendar/v3/calendars/${encodeURIComponent(args.calendar_id)}/events`, {
        timeMin: args.time_min, timeMax: args.time_max, q: args.query, pageToken: args.page_token,
        maxResults: 50, singleEvents: true, orderBy: 'startTime',
        fields: 'timeZone,nextPageToken,items(id,summary,status,start,end,recurringEventId,originalStartTime,location,description,htmlLink,updated,transparency)',
      });
      return wrap({ calendarId: args.calendar_id, timeMin: args.time_min, timeMax: args.time_max,
        query: args.query || null, timeZone: data.timeZone || null, events: data.items || [],
        nextPageToken: data.nextPageToken || null, completeWindow: !data.nextPageToken && !args.page_token,
        endDatesExclusive: true, availability: 'not_computed' });
    }
    if (name === 'drive_search') {
      const clauses = ['trashed = false'];
      if (args.query) clauses.push(`fullText contains '${escapeQuery(args.query)}'`);
      if (args.folder_id) clauses.push(`'${escapeQuery(args.folder_id)}' in parents`);
      const data = await request('/drive/v3/files', { q: clauses.join(' and '), pageSize: 50,
        pageToken: args.page_token, fields: `files(${fields}),nextPageToken,incompleteSearch`,
        orderBy: 'modifiedTime desc', includeItemsFromAllDrives: true, supportsAllDrives: true });
      return wrap({ files: data.files || [], nextPageToken: data.nextPageToken || null,
        incompleteSearch: data.incompleteSearch ?? null, contentsRead: false });
    }
    const path = `/drive/v3/files/${encodeURIComponent(args.file_id)}`;
    const file = await request(path, { fields, supportsAllDrives: true });
    if (args.modified_time && args.modified_time !== file.modifiedTime) return wrap({ state: 'file_changed_restart_read', file });
    if (!file.capabilities?.canDownload) return wrap({ state: 'download_not_permitted', file });
    const native = ['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation'].includes(file.mimeType);
    const sheet = file.mimeType === 'application/vnd.google-apps.spreadsheet';
    const binary = sheet || BINARY_DOCUMENT_TYPES.has(file.mimeType);
    if (!native && !binary && !/^(text\/|application\/(json|xml)$)/.test(file.mimeType || '')) {
      return wrap({ state: 'unsupported_format', file, contentsRead: false });
    }
    if (binary && Number(file.size) > 20_000_000) return wrap({ state: 'extraction_limit', file, contentsRead: false });
    const downloaded = native || sheet ? await request(path + '/export', { mimeType: sheet ? XLSX_MIME : 'text/plain' },
      { text: !sheet, binary: sheet }) : await request(path, { alt: 'media', supportsAllDrives: true }, { text: !binary, binary });
    const extracted = binary ? await extract(downloaded, sheet ? XLSX_MIME : file.mimeType) : null;
    if (extracted && extracted.state !== 'extracted') return wrap({ ...extracted, file, contentsRead: false });
    const content = extracted ? extracted.content : downloaded;
    const after = await request(path, { fields: 'modifiedTime', supportsAllDrives: true });
    if (after.modifiedTime !== file.modifiedTime) return wrap({ state: 'file_changed_restart_read', file });
    if (args.offset > content.length) return wrap({ state: 'invalid_offset', file });
    const end = Math.min(content.length, args.offset + 12000);
    const { content: ignoredContent, state: ignoredState, ...extraction } = extracted || {};
    return wrap({ ...extraction, state: 'content', file, offset: args.offset, content: content.slice(args.offset, end),
      totalCharacters: content.length, nextOffset: end < content.length ? end : null,
      representation: extracted?.representation || (native ? 'plain_text_export_formatting_not_preserved' : 'utf8_text') });
  } catch (error) { return wrap({ state: 'unavailable', error: googleError(error) }); }
}
export const GOOGLE_READ_HANDLERS = Object.keys(schemas).map(name => [name, input => googleRead(name, input)]);
