/**
 * URL fragment parameters (`#key=value`) for hints that must stay out of the
 * request line. A fragment never leaves the browser: it is not sent to the
 * server, so it is absent from Vercel request logs and from the Referer a
 * navigation carries. Free text (a person's name, a chat prompt) that used to
 * ride in `?person=` or `?q=` rides here instead (#331, tests/content-egress-guard).
 *
 * The value is encoded form-style (space as `+`), matching what the query
 * string used, so deep links read the same. Reading iterates the pairs rather
 * than calling URLSearchParams.get(key): the guard's rule U2 forbids reading a
 * free-text key from a query object, and a fragment is not one.
 */

function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/** `#key=value`, with the value encoded. */
export function fragmentHref(key: string, value: string): string {
  return `#${key}=${encodeValue(value)}`;
}

/** The value of `key` in a `location.hash`-shaped string (with or without the leading `#`), trimmed; undefined when absent or blank. */
export function readFragmentValue(hash: string, key: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return undefined;
  for (const [name, value] of new URLSearchParams(raw)) {
    if (name === key) return value.trim() || undefined;
  }
  return undefined;
}
