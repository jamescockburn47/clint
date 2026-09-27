const string = description => ({ type: 'string', description });
const tool = (name, description, properties, required = []) => ({ name, description,
  input_schema: { type: 'object', additionalProperties: false, properties, required } });
export const GOOGLE_READ_DEFINITIONS = [
  tool('google_read_status', 'Probe current Calendar and Drive read access; configuration alone is not proof of connection.', {}),
  tool('calendar_list_calendars', 'List accessible Google calendars. Follow nextPageToken until null for complete coverage.',
    { page_token: string('Continuation token from the previous page.') }),
  tool('calendar_read_events', 'Read Google Calendar events in an explicit time window. Preserves recurring instances and exclusive all-day end dates. Follow pagination; this is not a free/busy guarantee.', {
    calendar_id: string('Calendar ID from calendar_list_calendars, or primary.'),
    time_min: string('Inclusive window boundary as RFC3339 datetime with UTC offset.'),
    time_max: string('Exclusive window boundary as RFC3339 datetime with UTC offset.'),
    query: string('Optional search text; omit to see all events in the window.'),
    page_token: string('Continuation token from the previous page.'),
  }, ['time_min', 'time_max']),
  tool('calendar_free_time', 'Compute free time in London working hours from Google Calendar, for one date or a run of up to 14. Returns busy and free periods as times only, never event titles. Use for "when am I free", "find me an hour on Thursday", "am I free at 3". If the state is not computed, say free time could not be established; never infer it. Reads the primary calendar unless calendar_ids is given; say which calendars were read.', {
    date: string('First date, YYYY-MM-DD, London.'), days: { type: 'integer', minimum: 1, maximum: 14 },
    day_start: string('Start of the working day, HH:MM from 03:00. Default 09:00.'),
    day_end: string('End of the working day, HH:MM. Default 18:00.'),
    minimum_minutes: { type: 'integer', minimum: 15, maximum: 480 },
    calendar_ids: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Calendar IDs from calendar_list_calendars.' },
  }, ['date']),
  tool('drive_search', 'Search live Google Drive file names and indexed content, or list a folder. Returns metadata, not full document contents. Follow pagination.', {
    query: string('Plain search text, not Drive query syntax.'), folder_id: string('Optional parent folder ID.'),
    page_token: string('Continuation token from the previous page.'),
  }),
  tool('drive_read', 'Read Docs, Slides, UTF-8, PDF, DOCX, XLSX and Google Sheets in bounded pages. PDF page references and spreadsheet cell references are preserved; scan OCR is labelled unverified. Check extraction limitations, unread pages and nextOffset. Supply modified_time on continuation to detect edits.', {
    file_id: string('Google Drive file ID.'), offset: { type: 'integer', minimum: 0 },
    modified_time: string('Exact modifiedTime returned by the preceding page.'),
  }, ['file_id']),
];
export const GOOGLE_READ_NAMES = GOOGLE_READ_DEFINITIONS.map(tool => tool.name);
