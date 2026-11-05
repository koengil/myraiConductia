const DEFAULT_AUTH_DESTINATION = '/projects';

const AUTH_COMPLETION_PATHS = new Set([
  '/accept-invite',
  '/sign-in',
  '/sign-out',
  '/two-factor',
]);

const RETIRED_MARKETING_PATHS = new Set(['/', '/about']);

const INVITE_CREDENTIAL_PARAMS = new Set([
  'access_token',
  'credential_nonce',
  'invite_id',
  'refresh_token',
  'token',
  'token_hash',
]);

/**
 * Normalize a caller-controlled post-auth destination to an internal platform
 * path. Query strings are retained, while fragments, credential-bearing URLs,
 * malformed encodings, protocol-relative paths, and auth completion loops are
 * rejected.
 */
export function safeAuthDestination(
  value: string | null | undefined,
  fallback = DEFAULT_AUTH_DESTINATION,
): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }

  try {
    const url = new URL(value, 'https://conductia.internal');
    if (url.origin !== 'https://conductia.internal') return fallback;

    const decodedPathname = decodeURIComponent(url.pathname).toLowerCase();
    if (
      AUTH_COMPLETION_PATHS.has(decodedPathname) ||
      RETIRED_MARKETING_PATHS.has(decodedPathname) ||
      decodedPathname.startsWith('/accept-invite/')
    ) {
      return fallback;
    }

    for (const key of url.searchParams.keys()) {
      if (INVITE_CREDENTIAL_PARAMS.has(key.toLowerCase())) return fallback;
    }

    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
