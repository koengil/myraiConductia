import { formatRelative } from '@/lib/format/date';

/** "just now" / "12 min ago" / "3h ago" / "Yesterday", then the date: shared by the bell and the Conductor Center so
 *  one timestamp never reads two ways. */
export function relativeTime(iso: string, now = Date.now()): string {
  return formatRelative(iso, now);
}
