import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// @ts-expect-error pg ships no declarations and @types/pg is not a dependency.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProvisionedUser } from '@/lib/auth/provisioning';

import { startMockOidc, setNextMockIdentity, type MockIdentity } from '../../e2e/support/mockOidc';
import { totpCode } from '../../e2e/support/totp';

/*
 * Issue #316: the broker contract the work-identity design relies on, proven
 * against REAL Supabase Auth (GoTrue) and Postgres, PKCE only.
 *
 * Google and Microsoft cannot be pointed at a local issuer, so the local stack
 * enables the `keycloak` provider against e2e/support/mockOidc.ts. Keycloak
 * runs the same Auth paths that matter (flow_state, callback auto-linking,
 * identity_data rewrite, the custom access token hook at exchange) and puts
 * non-standard claims (hd, tid) in identity_data.custom_claims like the real
 * providers. It proves broker semantics, not Google/Microsoft behavior (HQ1,
 * HQ2 in docs/03-engineering/work-identity-contract.md).
 *
 * Requirements (the suite skips, with the reason logged, when any is absent):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 *   SUPABASE_SECRET_KEY, DATABASE_URL
 *   the work-identity migration (public.work_identity_access_token_hook exists)
 *   [auth.hook.custom_access_token] uri = pg-functions://postgres/public/work_identity_access_token_hook
 *   [auth.external.keycloak] enabled, url = http://host.docker.internal:<port>/realms/x
 *   MOCK_OIDC_PORT (default 56430): the suite starts the mock itself unless
 *   one is already listening there.
 *
 * The probes P-A..P-E pin what Auth v2.196.0 does on its own; if any of them
 * changes the design's harmlessness argument is void (PA2: stop, escalate).
 * Every created auth user is deleted in afterAll; audit_log is WORM, so audit
 * rows remain as residue, as in phase1.e2e.test.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON/SQL rows in a broker probe
type Json = Record<string, any>;

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MOCK_PORT = Number(process.env.MOCK_OIDC_PORT ?? 56430);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PROVIDER = 'keycloak';
// The firm-facing provider; the server-only alias table routes it to the keycloak mock.
const LOGICAL = 'google';
const REDIRECT = 'http://localhost:3000/auth/work/callback';
const RUN = randomBytes(4).toString('hex');

async function readiness(): Promise<string | null> {
  if (!API || !PUBLISHABLE || !SECRET || !DATABASE_URL) {
    return 'NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY and DATABASE_URL are required';
  }
  try {
    const settings = (await (await fetch(`${API}/auth/v1/settings`, { headers: { apikey: PUBLISHABLE } })).json()) as {
      external?: Record<string, boolean>;
    };
    if (!settings.external?.[PROVIDER]) return 'the keycloak mock provider is not enabled on this Auth instance';
    const db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const { rows } = await db.query(
      `select to_regprocedure('public.work_identity_access_token_hook(jsonb)') is not null as hook`,
    );
    await db.end();
    if (!rows[0]?.hook) return 'migration 20261002100000_work_identity_onboarding is not applied';
  } catch (error) {
    return `local stack unreachable: ${(error as Error).message}`;
  }
  return null;
}

const notReady = await readiness();
if (notReady) console.warn(`[work-identity-broker] skipped: ${notReady}`);

// ---- broker plumbing -------------------------------------------------------

const b64u = (buffer: Buffer) => buffer.toString('base64url');
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const loopback = (url: string) => url.replace('host.docker.internal', '127.0.0.1');
const publicHeaders = { apikey: PUBLISHABLE, 'content-type': 'application/json' };

type Exchange = {
  /** The auth code the callback returned, or null if the callback itself failed. */
  code: string | null;
  callbackError: string | null;
  verifier: string;
  status: number | null;
  body: Json | null;
};

/**
 * Drives one PKCE authorization through the mock and exchanges the code, as
 * the app's callback does. `linkWith` starts a linkIdentity flow from that
 * access token instead of a sign-in. `exchange: false` stops at the code.
 */
async function oauth(
  identity: MockIdentity,
  { linkWith, exchange = true }: { linkWith?: string; exchange?: boolean } = {},
): Promise<Exchange> {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  await setNextMockIdentity(MOCK, identity);
  const query = `provider=${PROVIDER}&redirect_to=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=s256`;

  let location: string | null;
  if (linkWith) {
    const response = await fetch(`${API}/auth/v1/user/identities/authorize?${query}&skip_http_redirect=true`, {
      headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${linkWith}` },
    });
    location = ((await response.json()) as { url?: string }).url ?? null;
  } else {
    const response = await fetch(`${API}/auth/v1/authorize?${query}`, { headers: { apikey: PUBLISHABLE }, redirect: 'manual' });
    location = response.headers.get('location');
  }
  for (let hop = 0; hop < 4 && location && !location.startsWith(REDIRECT); hop++) {
    const response = await fetch(loopback(location), { headers: { apikey: PUBLISHABLE }, redirect: 'manual' });
    location = response.headers.get('location');
  }
  if (!location) throw new Error('authorization did not return to the redirect');
  const returned = new URL(location);
  const code = returned.searchParams.get('code');
  const callbackError =
    returned.searchParams.get('error_code') ??
    new URLSearchParams(returned.hash.slice(1)).get('error_code') ??
    returned.searchParams.get('error');
  if (!code || !exchange) return { code, callbackError, verifier, status: null, body: null };

  const response = await fetch(`${API}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  return { code, callbackError, verifier, status: response.status, body: (await response.json()) as Json };
}

/** The hook's refusal reason as Auth relays it (message carries the hook's error). */
const refusal = (body: Json | null) =>
  JSON.stringify([body?.error_code, body?.msg, body?.message, body?.error_description]);

async function passwordSignIn(email: string, password: string) {
  const response = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const sessionId = (accessToken: string): string =>
  JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).session_id;

/** A client acting as the holder of `accessToken`, with RLS and auth.jwt() applied. */
const asUser = (accessToken: string): SupabaseClient =>
  createClient(API, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

/** Enrolls and verifies TOTP in the session, returning an aal2 access token. */
async function stepUpToAal2(accessToken: string): Promise<string> {
  const auth = { apikey: PUBLISHABLE, Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const enrolled = (await (
    await fetch(`${API}/auth/v1/factors`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ factor_type: 'totp', friendly_name: `broker-${RUN}-${randomBytes(2).toString('hex')}` }),
    })
  ).json()) as { id: string; totp: { secret: string } };
  const challenge = (await (
    await fetch(`${API}/auth/v1/factors/${enrolled.id}/challenge`, { method: 'POST', headers: auth, body: '{}' })
  ).json()) as { id: string };
  const verified = (await (
    await fetch(`${API}/auth/v1/factors/${enrolled.id}/verify`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ challenge_id: challenge.id, code: totpCode(enrolled.totp.secret) }),
    })
  ).json()) as { access_token?: string };
  if (!verified.access_token) throw new Error('TOTP step-up failed');
  return verified.access_token;
}

// ---- suite -----------------------------------------------------------------

describe.skipIf(notReady !== null)('work-identity broker contract (#316, real Auth + Postgres)', () => {
  const admin = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = new Client({ connectionString: DATABASE_URL });
  const createdUsers: string[] = [];
  let stopMock: (() => Promise<void>) | null = null;

  // Firm fixture: a bank (the banker firm, mapped to an org id), a target, an
  // active MD/admin who invites, a deal with the MD seated.
  const tenant = randomUUID();
  const bank = randomUUID();
  const target = randomUUID();
  const deal = randomUUID();
  const org = `org-${RUN}.example`;
  const bankDomain = `bank-${RUN}.test`;
  const targetDomain = `target-${RUN}.test`;
  let mdId = '';
  let mappingSupported = false;

  const email = (label: string, domain = bankDomain) => `${label}-${RUN}@${domain}`;
  const sql = async <T = Json>(text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as T[];

  async function contained(label: string, domain?: string) {
    const address = email(label, domain);
    const { data, error } = await admin.auth.admin.createUser({ email: address, password: 'Initial-pass-1', email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? 'createUser failed');
    createdUsers.push(data.user.id);
    return { id: data.user.id, email: address };
  }

  async function provisioned(label: string, profile: Record<string, unknown>, domain?: string) {
    const address = email(label, domain);
    const user = await createProvisionedUser(admin as never, {
      email: address,
      password: 'Initial-pass-1',
      email_confirm: true,
      profile: { tenant_id: tenant, ...profile } as never,
    });
    createdUsers.push(user.id);
    return { id: user.id, email: address };
  }

  /** A legacy (email_code) invitation for `address` into the target company, delivered. */
  async function legacyInvite(address: string, code: string) {
    const [{ result }] = await sql<{ result: { id: string } }>(
      `select public.create_invite($1, $2, $3, 'member', $4, null, $5, 'seller', 0) as result`,
      [mdId, address, target, sha256Hex(code), deal],
    );
    await sql(`update public.invites set delivery_status = 'sent' where id = $1`, [result.id]);
    const [{ credential_nonce }] = await sql<{ credential_nonce: string }>(
      `select credential_nonce from public.invites where id = $1`,
      [result.id],
    );
    return { id: result.id, nonce: credential_nonce };
  }

  const identityFor = (address: string, extra: Partial<MockIdentity> = {}): MockIdentity => ({
    sub: `sub-${randomBytes(6).toString('hex')}`,
    email: address,
    email_verified: true,
    hd: org,
    tid: org,
    ...extra,
  });

  const sessionsOf = async (userId: string) =>
    (await sql<{ id: string }>(`select id from auth.sessions where user_id = $1`, [userId])).map((row) => row.id);
  const identitiesOf = async (userId: string) =>
    sql<{ provider: string; provider_id: string; identity_data: Json }>(
      `select provider, provider_id, identity_data from auth.identities where user_id = $1 order by created_at`,
      [userId],
    );
  const profileOf = async (userId: string) =>
    (await sql(`select status, provisioning, tenant_id, company_id from public.users where id = $1`, [userId]))[0];
  const authUserByEmail = async (address: string) =>
    (
      await sql(
        `select id, email_confirmed_at, encrypted_password, raw_user_meta_data from auth.users where lower(email) = lower($1)`,
        [address],
      )
    )[0];

  beforeAll(async () => {
    await db.connect();
    try {
      stopMock = (await startMockOidc(MOCK_PORT)).close;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // An external mock (or the probe harness) already serves this port.
    }

    await sql(
      `insert into public.companies (id, tenant_id, name, type) values ($1, $2, $3, 'bank'), ($4, $2, $5, 'target')`,
      [bank, tenant, `Broker Bank ${RUN}`, target, `Broker Target ${RUN}`],
    );
    await sql(
      `insert into public.company_verified_domains (tenant_id, company_id, domain, source) values ($1, $2, $3, 'test'), ($1, $4, $5, 'test')`,
      [tenant, bank, bankDomain, target, targetDomain],
    );
    await sql(
      `insert into public.deals (id, tenant_id, code, codename, status, bank_id) values ($1, $2, $3, $4, 'active', $5)`,
      [deal, tenant, `WIB-${RUN}`, `Project Broker ${RUN}`, bank],
    );
    await sql(`insert into public.deal_parties (deal_id, company_id, party_role) values ($1, $2, 'target')`, [deal, target]);

    mdId = (await provisioned('md', { company_id: bank, company_role: 'director', firm_role: 'admin', is_external: false })).id;
    await provisioned('target-dir', { company_id: target, company_role: 'director', is_external: true }, targetDomain);
    await sql(
      `insert into public.deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
       select $1, $2, id, 'md', 0, $2 from public.roles where slug = 'md' limit 1`,
      [deal, mdId],
    );

    // The firm's provider mapping is google; the test-only broker alias makes the
    // keycloak mock stand in for it. The work-invite cases skip without the alias.
    try {
      await sql(
        `insert into public.work_identity_broker_aliases (provider, broker_provider) values ($1, $2)
         on conflict (provider) do update set broker_provider = excluded.broker_provider`,
        [LOGICAL, PROVIDER],
      );
      await sql(`select public.set_firm_identity_provider($1, $2, $3, $4)`, [mdId, bank, LOGICAL, org]);
      mappingSupported = true;
    } catch (error) {
      console.warn(`[work-identity-broker] provider mapping for ${LOGICAL} refused: ${(error as Error).message}`);
    }
  });

  afterAll(async () => {
    await sql(`delete from public.work_identity_broker_aliases where provider = $1`, [LOGICAL]).catch(() => undefined);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    await db.end().catch(() => undefined);
    await stopMock?.();
  });

  // ---- P-A..P-E: what Auth does before any Conductia code runs --------------

  it('P-A: a fresh OAuth email is contained and refused a token', async () => {
    const address = email('pa');
    const result = await oauth(identityFor(address));
    const user = await authUserByEmail(address);
    if (user) createdUsers.push(user.id);

    expect(user, 'the callback creates the auth user before the hook runs').toBeTruthy();
    expect(await profileOf(user.id)).toMatchObject({ provisioning: 'contained', status: 'invited', tenant_id: user.id, company_id: null });
    expect(result.status).toBe(403);
    expect(refusal(result.body)).toContain('work_identity_not_connected');
    expect(await sessionsOf(user.id)).toEqual([]);
    // Provider claims land in identity_data, never in app metadata.
    const [identity] = (await identitiesOf(user.id)).filter((row) => row.provider === PROVIDER);
    expect(identity.identity_data.custom_claims).toMatchObject({ hd: org });
  });

  it('P-B: same-email OAuth on an active account commits an unbound link that confers nothing', async () => {
    const active = await provisioned('pb', { company_id: bank, company_role: 'member', is_external: false });
    const result = await oauth(identityFor(active.email));

    expect(result.status).toBe(403);
    expect(refusal(result.body)).toContain('work_identity_not_connected');
    // The link persists despite the refusal (committed at callback).
    expect((await identitiesOf(active.id)).map((row) => row.provider)).toContain(PROVIDER);
    expect(await sessionsOf(active.id)).toEqual([]);
    const [{ count }] = await sql(`select count(*)::int as count from public.work_identity_bindings where user_id = $1`, [active.id]);
    expect(count).toBe(0);
    // Password sign-in is unaffected, and a repeat OAuth is still refused.
    expect((await passwordSignIn(active.email, 'Initial-pass-1')).status).toBe(200);
    expect((await oauth(identityFor(active.email))).status).toBe(403);
  });

  it('P-C/F10: OAuth on an unconfirmed legacy invitee mutates the account, is refused, and resend recovers', async () => {
    const address = email('f10', targetDomain);
    const code = '123456';
    const invite = await legacyInvite(address, code);
    // Legacy delivery: an unconfirmed invited auth user carrying the invite keys.
    const link = await admin.auth.admin.generateLink({
      type: 'invite',
      email: address,
      options: { data: { invite_id: invite.id, credential_nonce: invite.nonce } },
    });
    const userId = link.data.user!.id;
    createdUsers.push(userId);
    expect((await authUserByEmail(address)).email_confirmed_at).toBeNull();

    const result = await oauth(identityFor(address, { hd: undefined, tid: undefined }));
    expect(result.status).toBe(403);
    expect(refusal(result.body)).toContain('work_identity_not_connected');

    // Exactly the committed mutations of Auth v2.196.0 (external.go RemoveUnconfirmedIdentities).
    const after = await authUserByEmail(address);
    expect(after.id).toBe(userId);
    expect(after.email_confirmed_at).not.toBeNull();
    expect(after.raw_user_meta_data.invite_id).toBeUndefined();
    expect(after.raw_user_meta_data.credential_nonce).toBeUndefined();
    expect(after.encrypted_password ?? '').toBe('');
    expect((await identitiesOf(userId)).map((row) => row.provider)).toEqual([PROVIDER]);
    expect(await sessionsOf(userId)).toEqual([]);
    const [{ granted }] = await sql(
      `select count(*)::int as granted from public.deal_memberships where user_id = $1`,
      [userId],
    );
    expect(granted).toBe(0);

    // Recovery: resend rotates the credential and rewrites the keys server-side.
    const resendCode = '654321';
    await sql(`select public.rotate_invite_credential($1, $2)`, [invite.id, sha256Hex(resendCode)]);
    // The resend route marks the rotated invite sent once the email is accepted for delivery.
    const [{ credential_nonce: nonce }] = await sql(
      `update public.invites set delivery_status = 'sent' where id = $1 returning credential_nonce`,
      [invite.id],
    );
    await admin.auth.admin.updateUserById(userId, { user_metadata: { invite_id: invite.id, credential_nonce: nonce } });
    const magic = await admin.auth.admin.generateLink({ type: 'magiclink', email: address });
    const verified = await fetch(`${API}/auth/v1/verify`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ type: 'magiclink', token_hash: magic.data.properties!.hashed_token }),
    });
    const session = (await verified.json()) as { access_token: string };
    const client = asUser(session.access_token);
    expect((await client.rpc('verify_invite_challenge', { p_invite_id: invite.id, p_nonce: nonce, p_code_digest: sha256Hex(resendCode) })).error).toBeNull();
    const accepted = await client.rpc('accept_invite', {
      p_invite_id: invite.id,
      p_nonce: nonce,
      p_password: 'Recovered-pass-1',
      p_tos_version: 'test',
      p_display_name: 'Recovered Invitee',
    });
    expect(accepted.error).toBeNull();
    expect(await sessionsOf(userId)).toEqual([sessionId(session.access_token)]);
    const [{ seats }] = await sql(`select count(*)::int as seats from public.deal_memberships where user_id = $1`, [userId]);
    expect(seats).toBe(1);
    // The leftover provider identity is unbound and still confers nothing.
    expect((await oauth(identityFor(address, { hd: undefined, tid: undefined }))).status).toBe(403);
  });

  it('P-D: admin.createUser app_metadata is invisible to the trigger; the profile stays contained', async () => {
    const address = email('pd');
    const { data } = await admin.auth.admin.createUser({
      email: address,
      password: 'Initial-pass-1',
      email_confirm: true,
      app_metadata: { tenant_id: tenant, firm_role: 'admin' },
      user_metadata: { tenant_id: tenant, firm_role: 'admin', is_external: false },
    });
    createdUsers.push(data.user!.id);
    expect(await profileOf(data.user!.id)).toMatchObject({ provisioning: 'contained', status: 'invited', tenant_id: data.user!.id, company_id: null });
    // authorize_provisioned_profile is not callable by an authenticated user.
    const signedIn = await passwordSignIn(address, 'Initial-pass-1');
    const self = await asUser(signedIn.body.access_token).rpc('authorize_provisioned_profile', {
      p_user_id: data.user!.id,
      p_profile: { tenant_id: tenant, status: 'active' },
    });
    expect(self.error).not.toBeNull();
  });

  it('P-E: linkIdentity commits at callback, the exchange is refused, and flow_state records provenance', async () => {
    const active = await provisioned('pe', { company_id: bank, company_role: 'member', is_external: false });
    const signedIn = await passwordSignIn(active.email, 'Initial-pass-1');
    const result = await oauth(identityFor(email('pe-other')), { linkWith: signedIn.body.access_token, exchange: false });

    expect(result.code).toBeTruthy();
    expect((await identitiesOf(active.id)).map((row) => row.provider)).toContain(PROVIDER);
    const [flow] = await sql(
      `select linking_target_id, provider_type, code_challenge_method, auth_code_issued_at from auth.flow_state where auth_code = $1`,
      [result.code],
    );
    expect(flow).toMatchObject({ linking_target_id: active.id, provider_type: PROVIDER });
    expect(flow.auth_code_issued_at).not.toBeNull();

    const exchange = await fetch(`${API}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ auth_code: result.code, code_verifier: result.verifier }),
    });
    expect(exchange.status).toBe(403);
  });

  // ---- hook: suspension and refresh -----------------------------------------

  it('hook: a suspended account is refused on password sign-in and on refresh', async () => {
    const banker = await provisioned('suspended', { company_id: bank, company_role: 'member', is_external: false });
    const live = await passwordSignIn(banker.email, 'Initial-pass-1');
    expect(live.status).toBe(200);
    await sql(`update public.users set status = 'suspended' where id = $1`, [banker.id]);

    const again = await passwordSignIn(banker.email, 'Initial-pass-1');
    expect(again.status).toBe(403);
    expect(refusal(again.body)).toContain('account_suspended');
    const refreshed = await fetch(`${API}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ refresh_token: live.body.refresh_token }),
    });
    expect(refreshed.status).toBe(403);
    // The retained access token reads nothing (app_caller_live).
    const { data } = await asUser(live.body.access_token).from('companies').select('id').eq('id', bank);
    expect(data ?? []).toEqual([]);
  });

  // ---- F12 / F3: the legacy acceptance credential transition ----------------

  it('F12 + F3: accept_invite enforces the password policy and binds acceptance to the verifying session', async () => {
    const invitee = await contained('f3', targetDomain);
    const code = '246810';
    const invite = await legacyInvite(invitee.email, code);
    // Two live sessions on the same account: a competing holder and the recipient.
    const competing = await passwordSignIn(invitee.email, 'Initial-pass-1');
    const recipient = await passwordSignIn(invitee.email, 'Initial-pass-1');
    const squatter = asUser(competing.body.access_token);
    const owner = asUser(recipient.body.access_token);
    // A factor enrolled by the competing session must not survive acceptance.
    await fetch(`${API}/auth/v1/factors`, {
      method: 'POST',
      headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${competing.body.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ factor_type: 'totp', friendly_name: `squat-${RUN}` }),
    });

    const args = (password: string | null) => ({
      p_invite_id: invite.id,
      p_nonce: invite.nonce,
      p_password: password,
      p_tos_version: 'test',
      p_display_name: 'Rightful Invitee',
    });

    // Without the mailbox code the competing session cannot verify.
    const wrong = await squatter.rpc('verify_invite_challenge', { p_invite_id: invite.id, p_nonce: invite.nonce, p_code_digest: sha256Hex('000000') });
    expect(wrong.error, 'a wrong code must not raise; it answers verified: false').toBeNull();
    expect((wrong.data as { verified?: boolean }).verified).toBe(false);
    expect((await owner.rpc('verify_invite_challenge', { p_invite_id: invite.id, p_nonce: invite.nonce, p_code_digest: sha256Hex(code) })).error).toBeNull();

    // The competing session is refused even with a valid password.
    const stolen = await squatter.rpc('accept_invite', args('Squatter-pass-1'));
    expect(stolen.error?.message).toContain('challenge_session_mismatch');

    // F12: the RPC itself refuses a weak password, writing nothing.
    for (const weak of [null, '', '12345', 'x'.repeat(73)]) {
      const refused = await owner.rpc('accept_invite', args(weak));
      expect(refused.error?.message, `password ${JSON.stringify(weak)?.slice(0, 12)}`).toContain('weak_password');
    }
    expect((await profileOf(invitee.id)).status).toBe('invited');
    expect((await sessionsOf(invitee.id)).sort()).toEqual(
      [sessionId(competing.body.access_token), sessionId(recipient.body.access_token)].sort(),
    );

    const accepted = await owner.rpc('accept_invite', args('Rightful-pass-1'));
    expect(accepted.error).toBeNull();
    expect(await profileOf(invitee.id)).toMatchObject({ status: 'active', provisioning: 'authorized', tenant_id: tenant });
    expect(await sessionsOf(invitee.id)).toEqual([sessionId(recipient.body.access_token)]);
    const [{ factors }] = await sql(`select count(*)::int as factors from auth.mfa_factors where user_id = $1`, [invitee.id]);
    expect(factors).toBe(0);
    // The competing credential is gone; the competing token reads nothing.
    expect((await passwordSignIn(invitee.email, 'Initial-pass-1')).status).toBe(400);
    const { data: leaked } = await squatter.from('deals').select('id').eq('id', deal);
    expect(leaked ?? []).toEqual([]);
    // Lost response retry from the same session is idempotent.
    const retried = await owner.rpc('accept_invite', args('Rightful-pass-1'));
    expect(retried.error).toBeNull();
    expect(retried.data).toMatchObject({ duplicate: true });
    expect((await passwordSignIn(invitee.email, 'Rightful-pass-1')).status).toBe(200);
  });

  // ---- work-identity admittance, acceptance and connect ---------------------

  describe('work invitation (requires a keycloak test alias in the provider mapping)', () => {
    async function workInvite(address: string) {
      const [{ result }] = await sql<{ result: { id: string } }>(
        `select public.create_invite($1, $2, $3, 'member', null, null, $4, 'deal_team', 0, 'work_identity') as result`,
        [mdId, address, bank, deal],
      );
      await sql(`update public.invites set delivery_status = 'sent' where id = $1`, [result.id]);
      const [{ credential_nonce }] = await sql(`select credential_nonce from public.invites where id = $1`, [result.id]);
      return { id: result.id, nonce: credential_nonce as string };
    }

    async function startAttempt(invite: { id: string; nonce: string }) {
      const secret = b64u(randomBytes(32));
      const { data, error } = await admin.rpc('start_work_identity_attempt', {
        p_invite_id: invite.id,
        p_nonce: invite.nonce,
        p_secret_digest: sha256Hex(secret),
      });
      if (error) throw new Error(`start_work_identity_attempt: ${error.message}`);
      const attemptId = typeof data === 'string' ? data : (data as { attempt_id?: string; id?: string }).attempt_id ?? (data as { id: string }).id;
      return { attemptId, digest: sha256Hex(secret) };
    }

    // F14: bind an attempt to the PKCE challenge of the OAuth flow it belongs to.
    async function bindFlow(attempt: { attemptId: string; digest: string }, verifier: string) {
      const { error } = await admin.rpc('bind_work_identity_attempt_flow', {
        p_attempt_id: attempt.attemptId,
        p_secret_digest: attempt.digest,
        p_code_challenge: b64u(createHash('sha256').update(verifier).digest()),
      });
      if (error) throw new Error(`bind_work_identity_attempt_flow: ${error.message}`);
    }

    it('admits a pending work invitee, binds on acceptance, and re-admits the bound identity only', async (ctx) => {
      if (!mappingSupported) ctx.skip();
      const address = email('banker');
      const invite = await workInvite(address);
      const attempt = await startAttempt(invite);
      const identity = identityFor(address);

      const signedIn = await oauth(identity);
      expect(signedIn.status, refusal(signedIn.body)).toBe(200);
      const userId = signedIn.body!.user.id as string;
      createdUsers.push(userId);
      let token = signedIn.body!.access_token as string;

      // F14: an independent flow B for the same invitation cannot be claimed by
      // the session exchanged in flow A, even with B's cookie secret and B's
      // verifier. The browser role cannot call the claim at all; the server
      // claims only for the session its own exchange minted, and that session
      // predates attempt B.
      const other = await startAttempt(invite);
      const verifierB = b64u(randomBytes(32));
      await bindFlow(other, verifierB);
      await bindFlow(attempt, signedIn.verifier);
      const claimArgs = (a: typeof other, verifier: string) => ({
        p_attempt_id: a.attemptId, p_secret_digest: a.digest, p_code_verifier: verifier,
        p_user_id: userId, p_session_id: sessionId(token),
      });
      const direct = await asUser(token).rpc('claim_work_identity_attempt', claimArgs(other, verifierB));
      expect(direct.error?.message).toContain('permission denied');
      expect((await admin.rpc('claim_work_identity_attempt', claimArgs(other, verifierB))).error?.message)
        .toContain('attempt_flow_mismatch');
      expect((await admin.rpc('claim_work_identity_attempt', claimArgs(other, signedIn.verifier))).error?.message)
        .toContain('attempt_flow_mismatch');
      expect((await admin.rpc('claim_work_identity_attempt', claimArgs(attempt, signedIn.verifier))).error).toBeNull();
      const [otherRow] = await sql('select claimed_user_id from work_identity_attempts where id = $1', [other.attemptId]);
      expect(otherRow.claimed_user_id).toBeNull();

      // aal1 is not enough to accept.
      const early = await asUser(token).rpc('accept_work_identity_invite', {
        p_attempt_id: attempt.attemptId,
        p_secret_digest: attempt.digest,
        p_terms_version: 'test',
        p_display_name: 'Work Banker',
      });
      expect(early.error).not.toBeNull();

      token = await stepUpToAal2(token);
      const accepted = await asUser(token).rpc('accept_work_identity_invite', {
        p_attempt_id: attempt.attemptId,
        p_secret_digest: attempt.digest,
        p_terms_version: 'test',
        p_display_name: 'Work Banker',
      });
      expect(accepted.error).toBeNull();
      expect(await profileOf(userId)).toMatchObject({ status: 'active', company_id: bank, tenant_id: tenant });
      const bindings = await sql(`select provider, provider_subject, via from public.work_identity_bindings where user_id = $1`, [userId]);
      expect(bindings).toEqual([{ provider: LOGICAL, provider_subject: identity.sub, via: 'invite' }]);
      const [{ seats }] = await sql(`select count(*)::int as seats from public.deal_memberships where user_id = $1 and deal_id = $2`, [userId, deal]);
      expect(seats).toBe(1);

      // Return sign-in: the bound identity is admitted, no new membership.
      const back = await oauth(identity);
      expect(back.status, refusal(back.body)).toBe(200);
      expect(back.body!.user.id).toBe(userId);
      const [{ again }] = await sql(`select count(*)::int as again from public.deal_memberships where user_id = $1`, [userId]);
      expect(again).toBe(1);

      // A second same-email provider account (different subject) is not bound: refused.
      const impostor = await oauth({ ...identity, sub: `${identity.sub}-other` });
      expect(impostor.status).toBe(403);
      expect(refusal(impostor.body)).toContain('work_identity_not_connected');

      // Suspension shuts the bound identity out too.
      await sql(`update public.users set status = 'suspended' where id = $1`, [userId]);
      const suspended = await oauth(identity);
      expect(suspended.status).toBe(403);
      expect(refusal(suspended.body)).toContain('account_suspended');
    });

    it('refuses acceptance for the wrong account and the wrong organization', async (ctx) => {
      if (!mappingSupported) ctx.skip();
      const address = email('target-banker');
      const invite = await workInvite(address);

      // A different pending-free email is refused a token outright.
      const stranger = await oauth(identityFor(email('stranger')));
      expect(stranger.status).toBe(403);
      const strangerUser = await authUserByEmail(email('stranger'));
      if (strangerUser) createdUsers.push(strangerUser.id);

      // Right email, wrong organization claim: admitted as a pending invitee
      // (aal1), but acceptance refuses with work_identity_mismatch (the route
      // surfaces it as organization_mismatch).
      const attempt = await startAttempt(invite);
      const wrongOrg = await oauth(identityFor(address, { hd: 'other-org.example', tid: 'other-org.example' }));
      expect(wrongOrg.status, refusal(wrongOrg.body)).toBe(200);
      createdUsers.push(wrongOrg.body!.user.id);
      let token = wrongOrg.body!.access_token as string;
      await bindFlow(attempt, wrongOrg.verifier);
      const claimed = await admin.rpc('claim_work_identity_attempt', {
        p_attempt_id: attempt.attemptId, p_secret_digest: attempt.digest, p_code_verifier: wrongOrg.verifier,
        p_user_id: wrongOrg.body!.user.id, p_session_id: sessionId(token),
      });
      expect(claimed.error).toBeNull();
      token = await stepUpToAal2(token);
      const refused = await asUser(token).rpc('accept_work_identity_invite', {
        p_attempt_id: attempt.attemptId,
        p_secret_digest: attempt.digest,
        p_terms_version: 'test',
        p_display_name: 'Wrong Org',
      });
      expect(refused.error?.message).toContain('work_identity_mismatch');
      expect((await profileOf(wrongOrg.body!.user.id)).status).toBe('invited');
    });

    it('connects an existing password banker through flow_state provenance', async (ctx) => {
      if (!mappingSupported) ctx.skip();
      const banker = await provisioned('connect', { company_id: bank, company_role: 'member', is_external: false });
      const signedIn = await passwordSignIn(banker.email, 'Initial-pass-1');
      const token = await stepUpToAal2(signedIn.body.access_token);
      const secret = b64u(randomBytes(32));
      const begun = await asUser(token).rpc('begin_work_identity_connect', { p_provider: LOGICAL, p_secret_digest: sha256Hex(secret) });
      expect(begun.error).toBeNull();

      const identity = identityFor(banker.email);
      const linked = await oauth(identity, { linkWith: token, exchange: false });
      const completed = await asUser(token).rpc('complete_work_identity_connect', {
        p_secret_digest: sha256Hex(secret),
        p_auth_code: linked.code,
        p_code_verifier: linked.verifier,
      });
      expect(completed.error).toBeNull();
      const bindings = await sql(`select provider_subject, via from public.work_identity_bindings where user_id = $1`, [banker.id]);
      expect(bindings).toEqual([{ provider_subject: identity.sub, via: 'connect' }]);
      const back = await oauth(identity);
      expect(back.status, refusal(back.body)).toBe(200);
      expect(back.body!.user.id).toBe(banker.id);
    });
  });
});
