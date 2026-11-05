import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatRelative,
  formatTime,
  formatWeekday,
} from '@/lib/format/date';

const UTC = { timeZone: 'UTC' };
const ISO = '2026-10-07T15:04:00Z';

describe('formatDate', () => {
  it('writes month first, unpadded, with the year', () => {
    expect(formatDate(ISO, UTC)).toBe('Oct 7, 2026');
    expect(formatDate('2026-09-18T00:00:00Z', UTC)).toBe('Sep 18, 2026');
  });
  it('accepts Date, string and epoch milliseconds', () => {
    expect(formatDate(new Date(ISO), UTC)).toBe('Oct 7, 2026');
    expect(formatDate(Date.parse(ISO), UTC)).toBe('Oct 7, 2026');
  });
  it('returns an empty string for invalid input', () => {
    expect(formatDate('nope')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate(new Date('x'))).toBe('');
  });
  it('honours a pinned time zone', () => {
    expect(formatDate('2026-10-07T23:30:00Z', { timeZone: 'Pacific/Auckland' })).toBe('Oct 8, 2026');
  });
});

describe('formatTime and formatDateTime', () => {
  it('uses a 12-hour clock with a plain space', () => {
    expect(formatTime(ISO, UTC)).toBe('3:04 PM');
    expect(formatTime('2026-10-07T00:05:00Z', UTC)).toBe('12:05 AM');
  });
  it('joins the date and time', () => {
    expect(formatDateTime(ISO, UTC)).toBe('Oct 7, 2026, 3:04 PM');
    expect(formatDateTime('bad')).toBe('');
  });
});

describe('formatWeekday', () => {
  it('gives the short weekday', () => {
    expect(formatWeekday(ISO, UTC)).toBe('Wed');
  });
});

describe('formatDayHeading', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  it('names today and yesterday, else the date', () => {
    expect(formatDayHeading('2026-10-07T01:00:00Z', UTC, now)).toBe('Today');
    expect(formatDayHeading('2026-10-06T23:00:00Z', UTC, now)).toBe('Yesterday');
    expect(formatDayHeading('2026-10-04T10:00:00Z', UTC, now)).toBe('Oct 4, 2026');
    expect(formatDayHeading('bad', UTC, now)).toBe('');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  it('walks from just now to a date', () => {
    expect(formatRelative('2026-10-07T11:59:40Z', now, UTC)).toBe('just now');
    expect(formatRelative('2026-10-07T11:55:00Z', now, UTC)).toBe('5 min ago');
    expect(formatRelative('2026-10-07T10:00:00Z', now, UTC)).toBe('2h ago');
    expect(formatRelative('2026-10-06T12:30:00Z', now, UTC)).toBe('23h ago');
    expect(formatRelative('2026-10-06T09:00:00Z', now, UTC)).toBe('Yesterday');
    expect(formatRelative('2026-10-01T09:00:00Z', now, UTC)).toBe('Oct 1, 2026');
  });
  it('accepts a Date for now and rejects bad input', () => {
    expect(formatRelative('2026-10-07T11:55:00Z', new Date(now), UTC)).toBe('5 min ago');
    expect(formatRelative('bad', now)).toBe('');
  });
});

// "Yesterday" is the previous calendar day in the target zone, not
// now minus 24 hours, so a 23- or 25-hour day around a DST change still reads right.
describe('Yesterday across a DST change (America/New_York)', () => {
  const NY = { timeZone: 'America/New_York' };

  it('at Nov 2, 2026 00:30 local, Nov 1 00:45 local reads Yesterday (25-hour day)', () => {
    const now = new Date('2026-11-02T05:30:00Z'); // 00:30 EST
    const ts = '2026-11-01T04:45:00Z'; // 00:45 EDT
    expect(formatDayHeading(ts, NY, now)).toBe('Yesterday');
    expect(formatRelative(ts, now, NY)).toBe('Yesterday');
  });

  it('after the 23-hour spring day, a time on Mar 8 still reads Yesterday on Mar 9', () => {
    const now = new Date('2026-03-09T04:30:00Z'); // Mar 9 00:30 EDT
    const ts = '2026-03-08T05:15:00Z'; // Mar 8 00:15 EST
    expect(formatDayHeading(ts, NY, now)).toBe('Yesterday');
    // Under a day ago, the relative form still counts hours.
    expect(formatRelative(ts, now, NY)).toBe('23h ago');
  });

  // Late on the 25-hour day, now - 24h is still the same
  // calendar day, so the old code never reached the day before.
  it('at Nov 1, 2026 23:30 local (end of the 25-hour day), Oct 31 reads Yesterday', () => {
    const now = new Date('2026-11-02T04:30:00Z'); // Nov 1 23:30 EST
    const ts = '2026-10-31T16:00:00Z'; // Oct 31 12:00 EDT
    expect(formatDayHeading(ts, NY, now)).toBe('Yesterday');
    expect(formatRelative(ts, now, NY)).toBe('Yesterday');
  });

  it('two calendar days back is the date, never Yesterday', () => {
    const now = new Date('2026-03-09T04:30:00Z');
    expect(formatDayHeading('2026-03-07T23:00:00Z', NY, now)).toBe('Mar 7, 2026');
  });
});
