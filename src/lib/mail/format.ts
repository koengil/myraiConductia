import DOMPurify from 'dompurify';
import { formatDate, formatTime, formatWeekday } from '@/lib/format/date';

/**
 * Pure helpers for the mail client: plain-text extraction from the composer's
 * rich body, HTML sanitizing for the reading pane (DOMPurify), Outlook-style
 * timestamps, and avatar initials. No React, no state.
 */

/** Rich body -> the screened plain text. Block closes and <br> become breaks. */
export function toPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render-side sanitizer for stored message HTML. Outbound HTML is authored by
 * our own composer, but INBOUND HTML is attacker-controlled (any counterparty
 * can mail us), so this must hold against real XSS vectors — obfuscated
 * `jav\nascript:` URIs, `base` rebasing, svg/math namespace tricks — not just
 * the obvious ones. DOMPurify with the HTML-only profile (no SVG/MathML) is
 * the industry-audited answer; the previous hand-rolled blocklist was
 * bypassable (PR #122 review, High 5). Browser-only; callers fall back to
 * plain text elsewhere.
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') return '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'base', 'iframe', 'object', 'embed', 'link', 'meta'],
    FORBID_ATTR: ['style'],
  });
}

/** Outlook-style stamp: time today, weekday this week, date otherwise. */
export function mailTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(d);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return formatWeekday(d);
  return formatDate(d);
}

/** "ana.moura@target.com" -> "AM"; falls back to the first two letters. */
export function initialsOf(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const chars =
    parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2);
  return chars.toUpperCase() || '?';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
