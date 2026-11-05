/** Box rejects item names longer than 255 characters. */
export const BOX_NAME_MAX_LENGTH = 255;

/** Longest trailing extension `boxSafeFileName` keeps whole when it truncates. */
export const BOX_EXTENSION_MAX_LENGTH = 10;

const DEFAULT_NAME = 'Untitled';

// C0 controls, DEL and C1 controls. Box answers 400 item_name_invalid for
// control characters, and they have no place in a folder or file name.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Zero-width and bidi format characters: invisible, and a bidi override can
// make a name read differently from what it is.
const FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PATH_SEPARATORS = /[/\\]/g;
const TRAILING_DOTS_AND_SPACES = /[.\s]+$/u;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** First `max` UTF-16 units of `value`, never ending on half a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/** Separators to `-`, control and format characters out, trimmed, no trailing dot or space. */
function clean(name: string): string {
  return name
    .replace(PATH_SEPARATORS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    .trim()
    .replace(TRAILING_DOTS_AND_SPACES, '');
}

function capped(name: string, max: number): string {
  return cut(clean(name), max).replace(TRAILING_DOTS_AND_SPACES, '');
}

/**
 * The one name every Box folder we create passes through (#328). File names
 * go through `boxSafeFileName`, which keeps the extension.
 *
 * Box refuses a name that contains `/` or `\`, ends in a dot or a space, is
 * `.` or `..`, or runs past 255 characters. A census step title such as
 * "Document Intake / Metadata" therefore failed the rail-step folder create.
 *
 * - `/` and `\` become `-`;
 * - control characters and zero-width/bidi format characters are removed;
 * - surrounding whitespace is trimmed and trailing dots and spaces stripped;
 * - the result is capped at `maxLength` (255) UTF-16 units without splitting
 *   a surrogate pair;
 * - an empty result (including `.`, `..`, `...` and `. .`) becomes `fallback`,
 *   itself made safe, and 'Untitled' when the fallback is no better.
 *
 * A name that is already safe comes back byte-identical.
 */
export function boxSafeName(
  name: string,
  fallback = DEFAULT_NAME,
  maxLength = BOX_NAME_MAX_LENGTH,
): string {
  return capped(name, maxLength) || capped(fallback, maxLength) || cut(DEFAULT_NAME, maxLength);
}

/**
 * `boxSafeName` for a file name (#328): when the name runs past 255
 * characters, a trailing extension of up to 10 characters (the part after the
 * last dot, when there is a stem before it) is kept and the stem is cut, so
 * `report-name.pdf` stays a `.pdf`. A longer "extension" is treated as stem.
 */
export function boxSafeFileName(name: string, fallback = DEFAULT_NAME): string {
  const safe = clean(name);
  if (safe === '') return boxSafeName(fallback);
  if (safe.length <= BOX_NAME_MAX_LENGTH) return safe;

  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 ? safe.slice(dot) : '';
  if (extension.length > 1 && extension.length - 1 <= BOX_EXTENSION_MAX_LENGTH) {
    const stem = capped(safe.slice(0, dot), BOX_NAME_MAX_LENGTH - extension.length);
    if (stem) return `${stem}${extension}`;
  }
  return boxSafeName(safe, fallback);
}
