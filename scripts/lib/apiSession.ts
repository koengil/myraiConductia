/**
 * Authenticated API-client plumbing for the operational scripts that drive the
 * product's own /api/v1 surface instead of writing to the database.
 *
 * Extracted from scripts/onboard-company.ts, which still carries its own copy;
 * that script is prod-critical and was left untouched deliberately. New scripts
 * should import from here so a third copy never appears.
 */

type SessionGrant = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user?: { id?: string; email?: string };
  error_description?: string;
  msg?: string;
};

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/** The SSR cookie the app's server client reads: base64- + base64url(JSON). */
export function sessionCookie(supabaseUrl: string, grant: SessionGrant): string {
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  const encoded = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
  return `sb-${ref}-auth-token=base64-${encoded}`;
}

export async function signIn(
  supabaseUrl: string,
  publishableKey: string,
): Promise<SessionGrant> {
  const email = requiredEnv('ADMIN_EMAIL');
  const password = requiredEnv('ADMIN_PASSWORD');
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const grant = (await res.json()) as SessionGrant;
  if (!res.ok || !grant.access_token) {
    throw new Error(
      `Sign-in failed for ${email}: ${grant.error_description ?? grant.msg ?? res.status}`,
    );
  }
  console.log(`Signed in as ${email}`);
  return grant;
}

/** The firm-admin refresh token must not outlive the run. */
export async function signOut(
  supabaseUrl: string,
  publishableKey: string,
  grant: SessionGrant,
): Promise<void> {
  await fetch(`${supabaseUrl}/auth/v1/logout`, {
    method: 'POST',
    headers: { apikey: publishableKey, Authorization: `Bearer ${grant.access_token}` },
  }).catch(() => {});
}
