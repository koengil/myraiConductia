import { createClient } from '@supabase/supabase-js';
import { combineChunks, createChunks, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import type { Evidence } from '../support/evidence';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { messagesFor } from '../support/inbox';
import { setNextMockIdentity, type MockIdentity } from '../support/mockOidc';
import { totpCodeWithWindowGuard } from '../support/totp';
import { writeTeardownManifest } from '../support/teardownManifest';
import type { JourneyContext, JourneyState } from '../steps/types';

/**
 * Issue #316: a banker joins with the firm's work account and returns with it.
 *
 *   invite -> ONE email -> /join -> provider (mock) -> MFA enrolment ->
 *   /join/confirm -> the deal; sign out -> /sign-in provider button -> MFA ->
 *   the same deal, no new seat; the wrong account and a suspended banker are
 *   denied.
 *
 * Hermetic-only and opt-in (E2E_WORK_IDENTITY=1). Google cannot be pointed at a
 * local issuer, so the Google journey needs the local stack wired to the mock
 * issuer as Supabase Auth's keycloak provider. The Microsoft journey runs the
 * REAL azure provider against the same mock (its `url` is the mock) and adds the
 * Entra-shaped refusals: guest, no xms_edov, foreign tenant, and the recheck on
 * refresh once the binding is gone.
 *
 * E2E_WORK_IDENTITY_PROVIDER picks the journey: `google` (default, the journey
 * this file always ran) or `azure`. Cases for the other provider skip, so
 * `playwright test --list` collects every case either way.
 *
 * Setup both journeys share, beyond the standard hermetic setup:
 *   - [auth.hook.custom_access_token] enabled = true with
 *     uri = "pg-functions://postgres/public/work_identity_access_token_hook";
 *   - the mock issuer running: node --import tsx e2e/support/mockOidc.ts
 *     (port MOCK_OIDC_PORT, default 56430, bound on 0.0.0.0);
 *   - the work_identity_onboarding flag row ON;
 *   - the seeded bank mapped: npx tsx scripts/set-firm-identity-provider.ts
 *     (PROVIDER and ORGANIZATION_ID = E2E_WORK_IDENTITY_ORG, see below);
 *   - NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in the test process, for
 *     the operator acts (suspension, binding removal) that have no UI.
 *
 * google (default):
 *   - [auth.external.keycloak] enabled = true,
 *     WORK_IDENTITY_MOCK_OIDC_URL=http://host.docker.internal:56430/realms/x;
 *   - the app built with WORK_IDENTITY_TEST_BROKER_PROVIDER=keycloak, and the
 *     keycloak broker alias row for the mapped provider;
 *   - the bank mapped google, organization futureproofing.com.
 *
 * azure (E2E_WORK_IDENTITY_PROVIDER=azure):
 *   - [auth.external.azure] enabled = true (supabase/config.toml ships it
 *     disabled; the CI job patches its own checkout),
 *     WORK_IDENTITY_MOCK_AZURE_SECRET set (any value), and
 *     WORK_IDENTITY_MOCK_AZURE_URL=http://host.docker.internal:56430/<tenant>
 *     where <tenant> is E2E_WORK_IDENTITY_ORG;
 *   - the app built WITHOUT WORK_IDENTITY_TEST_BROKER_PROVIDER, and no broker
 *     alias row, so auth.identities rows are provider `azure`;
 *   - the bank mapped azure, organization E2E_WORK_IDENTITY_ORG (a lower-case
 *     tenant GUID; a built-in test GUID when unset).
 *   Keycloak fallback for azure, if the real provider refuses the mock issuer:
 *   wire it as the google journey does (keycloak block, broker env, alias row
 *   for `azure`) and keep E2E_WORK_IDENTITY_PROVIDER=azure. The mock's userinfo
 *   carries the same Azure-shaped claims, so every case below applies unchanged.
 */
const ENABLED = process.env.E2E_WORK_IDENTITY === '1';
const MOCK = process.env.E2E_MOCK_OIDC_URL ?? `http://127.0.0.1:${process.env.MOCK_OIDC_PORT ?? 56430}`;

type Provider = 'google' | 'azure';
const PROVIDER_ENV = process.env.E2E_WORK_IDENTITY_PROVIDER ?? 'google';
if (PROVIDER_ENV !== 'google' && PROVIDER_ENV !== 'azure') {
  throw new Error(`E2E_WORK_IDENTITY_PROVIDER must be google or azure, not "${PROVIDER_ENV}"`);
}
const PROVIDER: Provider = PROVIDER_ENV;

/** The provider whose identities Supabase stores: keycloak when the app brokers through it. */
const BROKER = process.env.WORK_IDENTITY_TEST_BROKER_PROVIDER === 'keycloak' ? 'keycloak' : PROVIDER;

const DEFAULT_ORG: Record<Provider, string> = {
  google: 'futureproofing.com',
  azure: '5b0a8d5e-3c1f-4f6e-9a7d-2e4c6b8a1f30',
};
const ORG = process.env.E2E_WORK_IDENTITY_ORG ?? DEFAULT_ORG[PROVIDER];
/** A tenant that is not the firm's. */
const FOREIGN_TENANT = '9f3c7e21-6d4a-4b58-8c0e-7a1d2b3c4e5f';

/** The firm's provider button (/sign-in shows both; the seeded bank maps the one under test). */
const DEFAULT_BUTTON: Record<Provider, string> = {
  google: 'Continue with Google Workspace',
  azure: 'Continue with Microsoft',
};
const PROVIDER_BUTTON = new RegExp(process.env.E2E_WORK_IDENTITY_BUTTON ?? DEFAULT_BUTTON[PROVIDER]);

/** The journey's banker, shaped the way the provider under test reports a firm member. */
function memberIdentity(runId: string, email: string): MockIdentity {
  return PROVIDER === 'azure'
    ? { sub: `e2e-sub-${runId}`, email, tid: ORG, acct: 0, xms_edov: true }
    : { sub: `e2e-sub-${runId}`, email, email_verified: true, hd: ORG, tid: ORG };
}

/** Passes the TOTP gate on /two-factor, enrolling first when the page offers a secret. */
async function passMfa(page: Page, known?: string): Promise<string> {
  await page.waitForURL(/\/two-factor/);
  const manual = page.getByTestId('mfa-manual-secret');
  const secret = known ?? (await manual.innerText()).trim();
  await page.getByLabel('Six-digit code').fill(await totpCodeWithWindowGuard(secret));
  await page.getByRole('button', { name: /Verify/ }).click();
  // 'commit': the next page can hold its load event open; the caller asserts on what it renders.
  await page.waitForURL((url) => !url.pathname.startsWith('/two-factor'), { waitUntil: 'commit' });
  return secret;
}

function adminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '', {
    auth: { persistSession: false },
  });
}

/** The banker's profile row and bindings, read by the operator (service role). */
async function seatOf(email: string): Promise<{ id: string; status: string; bindings: number }> {
  const admin = adminClient();
  const { data: user, error } = await admin.from('users').select('id, status').eq('email', email).maybeSingle();
  expect(error).toBeNull();
  expect(user, `no profile for ${email}`).toBeTruthy();
  const { data: bindings, error: bindingError } = await admin
    .from('work_identity_bindings')
    .select('provider_subject')
    .eq('user_id', (user as { id: string }).id);
  expect(bindingError).toBeNull();
  return { ...(user as { id: string; status: string }), bindings: bindings?.length ?? 0 };
}

/** The identity Supabase stored for the banker: which provider signed in, and its claims. */
async function storedIdentity(userId: string) {
  const { data, error } = await adminClient().auth.admin.getUserById(userId);
  expect(error).toBeNull();
  const identities = (data.user?.identities ?? []).filter(
    (candidate) => candidate.provider !== 'email' && candidate.provider !== 'phone',
  );
  expect(identities, 'expected exactly one work-provider identity').toHaveLength(1);
  const identity = identities[0];
  return {
    provider: identity.provider,
    data: (identity.identity_data ?? {}) as Record<string, unknown> & {
      email_verified?: unknown;
      custom_claims?: Record<string, unknown>;
    },
  };
}

type Setup = { page: Page; evidence: Evidence; runId: string; since: string };

/** The MD opens a deal and invites `email` by work identity; returns the /join link from the ONE email. */
async function inviteByWorkIdentity({ page, evidence, runId, since }: Setup, email: string) {
  const state: JourneyState = {};
  const ctx = { page, evidence, runId, since, state } as JourneyContext;
  for (const step of [registerLead, createDeal]) {
    await step.act(ctx);
    await step.assertUi(ctx);
    await step.verify(ctx);
  }
  const dealCode = state.dealCode as string;
  const me = (await (await page.request.get('/api/v1/me')).json()) as { user: { company_id: string } };
  const invited = await page.request.post('/api/v1/invites', {
    data: { email, companyId: me.user.company_id, dealId: dealCode, dealRole: 'deal_team' },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  writeTeardownManifest([email]);

  // ONE email, carrying the /join link and no code and no Supabase action link.
  const [mail] = await messagesFor(email, { expect: 1 });
  const href = mail.html.match(/href="([^"]*\/join\?invite=[^"]*)"/)?.[1]?.replace(/&amp;/g, '&');
  expect(href, `no /join link in: ${mail.html.slice(0, 300)}`).toBeTruthy();
  expect(mail.html).not.toMatch(/<strong>\d{6}<\/strong>|\/auth\/v1\/verify/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await messagesFor(email, { expect: 1 }), 'a second email arrived').toHaveLength(1);
  return { dealCode, href: href as string };
}

/** Opens the invitation, signs in as `identity` at the provider, passes MFA; lands on /join/confirm. */
async function reachConfirm(join: Page, href: string, identity: MockIdentity): Promise<string> {
  await setNextMockIdentity(MOCK, identity);
  await join.goto(href);
  await join.getByRole('button', { name: PROVIDER_BUTTON }).click();
  const secret = await passMfa(join);
  await join.waitForURL(/\/join\/confirm/);
  return secret;
}

async function fillConfirm(join: Page, runId: string): Promise<void> {
  await join.getByLabel(/display name/i).fill(`Banker ${runId}`);
  await join.getByRole('checkbox').check();
}

const ACCEPT_BUTTON = /join|accept|continue/i;

/** Accepts on /join/confirm and waits for the deal. */
async function acceptInvitation(join: Page, runId: string, dealCode: string): Promise<void> {
  await fillConfirm(join, runId);
  await join.getByRole('button', { name: ACCEPT_BUTTON }).click();
  // The deal page can hold its load event open (CI run 39064775122 timed out here with the
  // page already rendered), so wait for the navigation to commit and assert on the page.
  await join.waitForURL(`**/projects/${dealCode}**`, { waitUntil: 'commit' });
  await expect(join.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

/**
 * Expires the session in the browser's cookie so the next request the app makes
 * has to refresh it (auth-js refreshes when `expires_at` is past). The refresh
 * runs the Custom Access Token hook, which is the recheck under test; nothing
 * else about the session is touched.
 */
async function expireSessionCookie(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const first = cookies.find((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name));
  expect(first, 'no Supabase session cookie in the browser context').toBeTruthy();
  const key = (first as { name: string }).name.replace(/\.\d+$/, '');
  const mine = cookies.filter((cookie) => cookie.name === key || cookie.name.startsWith(`${key}.`));
  const byName = new Map(mine.map((cookie) => [cookie.name, cookie.value]));
  const raw = await combineChunks(key, (name) => byName.get(name) ?? null);
  expect(raw, 'the session cookie could not be reassembled').toBeTruthy();

  const encoded = (raw as string).startsWith('base64-');
  const session = JSON.parse(encoded ? stringFromBase64URL((raw as string).slice(7)) : (raw as string)) as {
    expires_at?: number;
  };
  session.expires_at = Math.floor(Date.now() / 1000) - 120;
  const json = JSON.stringify(session);
  const rewritten = createChunks(key, encoded ? `base64-${stringToBase64URL(json)}` : json);

  const template = mine[0];
  for (const cookie of mine) await context.clearCookies({ name: cookie.name, domain: cookie.domain });
  await context.addCookies(rewritten.map((chunk) => ({ ...template, name: chunk.name, value: chunk.value })));
}

/** Skips unless the opt-in is set, the target is hermetic and (optionally) the journey is for `provider`. */
function gate(testInfo: TestInfo, provider?: Provider): void {
  test.skip(testInfo.project.name === 'live', 'the issuer is a local mock; there is nothing to assert against a deployed environment');
  test.skip(!ENABLED, 'set E2E_WORK_IDENTITY=1 with the mock issuer stack (see the header) to run');
  if (provider) test.skip(PROVIDER !== provider, `needs E2E_WORK_IDENTITY_PROVIDER=${provider}`);
}

// Supabase Auth (in Docker) addresses the mock issuer as host.docker.internal,
// and the browser follows that authorize redirect from the host, where the
// name does not resolve. Map it to loopback for this journey's browser only.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] } });

test('the work-identity onboarding journey', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  gate(testInfo);

  const bankerEmail = `e2e-banker-${runId}@futureproofing.com`;
  const banker = memberIdentity(runId, bankerEmail);
  const fresh = () => newCollectedContext(browser, { baseURL, storageState: { cookies: [], origins: [] } });

  // ---- the MD opens a deal and invites a colleague by work identity -------
  const { dealCode, href } = await inviteByWorkIdentity({ page, evidence, runId, since }, bankerEmail);

  // ---- the banker joins ---------------------------------------------------
  const joinContext = await fresh();
  const join = await joinContext.newPage();
  const secret = await reachConfirm(join, href, banker);
  await acceptInvitation(join, runId, dealCode);

  if (PROVIDER === 'azure') {
    // The provider that signed the banker in is the one under test, and its
    // claims landed where the SQL gate reads them.
    const seat = await seatOf(bankerEmail);
    const identity = await storedIdentity(seat.id);
    expect(identity.provider, 'the banker signed in through a different Supabase provider').toBe(BROKER);
    expect(String(identity.data.custom_claims?.tid).toLowerCase()).toBe(ORG);
    expect(String(identity.data.custom_claims?.acct)).toBe('0');
    expect(seat.bindings).toBe(1);
  }

  const dealsBefore = (await (await join.request.get('/api/v1/deals')).json()) as unknown[];

  // ---- sign out, return through the provider button -----------------------
  await join.getByRole('button', { name: /open profile menu$/ }).click();
  await join.getByRole('dialog', { name: 'Profile' }).getByRole('button', { name: 'Sign out' }).click();
  await join.waitForURL(/\/sign-in/);
  await setNextMockIdentity(MOCK, banker);
  await join.getByRole('button', { name: PROVIDER_BUTTON }).click();
  await passMfa(join, secret);
  await join.goto(`/projects/${dealCode}`, { waitUntil: 'commit' });
  await expect(join.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  const dealsAfter = (await (await join.request.get('/api/v1/deals')).json()) as unknown[];
  expect(dealsAfter, 'the return sign-in changed the banker’s seats').toEqual(dealsBefore);
  await joinContext.close();

  // ---- an uninvited account is denied -------------------------------------
  const wrongEmail = `e2e-other-${runId}@futureproofing.com`;
  writeTeardownManifest([wrongEmail]);
  const wrongContext = await fresh();
  const wrong = await wrongContext.newPage();
  await setNextMockIdentity(MOCK, { ...banker, sub: `e2e-wrong-${runId}`, email: wrongEmail });
  await wrong.goto('/sign-in');
  await wrong.getByRole('button', { name: PROVIDER_BUTTON }).click();
  await wrong.waitForURL(/\/sign-in/);
  await expect(wrong).toHaveURL(/error=work_identity_not_connected/);
  // Next's route announcer is also role=alert; pick the page's own message.
  await expect(wrong.getByRole('alert').filter({ hasText: /invitation/i })).toBeVisible();
  expect((await wrong.request.get('/api/v1/me')).status()).toBe(401);
  await wrongContext.close();

  // ---- a suspended banker is denied ---------------------------------------
  const { error } = await adminClient().from('users').update({ status: 'suspended' }).eq('email', bankerEmail);
  expect(error).toBeNull();
  const suspendedContext = await fresh();
  const suspended = await suspendedContext.newPage();
  await setNextMockIdentity(MOCK, banker);
  await suspended.goto('/sign-in');
  await suspended.getByRole('button', { name: PROVIDER_BUTTON }).click();
  await suspended.waitForURL(/\/sign-in/);
  await expect(suspended.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();
  expect((await suspended.request.get('/api/v1/me')).status()).toBe(401);
  await suspendedContext.close();

  writeTeardownManifest([bankerEmail, wrongEmail]);
});

// ---- azure: identities Entra can issue that must not become a seat --------
//
// Each is a pending invitee who signs in at the provider with the invited
// address and passes MFA, so the hook lets the session through; the seat is
// refused at accept, because the SQL gate (work_identity_org_claim) reports no
// organization for the identity.

type Refusal = {
  name: string;
  identity: (runId: string, email: string) => MockIdentity;
  /** True when the stored identity must show the claim absent, not merely false. */
  xmsEdovAbsent?: boolean;
};

const REFUSALS: Refusal[] = [
  {
    // A guest of the firm's tenant (a personal Microsoft account invited in): tid is the firm's.
    name: 'a guest of the firm tenant (acct 1, idp live.com)',
    identity: (runId, email) => ({
      sub: `e2e-guest-${runId}`,
      email,
      tid: ORG,
      acct: 1,
      idp: 'live.com',
      xms_edov: true,
    }),
  },
  {
    // Entra omits xms_edov when the domain is not Verified, and GoTrue's Azure parser
    // then stores the email as verified (IsEmailVerified; the mock states the same, see
    // its header). So only Conductia's rule (xms_edov must be true) refuses this one.
    name: 'a member with no xms_edov (domain not Verified)',
    identity: (runId, email) => ({ sub: `e2e-noedov-${runId}`, email, tid: ORG, acct: 0 }),
    xmsEdovAbsent: true,
  },
  {
    name: 'a member of another tenant',
    identity: (runId, email) => ({
      sub: `e2e-foreign-${runId}`,
      email,
      tid: FOREIGN_TENANT,
      acct: 0,
      xms_edov: true,
    }),
  },
];

for (const refusal of REFUSALS) {
  test(`azure refuses ${refusal.name}`, async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
    gate(testInfo, 'azure');

    const email = `e2e-azure-${runId}@futureproofing.com`;
    const { href } = await inviteByWorkIdentity({ page, evidence, runId, since }, email);

    const context = await newCollectedContext(browser, { baseURL, storageState: { cookies: [], origins: [] } });
    const join = await context.newPage();
    await reachConfirm(join, href, refusal.identity(runId, email));

    await fillConfirm(join, runId);
    const answered = join.waitForResponse(
      (response) => response.url().includes('/api/v1/work-identity/accept') && response.request().method() === 'POST',
    );
    await join.getByRole('button', { name: ACCEPT_BUTTON }).click();
    const response = await answered;
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'organization_mismatch' });
    await expect(join.getByRole('status').filter({ hasText: /approved work organization/i })).toBeVisible();
    expect(new URL(join.url()).pathname).toBe('/join/confirm');

    // No seat: the profile is still a pending invitee and nothing is bound.
    const seat = await seatOf(email);
    expect(seat.status).toBe('invited');
    expect(seat.bindings).toBe(0);

    const identity = await storedIdentity(seat.id);
    expect(identity.provider, 'the invitee signed in through a different Supabase provider').toBe(BROKER);
    if (refusal.xmsEdovAbsent) {
      // The refusal is the SQL rule's: the claim is absent although the email reads verified.
      expect(identity.data.custom_claims?.xms_edov).toBeUndefined();
      expect(identity.data.email_verified).toBe(true);
    }

    await context.close();
  });
}

// ---- azure: a session outlives its binding only until the next refresh ----

test('azure refuses a refresh once the binding is gone', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  gate(testInfo, 'azure');

  const email = `e2e-azure-${runId}@futureproofing.com`;
  const { dealCode, href } = await inviteByWorkIdentity({ page, evidence, runId, since }, email);

  const context = await newCollectedContext(browser, { baseURL, storageState: { cookies: [], origins: [] } });
  const member = await context.newPage();
  await reachConfirm(member, href, memberIdentity(runId, email));
  await acceptInvitation(member, runId, dealCode);
  expect((await member.request.get('/api/v1/me')).status()).toBe(200);

  // Control: with the binding in place, an expired session refreshes and stays signed in. This
  // is what makes the refusal below attributable to the binding and not to the cookie edit.
  await expireSessionCookie(context);
  await member.goto(`/projects/${dealCode}`, { waitUntil: 'commit' });
  await expect(member.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  expect((await member.request.get('/api/v1/me')).status()).toBe(200);

  // The operator removes the binding; the live access token is still valid.
  const seat = await seatOf(email);
  expect(seat.bindings).toBe(1);
  const { error } = await adminClient().from('work_identity_bindings').delete().eq('user_id', seat.id);
  expect(error).toBeNull();

  // The next refresh runs the hook, which now refuses the unbound identity.
  await expireSessionCookie(context);
  await member.goto(`/projects/${dealCode}`, { waitUntil: 'commit' });
  await member.waitForURL(/\/sign-in/, { waitUntil: 'commit' });
  expect((await member.request.get('/api/v1/me')).status()).toBe(401);

  await context.close();
});
