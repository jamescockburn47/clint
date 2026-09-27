/**
 * calendar_free_time. Free time is computed here from events read in full, or it is not reported.
 * No title, description, location or attendee name is requested from Google, so none reaches the model.
 */
export const ZONE = 'Europe/London';
const MINUTE = 60000;
const MAX_PAGES = 8;
const MAX_RESULT = 18000;
export const FIELDS = 'kind,nextPageToken,items(status,transparency,eventType,start,end,attendees(self,responseStatus))';
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const wall = instant => Object.fromEntries(clock.formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]));

/** Milliseconds London is ahead of UTC at an instant. */
function ahead(instant) {
  const at = wall(instant);
  return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - Math.floor(instant / 1000) * 1000;
}

/** A London date and time as an instant. Callers pass midnight or a time from 03:00, which the clocks never skip or repeat. */
export function londonInstant(date, time) {
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  return asUtc - ahead(asUtc - ahead(asUtc));
}

/** A real calendar date from 2000 to 2100. Outside that, JavaScript's own reading of a year cannot be relied on. */
export function validDate(text) {
  if (typeof text !== 'string' || !/^(20\d\d|2100)-\d\d-\d\d$/.test(text)) return false;
  const instant = Date.parse(text + 'T00:00:00Z');
  // A day that does not exist either fails to parse or rolls over into the next month.
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === text;
}
const later = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const hhmm = instant => { const at = wall(instant); return `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`; };
const weekday = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(new Date(date + 'T00:00:00Z'));
// A time as Google gives it: a date, a time and an offset. Anything else would be read in this machine's own zone, or guessed.
const DATE_TIME = /^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
// The day named in a time must exist, as the day of an all-day event must: JavaScript would move 31 September to 1 October.
const instantOf = text => DATE_TIME.test(text) && validDate(text.slice(0, 10)) ? Date.parse(text) : NaN;

/**
 * Start and end of one event as instants, or null when either cannot be read.
 * An all-day event that names the same day as its start and its end is that day, not an event of no length.
 */
function span(event) {
  const timed = side => typeof side?.dateTime === 'string';
  const edge = side => timed(side) ? instantOf(side.dateTime) : validDate(side?.date) ? londonInstant(side.date, '00:00') : NaN;
  const start = edge(event?.start), end = edge(event?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end === start && !timed(event.start) && !timed(event.end)
    ? [start, londonInstant(later(event.start.date, 1), '00:00')] : [start, end];
}

export async function freeTime(args, request, now) {
  const dates = Array.from({ length: args.days }, (_, index) => later(args.date, index));
  const calendars = args.calendar_ids?.length ? [...new Set(args.calendar_ids)] : ['primary'];
  const window = { date: args.date, days: args.days, dayStart: args.day_start, dayEnd: args.day_end,
    minimumMinutes: args.minimum_minutes, timeZone: ZONE };
  const refuse = reason => ({ state: 'incomplete', reason, calendars, window, days: null });
  const busy = [];
  const excluded = { cancelled: 0, markedFree: 0, declined: 0, workingLocation: 0, noLength: 0 };
  let eventsRead = 0, requests = 0;
  for (const calendar of calendars) {
    let pageToken;
    for (;;) {
      // One limit for the whole read, however many calendars: it bounds the requests made for one question.
      if (requests++ === MAX_PAGES) return refuse('too_many_events_to_read_in_full');
      const data = await request(`/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`, {
        timeMin: new Date(londonInstant(dates[0], args.day_start)).toISOString(),
        timeMax: new Date(londonInstant(dates.at(-1), args.day_end)).toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken, fields: FIELDS });
      // Only a reply that says it is a list of events is read as one. An empty day must be Google's statement, not a missing one.
      if (data?.kind !== 'calendar#events' || (data.items !== undefined && !Array.isArray(data.items))) return refuse('unreadable_reply');
      for (const event of data.items || []) {
        eventsRead++;
        if (event?.status === 'cancelled') excluded.cancelled++;
        else if (event?.eventType === 'workingLocation') excluded.workingLocation++;
        else if (event?.transparency === 'transparent') excluded.markedFree++;
        else if (Array.isArray(event?.attendees) && event.attendees.some(person => person?.self === true &&
          person.responseStatus === 'declined')) excluded.declined++;
        else {
          const times = span(event);
          // An event that cannot be placed could be anywhere in the window, so no free time is claimed.
          if (!times) return refuse('event_without_readable_times');
          if (times[1] === times[0]) excluded.noLength++;
          // Whole minutes, outwards: a minute any part of which is taken is not free.
          else busy.push([Math.floor(times[0] / MINUTE) * MINUTE, Math.ceil(times[1] / MINUTE) * MINUTE]);
        }
      }
      pageToken = data.nextPageToken;
      if (pageToken === undefined || pageToken === null) break;
      if (typeof pageToken !== 'string' || !pageToken) return refuse('unreadable_reply');
    }
  }
  busy.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end] of busy) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  const current = Math.ceil(now.getTime() / MINUTE) * MINUTE;
  const slot = (start, end) => ({ start: hhmm(start), end: hhmm(end), minutes: Math.round((end - start) / MINUTE) });
  const days = dates.map(date => {
    const opens = londonInstant(date, args.day_start), closes = londonInstant(date, args.day_end);
    const from = Math.max(opens, Math.min(current, closes)); // Time already gone is not offered as free.
    const taken = merged.filter(([start, end]) => end > opens && start < closes)
      .map(([start, end]) => [Math.max(start, opens), Math.min(end, closes)]);
    const free = [];
    let cursor = from;
    for (const [start, end] of taken) {
      if (start - cursor >= args.minimum_minutes * MINUTE) free.push(slot(cursor, start));
      cursor = Math.max(cursor, end);
    }
    if (closes - cursor >= args.minimum_minutes * MINUTE) free.push(slot(cursor, closes));
    return { date, weekday: weekday(date), busy: taken.map(([start, end]) => slot(start, end)), free,
      ...(from > opens ? { startsFrom: hhmm(from) } : {}) };
  });
  // The whole answer or none of it: a result too long for the evidence limit is refused here, never cut.
  if (JSON.stringify(days).length > MAX_RESULT) return refuse('result_too_long_ask_for_fewer_days');
  return { state: 'computed', complete: true, calendars, window, eventsRead, excluded, days,
    notCovered: 'Calendars not listed were not read. Travel time is not allowed for. Counted as busy: tentative events, '
      + 'invitations not yet answered, out of office, focus time and any other event not marked free. Not counted as busy: '
      + 'events marked free, declined or cancelled, working-location markers and timed events of no length.' };
}
