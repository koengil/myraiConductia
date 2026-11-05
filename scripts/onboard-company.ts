/**
 * Org bootstrap trigger (Sep 3 huddle prep): fire the product's own
 * POST /api/v1/companies/onboard against a deployment, "the proper way"
 * (Rob, Sep 3) — the company is created through the API with its audit row,
 * and the owner receives the real director invite by email (password set by
 * the owner, 2FA enforced on the invite-created account). No direct database
 * writes here; this script is an authenticated API client, nothing more.
 *
 *   APP_URL=https://app.conductia.com \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   OWNER_EMAIL=storm@conductia.com \
 *   node --env-file=.env.<target>.local --import tsx scripts/onboard-company.ts
 *
 * The caller must be a FIRM ADMIN on the target database (the endpoint
 * refuses everyone else) — on an empty database that one account is the
 * only thing created outside the product. And it must be a SEEDED account,
 * not an invite-created one: the password grant is AAL1, and requireApiUser
 * demands AAL2 from invite-created accounts, so an admin born through the
 * product's own invite flow can never run this script.
 *
 * A brand-new company has no verified domains, so the first call answers
 * 409 domain_confirmation_required; pass AUTO_CONFIRM=1 to re-submit with
 * the returned confirmationId, or re-run manually with CONFIRMATION_ID set.
 * Never prints passwords or tokens.
 */
import { COMPANY_TYPE, COMPANY_TYPES, type CompanyType } from '../src/lib/constants/companies';

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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/** The SSR cookie the app's server client reads: base64- + base64url(JSON). */
function sessionCookie(supabaseUrl: string, grant: SessionGrant): string {
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  const encoded = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
  return `sb-${ref}-auth-token=base64-${encoded}`;
}

async function signIn(supabaseUrl: string, publishableKey: string): Promise<SessionGrant> {
  const email = requiredEnv('ADMIN_EMAIL');
  const password = requiredEnv('ADMIN_PASSWORD');
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const grant = (await res.json()) as SessionGrant;
  if (!res.ok || !grant.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${grant.error_description ?? grant.msg ?? res.status}`);
  }
  console.log(`Signed in as ${email}`);
  return grant;
}

async function main(): Promise<void> {
  const appUrl = requiredEnv('APP_URL').replace(/\/$/, '');
  const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const publishableKey = requiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const ownerEmail = requiredEnv('OWNER_EMAIL');
  const companyName = process.env.COMPANY_NAME?.trim() || 'Conductia';
  const companyType = (process.env.COMPANY_TYPE?.trim() || COMPANY_TYPE.BANK) as CompanyType;
  if (!COMPANY_TYPES.includes(companyType)) {
    throw new Error(`COMPANY_TYPE must be one of: ${COMPANY_TYPES.join(', ')}`);
  }

  // Say exactly what is about to happen before it happens: node --env-file
  // does NOT override variables already exported in the shell, so a stale
  // export can silently beat the env file — this line is what catches it.
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  console.log(
    `Target: ${appUrl} (supabase ${ref}) — onboard "${companyName}" [${companyType}], owner ${ownerEmail}`,
  );

  const grant = await signIn(supabaseUrl, publishableKey);
  const cookie = sessionCookie(supabaseUrl, grant);

  const call = async (confirmationId?: string) => {
    // redirect: 'error' — a cross-origin redirect (apex to www, http to
    // https) strips the cookie header and would surface as a misleading 401.
    const res = await fetch(`${appUrl}/api/v1/companies/onboard`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', cookie },
      body: JSON.stringify({
        name: companyName,
        type: companyType,
        ownerEmail,
        ...(confirmationId ? { confirmationId } : {}),
      }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  };

  const signOut = async () => {
    // The firm-admin refresh token must not outlive the run.
    await fetch(`${supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: publishableKey, Authorization: `Bearer ${grant.access_token}` },
    }).catch(() => {});
  };

  let { status, body } = await call(process.env.CONFIRMATION_ID?.trim() || undefined);

  if (status === 409 && body?.error === 'domain_confirmation_required') {
    const confirmationId = body.confirmationId as string;
    const address = typeof body.normalizedEmail === 'string' ? body.normalizedEmail : ownerEmail;
    console.log(`Domain not verified for ${address}; confirmation id ${confirmationId}.`);
    if (process.env.AUTO_CONFIRM === '1') {
      console.log('AUTO_CONFIRM=1 — re-submitting with the confirmation id.');
      ({ status, body } = await call(confirmationId));
    } else {
      console.log('Re-run with AUTO_CONFIRM=1 (or CONFIRMATION_ID set) to confirm the address.');
      await signOut();
      process.exit(2);
    }
  }

  if (status < 200 || status >= 300) {
    await signOut();
    const hint =
      status === 404
        ? ' (route not found: wrong APP_URL, or the platform_onboarding flag is off on this deployment)'
        : '';
    throw new Error(`Onboard failed (${status})${hint}: ${JSON.stringify(body)}`);
  }
  console.log(`Onboard OK (${status}):`, JSON.stringify(body, null, 2));
  console.log(`${ownerEmail} now has the director invite in their inbox; they set their own password and enroll 2FA.`);
  await signOut();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
