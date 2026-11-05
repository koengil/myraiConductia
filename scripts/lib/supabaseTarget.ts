/**
 * Target guard for operator scripts that write with a service-role key (#316).
 *
 * `node --env-file` does not override a variable already exported in the
 * shell, so a script can silently point at a different project than the env
 * file names. A hosted target therefore needs EXPECT_SUPABASE_REF, and the
 * script exits before it creates a client when the URL's project ref differs.
 * A loopback URL (a local stack, the CI job) needs no expected ref; if one is
 * given it is still compared.
 *
 * Pure: the caller passes the values, so nothing here reads the environment.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export type SupabaseTarget = { ref: string; loopback: boolean };

export function assertSupabaseTarget(url: string, expectedRef: string | undefined): SupabaseTarget {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(hostname);
  const ref = hostname.split('.')[0];
  const expected = expectedRef?.trim();

  if (!expected) {
    if (loopback) return { ref, loopback };
    throw new Error(
      `EXPECT_SUPABASE_REF must be set for a hosted target (the URL points at ${ref}); nothing was changed`,
    );
  }
  if (expected !== ref) {
    throw new Error(`Target is supabase ${ref}, but EXPECT_SUPABASE_REF is ${expected}; nothing was changed`);
  }
  return { ref, loopback };
}
