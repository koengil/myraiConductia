/**
 * One US date format for the whole app: "Oct 7, 2026", "3:04 PM",
 * "Oct 7, 2026, 3:04 PM". Every site that shows a date or time goes through
 * here so no screen reads day-first, 24-hour or in the browser's own locale.
 *
 * Inputs may be a Date, an ISO string or epoch milliseconds; invalid input
 * gives ''. Values render in the viewer's time zone unless `timeZone` is given
 * (pass 'UTC' for calendar days stored as 'YYYY-MM-DD' and for stamps the
 * server and the browser must agree on).
 */

export type DateInput = Date | string | number | null | undefined;
export type DateFormatOptions = { timeZone?: string };

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Newer ICU puts a narrow no-break space before AM/PM; plain text and tests want a normal space.
function plain(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

function render(value: DateInput, options: Intl.DateTimeFormatOptions, opts?: DateFormatOptions): string {
  const date = toDate(value);
  if (!date) return '';
  return plain(new Intl.DateTimeFormat('en-US', { ...options, timeZone: opts?.timeZone }).format(date));
}

/** "Oct 7, 2026" */
export function formatDate(value: DateInput, opts?: DateFormatOptions): string {
  return render(value, { month: 'short', day: 'numeric', year: 'numeric' }, opts);
}

/** "3:04 PM" */
export function formatTime(value: DateInput, opts?: DateFormatOptions): string {
  return render(value, { hour: 'numeric', minute: '2-digit', hour12: true }, opts);
}

/** "Oct 7, 2026, 3:04 PM" */
export function formatDateTime(value: DateInput, opts?: DateFormatOptions): string {
  return render(
    value,
    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true },
    opts,
  );
}

/** "Mon": the weekday alone, for recent items in a list. */
export function formatWeekday(value: DateInput, opts?: DateFormatOptions): string {
  return render(value, { weekday: 'short' }, opts);
}

function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).format(date);
}

/**
 * The calendar day before `now`'s day in the zone, as a dayKey. Counted in
 * calendar days, never `now - 24h`, so the 23- and 25-hour days around a DST
 * change still name the right day.
 */
function yesterdayKey(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return dayKey(new Date(Date.UTC(part('year'), part('month') - 1, part('day') - 1, 12)), 'UTC');
}

/** "Today", "Yesterday", else the date. For headings over grouped lists. */
export function formatDayHeading(value: DateInput, opts?: DateFormatOptions, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  if (dayKey(date, opts?.timeZone) === dayKey(now, opts?.timeZone)) return 'Today';
  if (dayKey(date, opts?.timeZone) === yesterdayKey(now, opts?.timeZone)) return 'Yesterday';
  return formatDate(date, opts);
}

/** "just now", "5 min ago", "2h ago", "Yesterday", else the date. */
export function formatRelative(value: DateInput, now: Date | number = Date.now(), opts?: DateFormatOptions): string {
  const date = toDate(value);
  if (!date) return '';
  const nowMs = now instanceof Date ? now.getTime() : now;
  const mins = Math.round((nowMs - date.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  if (dayKey(date, opts?.timeZone) === yesterdayKey(new Date(nowMs), opts?.timeZone)) return 'Yesterday';
  return formatDate(date, opts);
}
