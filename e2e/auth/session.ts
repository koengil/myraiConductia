import fs from 'node:fs';
import path from 'node:path';
import { createServerClient } from '@supabase/ssr';

/** Storage state for the seeded Managing Director (Storm Duncan). */
export const MD_STATE_PATH = path.join(__dirname, '.state', 'md.json');

/** Seeded account emails follow `<slug>.intelibank@dev.com` (scripts/seed-data.ts). */
export const MD_EMAIL = 'md.intelibank@dev.com';

/**
 * Storage state for the seeded firm admin. The invite journey needs it for one
 * act only: a company's FIRST director invitation is a company-management
 * decision, so POST /api/v1/invites requires firm_role = 'admin' or a
 * directorship of that company (src/app/api/v1/invites/route.ts:197-211, and
 * again inside create_invite). Storm is a director of the BANK, so he is
 * neither for a freshly registered lead company — the product tells him so in
 * as many words ("A firm admin must send its first Company Director
 * invitation"). Everything else in the journey stays Storm's.
 */
export const ADMIN_STATE_PATH = path.join(__dirname, '.state', 'admin.json');

/** scripts/seed-data.ts: emailSlug 'admin', firmRole FIRM_ROLE.ADMIN. */
export const ADMIN_EMAIL = 'admin.intelibank@dev.com';

/**
 * Storage state for a seeded BANK MEMBER — the identity the step-ownership
 * journey needs on the other side of the deal. Alex Chen is the bank's
 * company-role member (scripts/seed-data.ts: emailSlug 'deal-team',
 * COMPANY_ROLE.MEMBER), so `resolveDealStepCapabilities` classifies them
 * internal and non-MD: exactly the account whose step rights are bounded by
 * assignment rather than by directorship.
 */
export const MEMBER_STATE_PATH = path.join(__dirname, '.state', 'member.json');

export const MEMBER_EMAIL = 'deal-team.intelibank@dev.com';

/**
 * A second seeded banker, at a different firm and on a mandate the MD holds no
 * seat on. The route-guard journey needs an identity that is NOT the fixture
 * persona: the seeded MD is literally named Storm Duncan and sits on the
 * Atlassian mandate, so asserting "the profile shows no fixture data" against
 * his own account would pass whatever the page rendered. Northwind is the one
 * seeded deal disjoint from the MD's, so the two mandates cannot coincide.
 */
export const SECOND_BANKER_STATE_PATH = path.join(__dirname, '.state', 'second-banker.json');

/** scripts/seed-data.ts: emailSlug 'nw-member', on Project Northwind only. */
export const SECOND_BANKER_EMAIL = 'nw-member.intelibank@dev.com';

/**
 * Morgan Vale, a bank director with a personal mailbox source and no say over the team inbox: the colleague who
 * holds personal copies of some of the team's messages (scripts/seed-data.ts: emailSlug 'ib-director'). The team inbox
 * journey mints this session itself (seededStorageState), so it needs no storage-state file.
 */
export const IB_DIRECTOR_EMAIL = 'ib-director.intelibank@dev.com';

/**
 * Pat Rivera, the firm's CCO (scripts/seed-data.ts: emailSlug 'cco', FIRM_ROLE.CCO): the overseer the team inbox
 * journey shows the flow to (the bell, both deals' Audit Trail, the audit chain). Minted by seededStorageState.
 */
export const CCO_EMAIL = 'cco.intelibank@dev.com';

export const EXTERNAL_STATE_PATH = path.join(__dirname, '.state', 'external.json');

/** scripts/seed-data.ts: emailSlug 'seller', isExternal true, no company. */
export const EXTERNAL_EMAIL = 'seller.intelibank@dev.com';
/**
 * A seated bank employee with COMPANY_ROLE.MEMBER and no seeded company
 * permission (scripts/seed-data.ts: emailSlug 'read-only'). The access journey
 * rewrites this account's employee access, so it must never be a director: a
 * director holds root company authority, which the product refuses to change.
 * Distinct from MEMBER_EMAIL above: that account carries deal-step rights the
 * access journey must not disturb.
 */
export const EMPLOYEE_EMAIL = 'read-only.intelibank@dev.com';

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

export type StorageState = { cookies: PlaywrightCookie[]; origins: [] };

export async function mintStorageState(opts: {
  supabaseUrl: string;
  publishableKey: string;
  email: string;
  password: string;
  baseURL: string;
}): Promise<StorageState> {
  const jar: Array<{ name: string; value: string }> = [];

  const client = createServerClient(opts.supabaseUrl, opts.publishableKey, {
    cookies: {
      getAll: () => [],
      setAll: (cookies) => {
        for (const cookie of cookies) jar.push({ name: cookie.name, value: cookie.value });
      },
    },
  });

  const { error } = await client.auth.signInWithPassword({
    email: opts.email,
    password: opts.password,
  });
  if (error) {
    throw new Error(`Could not mint a session for ${opts.email}: ${error.message}`);
  }
  if (jar.length === 0) {
    throw new Error(
      'signInWithPassword produced no cookies. The @supabase/ssr cookie adapter did not ' +
        'flush; check the installed version before weakening this check.',
    );
  }

  const target = new URL(opts.baseURL);
  return {
    cookies: jar.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: target.hostname,
      path: '/',
      // Storage state is minted per run; one day is far longer than any run.
      expires: Math.floor(Date.now() / 1000) + 86_400,
      httpOnly: false,
      secure: target.protocol === 'https:',
      sameSite: 'Lax' as const,
    })),
    origins: [],
  };
}

export async function seededStorageState(
  email: string,
  baseURL: string | undefined,
): Promise<StorageState> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!supabaseUrl || !publishableKey || !password) {
    throw new Error(
      'Minting a seeded session needs NEXT_PUBLIC_SUPABASE_URL, ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD (the same values ' +
        'the seed scripts used).',
    );
  }

  return mintStorageState({
    supabaseUrl,
    publishableKey,
    email,
    password,
    // Matches playwright.config.ts's HERMETIC_BASE_URL. The fallback only fires
    // if the `baseURL` fixture is somehow unset; it must not disagree with the
    // configured origin, or the cookie domain it stamps would not match what a
    // real run actually navigates against.
    baseURL: baseURL ?? 'http://localhost:3000',
  });
}

/**
 * Mints a seeded account's session and persists it where a Playwright project
 * or spec can point `storageState` at.
 */
export async function mintSeededSession(
  email: string,
  statePath: string,
  baseURL: string | undefined,
): Promise<void> {
  const state = await seededStorageState(email, baseURL);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
