/**
 * Response headers for the two artifact proxy routes (#226 part A).
 *
 * An agent can write any bytes under any content-type. If the proxy echoed an
 * upstream `text/html` or `image/svg+xml`, the browser would render it on
 * Conductia's origin, where inline script is allowed. So only inert media types
 * pass; everything else is served as an opaque download.
 */

const INERT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const FALLBACK_TYPE = 'application/octet-stream';

/** ASCII-only quoted-string content: quotes, backslash, CR, LF and non-ASCII become `_`. */
function asciiSafe(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_');
}

/** RFC 5987 percent-encoding for `filename*`. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function fallbackDisposition(filename?: string): string {
  if (!filename) return 'attachment';
  return `attachment; filename="${asciiSafe(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

export function artifactHeaders(
  upstream: Headers,
  opts: { filename?: string } = {},
): Record<string, string> {
  const type = (upstream.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const fallback = fallbackDisposition(opts.filename);

  if (INERT_TYPES.has(type)) {
    return {
      'content-type': upstream.get('content-type') as string,
      'content-disposition': upstream.get('content-disposition') ?? fallback,
      'x-content-type-options': 'nosniff',
    };
  }
  return {
    'content-type': FALLBACK_TYPE,
    'content-disposition': fallback,
    'x-content-type-options': 'nosniff',
  };
}
