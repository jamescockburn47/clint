import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleRead } from '../src/tools/google-read.js';

// Recommended by the third review of v40 (R3-1, R3-8): cases its tests did not pin. No source is changed for them.
const allowed = () => true;
const list = items => ({ kind: 'calendar#events', items });
const ask = async (input, items) => JSON.parse(await googleRead('calendar_free_time', input,
  { allowed, request: async () => list(items), now: () => new Date('2026-01-01T00:00:00Z') }));
const timed = (start, end) => ({ status: 'confirmed', start: { dateTime: start }, end: { dateTime: end } });
const periods = items => items.map(item => `${item.start}-${item.end}`);

test('known-bad: an all-day event naming one day takes the whole of that day, whatever the working hours', async () => {
  const oneDay = date => [{ status: 'confirmed', start: { date }, end: { date } }];
  for (const [start, end] of [['03:00', '23:59'], ['08:00', '20:00'], ['09:00', '18:00'], ['18:00', '23:00']]) {
    const result = await ask({ date: '2026-10-05', days: 3, day_start: start, day_end: end }, oneDay('2026-10-06'));
    assert.deepEqual(result.days.map(day => [periods(day.busy), periods(day.free)]),
      [[[], [`${start}-${end}`]], [[`${start}-${end}`], []], [[], [`${start}-${end}`]]], `${start}-${end}`);
    assert.equal(result.excluded.noLength, 0);
  }
  // The day the clocks go back has 25 hours, and the day they go forward 23: the event ends at the next London midnight.
  for (const date of ['2026-10-25', '2026-03-29']) {
    const before = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const result = await ask({ date: before, days: 3, day_start: '03:00', day_end: '23:59' }, oneDay(date));
    assert.deepEqual(result.days.map(day => [periods(day.busy), periods(day.free)]),
      [[[], ['03:00-23:59']], [['03:00-23:59'], []], [[], ['03:00-23:59']]], date);
  }
});

test('times in the forms Google is understood to send are read, at the edges of the pattern', async () => {
  for (const [start, end, busy] of [
    ['2026-10-06T23:00:00+01:00', '2026-10-06T23:30:00+01:00', ['23:00-23:30']],
    ['2026-10-06T17:00:00-05:00', '2026-10-06T17:30:00-05:00', ['23:00-23:30']],
    ['2026-10-06T10:00:00-12:00', '2026-10-06T10:30:00-12:00', ['23:00-23:30']],
    ['2026-10-07T12:00:00+14:00', '2026-10-07T12:30:00+14:00', ['23:00-23:30']],
    ['2026-10-07T03:30:00+05:30', '2026-10-07T04:00:00+05:30', ['23:00-23:30']],
    ['2026-10-06T22:00:00.123456789Z', '2026-10-06T22:29:59.999999999Z', ['23:00-23:30']],
    ['2026-10-06T22:00:00.999Z', '2026-10-06T22:30:00.001Z', ['23:00-23:31']],
    ['2026-10-06T22:00:00.5Z', '2026-10-06T22:29:59.999Z', ['23:00-23:30']],
    ['2026-10-06T22:00:00Z', '2026-10-06T22:30:00Z', ['23:00-23:30']]]) {
    const result = await ask({ date: '2026-10-06', day_start: '03:00', day_end: '23:59' }, [timed(start, end)]);
    assert.deepEqual([result.state, periods(result.days[0].busy)], ['computed', busy], `${start} to ${end}`);
  }
  // Lower-case letters are not the form, and are refused rather than guessed at.
  for (const start of ['2026-10-06t22:00:00Z', '2026-10-06T22:00:00z']) {
    const result = await ask({ date: '2026-10-06' }, [timed(start, '2026-10-06T22:30:00Z')]);
    assert.deepEqual([result.state, result.reason, result.days], ['incomplete', 'event_without_readable_times', null], start);
  }
});

test('known-bad: an event shorter than a minute is busy for the minutes it touches, not left out', async () => {
  const result = await ask({ date: '2026-10-06' }, [timed('2026-10-06T10:00:10+01:00', '2026-10-06T10:00:40+01:00'),
    timed('2026-10-06T14:59:59+01:00', '2026-10-06T15:00:01+01:00'), timed('2026-10-06T16:00:00.001+01:00', '2026-10-06T16:00:00.002+01:00')]);
  assert.deepEqual(periods(result.days[0].busy), ['10:00-10:01', '14:59-15:01', '16:00-16:01']);
  assert.equal(result.excluded.noLength, 0);
  assert.deepEqual(periods(result.days[0].free), ['09:00-10:00', '10:01-14:59', '15:01-16:00', '16:01-18:00']);
});
