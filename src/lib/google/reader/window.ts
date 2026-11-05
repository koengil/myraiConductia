// The ingestion window (#353): which mail a Gmail backfill takes, by date. Pure, so the reader and its tests share it.
//
// Two halves. `afterQuery` is the coarse filter on threads.list: it keeps the listing small, and one day of slack
// makes it a superset, because Google documents neither which timestamp `after:` compares nor whether it is
// inclusive. `inWindow` is the exact filter, per message on its internalDate: a thread is listed whole if any of its
// messages matches, so its older messages are dropped here, after the exclusion policy has judged the whole thread.
//
// The window is range-shaped (a ceiling as well as a floor) so a later slice can read only the gap when a window
// moves earlier (design, "Extension path"); this wave always passes no ceiling.

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that names a real calendar day. */
export function isWindowDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** 00:00 UTC of the window's first day, in epoch ms; null for no window (the whole mailbox). A malformed date throws. */
export function floorMsOf(since: string | null | undefined): number | null {
  if (since === null || since === undefined) return null;
  if (!isWindowDate(since)) throw new Error('gmail reader: unreadable window start');
  return Date.parse(`${since}T00:00:00.000Z`);
}

/** threads.list's `q` for a window from `floorMs`: epoch seconds (no timezone question), one day early. */
export function afterQuery(floorMs: number): string {
  return `after:${Math.floor(floorMs / 1000) - DAY_MS / 1000}`;
}

/** Whether a message's internalDate (epoch ms, as Gmail sends it) falls in [floor, ceiling). No floor: always. */
export function inWindow(internalDate: string | number | undefined, floorMs: number | null, ceilingMs: number | null = null): boolean {
  if (floorMs === null && ceilingMs === null) return true;
  const ms = Number(internalDate);
  // A message with no usable date cannot be shown to be in the window, so a bounded read leaves it out.
  if (!Number.isFinite(ms)) return false;
  if (floorMs !== null && ms < floorMs) return false;
  if (ceilingMs !== null && ms >= ceilingMs) return false;
  return true;
}
