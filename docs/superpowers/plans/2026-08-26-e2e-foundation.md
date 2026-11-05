# Browser E2E Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Playwright browser E2E foundation (runner, config, API-minted auth, fixtures, selector contract, evidence layer, CI wiring) and one journey on it — the MD spine, single identity — so a regression in the path from lead to rail advance is caught by CI rather than by a human noticing it during a demo.

**Architecture:** `e2e/` is a second, self-contained suite beside vitest's `tests/`. A Playwright `setup` project mints a Supabase session with `@supabase/ssr` (the same cookie encoding the app writes) and saves it as storage state; journey specs start already inside the shell. Journeys are ordered lists of *step modules* (`act` / `assertUi` / `verify`), not page objects: each step drives the UI, asserts what the MD sees, then reads the durable row back through `/api/v1` as the MD. Two Playwright projects share that journey code — `hermetic` (no third-party credentials, gates merges) and `live` (real services, never gates).

**Tech Stack:** `@playwright/test` (chromium only) · Next.js 16 (`next build` + `next start` behind Playwright `webServer`) · local Supabase CLI stack (pinned `2.114.0`) · TypeScript · GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-26-e2e-foundation-design.md`

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **Selector contract, in priority order:** (1) `getByRole(role, { name })`; (2) `getByLabel` / `getByPlaceholder` for form fields; (3) `data-testid` **only** where roles genuinely cannot disambiguate — adding one is a normal product change in the same commit as the step that needs it; (4) never CSS or structural selectors, never assert on marketing copy.
- **One deliberate selector exception:** the compliance ribbon is asserted by `[data-compliance-status]`, and every `verify()` asserts the count is exactly one.
- **Every step asserts a visible outcome AND a durable consequence** read back through `/api/v1` as the MD (never with the service key).
- **No test that depends on a third-party service may block a merge.** The hermetic tier carries zero third-party credentials; the live tier has **no `pull_request` trigger** and `continue-on-error: true`.
- **CI jobs are per tier, never per journey.** Adding a journey means adding a spec file, never editing a workflow. Scale with `--shard`, never by splitting journeys into named jobs.
- **When a step is not yet wired, use `test.fixme()` carrying the issue number — never a weakened assertion.**
- **Hermetic `webServer` env block, exactly:**
  ```
  NEXT_PUBLIC_APP_ENV=dev
  DISABLE_MFA=1
  MFA_ENFORCEMENT=invite_only
  STORAGE_PROVIDER=local
  EMAIL_PROVIDER=noop
  ```
  `IGNATIOUS_*` and `ANTHROPIC_API_KEY` are deliberately unset (D6).
- **Supabase CLI pin:** `2.114.0` (`latest` flakes under the releases-API rate limit).
- **Node:** `.nvmrc` = 22 (`engines.node >= 22.12.0`).
- **Run-uniquing is always on:** entities created by a journey carry a `runId` suffix, in both tiers.
- **Brand voice in any visible copy this plan adds:** senior, precise, decisive; no em-dashes (ARIA/regulatory separators excepted).

## Spec deltas resolved during reconnaissance

Read these before starting. Each one changes what a task asserts, and each was verified against `feat/e2e-foundation` on 2026-08-26.

1. **Spec open question 1 — the unconfigured screening fallback IS deterministic.** `llmScreen()` returns `null` immediately when `ANTHROPIC_API_KEY` is absent (`src/lib/compliance/llm.ts:340`), and `fullScreenFields()` keeps the deterministic rule-pack verdict. A message with no promissory and no MNPI hits is `compliant` every time. The hermetic assertion therefore **names the verdict**: status `sent`, `llmChecked: false`.
2. **Spec open question 2 — deal creation from a registered lead exists.** `/leads` → `LeadRegistration` → `POST /api/v1/companies`; the Gate 0 wizard's `LeadTypeahead` reads that catalog and `POST /api/v1/deals` takes `targetCompanyId`. It is gated on the `gate0_api_create` flag, which the E2E stack must enable.
3. **Spec open question 3 — there is no close transition.** `deals.status` has a `closed` value (`src/lib/constants/deals.ts`) but **no route handler writes it**: `/api/v1/deals/[dealId]` exposes `GET` only, and no other handler sets `'closed'`. Step 6 is therefore split: `advanceRail` (real, wired: "Mark complete" → `PATCH /deals/{ref}/progress` → audit `advance`) plus a `test.fixme()` marking the absent close transition.
4. **Spec step 3 targets the rail, not `/deal-folder`.** `/projects/[projectId]/deal-folder` is the fixture explorer over the internal manifest; the surface backed by `/steps` and `/progress` is `/projects/[projectId]/rail`. The step module is named `openRail`.
5. **`simulated: true` is not on the outbox read model.** `toApiMessage()` (`src/app/api/v1/outbox/route.ts:78`) exposes `provider`, not `simulated`; the `simulated` marker lands in the audit detail (`src/lib/audit/serverAudit.ts:178`). The hermetic assertion is `provider === 'noop'` on the outbox row plus a `send` audit entry.
6. **`GET /deals/{ref}/progress` does not exist** — `PATCH` only. Rail-position evidence is `deals.current_step_seq` from `GET /deals/{ref}`.
7. **Feature flags default to disabled.** `seed-flags.ts` deliberately never writes `enabled`, and `isEnabled` fails closed. The E2E stack needs a separate enabling script (Task 1).
8. **The authenticated home is `/projects`, not `/`.** `src/app/page.tsx` renders the marketing landing under `NODE_ENV=production` (which `next start` sets). Journeys navigate to `/projects` and to `/projects/{code}/...` directly.

---

## File Structure

| Path | Responsibility |
|---|---|
| `playwright.config.ts` (create) | Runner config: the three projects, the hermetic `webServer` + env block, reporters, trace policy. |
| `scripts/enable-flags.ts` (create) | Set `feature_flags.enabled = true` for every key in `FLAG_REGISTRY`. Test/dev provisioning only. |
| `e2e/auth/session.ts` (create) | Mint a Supabase session for a seeded account and convert its cookies into a Playwright storage state. No Playwright assertions. |
| `e2e/auth/setup.ts` (create) | The `setup` project: writes `e2e/auth/.state/md.json`. |
| `e2e/support/runId.ts` (create) | Per-run unique suffix. |
| `e2e/support/evidence.ts` (create) | Typed thin client over `/api/v1`, one function per read the spine needs, plus `expectAudit`. |
| `e2e/support/selectors.ts` (create) | Selector-contract helpers (the compliance ribbon instrument, the shell). |
| `e2e/support/fixtures.ts` (create) | Custom `test` fixture: `page`, `evidence`, `runId`, `journey` context. |
| `e2e/steps/*.ts` (create) | One module per spine step: `act` / `assertUi` / `verify`. |
| `e2e/journeys/md-spine.spec.ts` (create) | The MD spine journey, project-agnostic. |
| `e2e/assets/e2e-fixture.pdf` (create) | Upload payload. |
| `.github/workflows/ci.yml` (modify) | Add the `e2e` job. |
| `.github/workflows/e2e-live.yml` (create) | The live tier: dispatch + nightly, never a gate. |
| `docs/03-engineering/e2e-testing.md` (create) | The selector contract and the tier rules, so the next journey follows them without asking. |
| `package.json` (modify) | `test:e2e`, `test:e2e:live`, `seed:flags:enable`, `@playwright/test` devDependency. |
| `.gitignore` (modify) | `e2e/auth/.state/`, `playwright-report/`, `test-results/`, `blob-report/`, `.playwright/`. |

---

## Task 1: Runner, hermetic stack, and API-minted authentication

Delivers: `npx playwright test --project=hermetic` boots the app, mints an MD session without touching `/sign-in`, and proves the MD lands inside the authenticated shell.

**Files:**
- Create: `playwright.config.ts`
- Create: `scripts/enable-flags.ts`
- Create: `e2e/auth/session.ts`
- Create: `e2e/auth/setup.ts`
- Create: `e2e/journeys/shell-smoke.spec.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `mintStorageState(opts: { supabaseUrl: string; publishableKey: string; email: string; password: string; baseURL: string }): Promise<{ cookies: Cookie[]; origins: [] }>` from `e2e/auth/session.ts`.
  - `MD_STATE_PATH: string` and `MD_EMAIL: string`, exported from `e2e/auth/session.ts`.
  - Playwright project names `setup`, `hermetic`, `live`; `hermetic`/`live` set `storageState: MD_STATE_PATH` and `baseURL`.

- [ ] **Step 1: Install the runner and register the scripts**

```bash
npm install --save-dev --save-exact @playwright/test@1.56.0
npx playwright install --with-deps chromium
```

Add to `package.json` `scripts` (keep the existing entries in place):

```json
    "test:e2e": "playwright test --project=hermetic",
    "test:e2e:live": "playwright test --project=live",
    "seed:flags:enable": "node --env-file-if-exists=.env.local --import tsx scripts/enable-flags.ts",
```

- [ ] **Step 2: Ignore the runner's artifacts**

Append to `.gitignore` under the existing `# Testing` section:

```
playwright-report/
test-results/
blob-report/
e2e/auth/.state/
```

- [ ] **Step 3: Write the flag-enabling script**

`FLAG_REGISTRY` is the source of truth for which flags exist; `seed:flags` deliberately never writes `enabled`, so a fresh database has every capability off and the spine would walk the pre-onboarding fixture surfaces.

Create `scripts/enable-flags.ts`:

```ts
import { createClient } from '@supabase/supabase-js';
import { FLAG_REGISTRY } from '../src/lib/flags/keys';

// Test/dev provisioning ONLY. Turns every flag in FLAG_REGISTRY on, so an E2E
// stack exercises the shipped capability rather than the pre-flag fallback.
// Deliberately separate from `seed:flags`, whose contract is that it never
// touches the runtime `enabled` toggle (ADR-0007).
async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  }
  if (process.env.NEXT_PUBLIC_APP_ENV === 'prod') {
    throw new Error('Refusing to force flags on in prod');
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const rows = Object.entries(FLAG_REGISTRY).map(([flagKey, def]) => ({
    key: flagKey,
    description: def.description,
    enabled: true,
  }));

  const { error } = await supabase
    .from('feature_flags')
    .upsert(rows, { onConflict: 'key', ignoreDuplicates: false });
  if (error) throw error;
  console.log(`Enabled ${rows.length} feature flag(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Write the session minter**

The cookie encoding must be the app's own, not a hand-rolled imitation: `@supabase/ssr` chunks and names cookies in a way the middleware and `requireApiUser` both read. So drive `createServerClient` with a capture-only cookie adapter and let it tell us what to write.

Create `e2e/auth/session.ts`:

```ts
import path from 'node:path';
import { createServerClient } from '@supabase/ssr';

/** Storage state for the seeded Managing Director (Storm Duncan). */
export const MD_STATE_PATH = path.join(__dirname, '.state', 'md.json');

/** Seeded account emails follow `<slug>.intelibank@dev.com` (scripts/seed-data.ts). */
export const MD_EMAIL = 'md.intelibank@dev.com';

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
```

- [ ] **Step 5: Write the setup project**

Create `e2e/auth/setup.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import { MD_EMAIL, MD_STATE_PATH, mintStorageState } from './session';

/**
 * The setup project. E2E specs do not drive /sign-in: the auth boundary is
 * covered at the unit tier (tests/middleware-mfa.test.ts, sign-in-mfa,
 * two-factor-page, mfa-policy, mfa-bypass) and re-driving it in a browser adds
 * cost without adding coverage (design D2).
 */
setup('mint the MD session', async ({ baseURL }) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!supabaseUrl || !publishableKey || !password) {
    throw new Error(
      'E2E setup needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ' +
        'and SEED_PASSWORD (the same values the seed scripts used).',
    );
  }

  const state = await mintStorageState({
    supabaseUrl,
    publishableKey,
    email: MD_EMAIL,
    password,
    baseURL: baseURL ?? 'http://127.0.0.1:3000',
  });

  fs.mkdirSync(path.dirname(MD_STATE_PATH), { recursive: true });
  fs.writeFileSync(MD_STATE_PATH, JSON.stringify(state, null, 2));
});
```

- [ ] **Step 6: Write the runner config**

Create `playwright.config.ts`:

```ts
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { MD_STATE_PATH } from './e2e/auth/session';

/**
 * Two tiers, one codebase (design D1). `hermetic` gates merges and carries no
 * third-party credentials; `live` runs against a deployed environment and is
 * structurally incapable of gating a merge (its workflow has no pull_request
 * trigger). Journey specs are project-agnostic: the same file runs under both.
 */
const LIVE_BASE_URL = process.env.E2E_BASE_URL;
const HERMETIC_BASE_URL = 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // No webServer when a live target is named: the live tier talks to a
  // deployed environment, never to a locally booted app.
  webServer: LIVE_BASE_URL
    ? undefined
    : {
        // NEXT_PUBLIC_* are inlined at build time, so the build must run under
        // this env block, not just the server.
        command: 'npm run build && npm run start -- --port 3000 --hostname 127.0.0.1',
        url: HERMETIC_BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          NEXT_PUBLIC_APP_ENV: 'dev',
          DISABLE_MFA: '1',
          MFA_ENFORCEMENT: 'invite_only',
          STORAGE_PROVIDER: 'local',
          EMAIL_PROVIDER: 'noop',
          NEXT_TELEMETRY_DISABLED: '1',
          // IGNATIOUS_* and ANTHROPIC_API_KEY are deliberately unset (D6): the
          // spine asserts the degraded state as a first-class outcome.
        },
      },

  projects: [
    {
      name: 'setup',
      testDir: path.join(__dirname, 'e2e/auth'),
      testMatch: /setup\.ts$/,
      use: { baseURL: LIVE_BASE_URL ?? HERMETIC_BASE_URL },
    },
    {
      name: 'hermetic',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
      },
    },
    {
      name: 'live',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: LIVE_BASE_URL ?? HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
      },
    },
  ],
});
```

- [ ] **Step 7: Write the failing smoke spec**

Create `e2e/journeys/shell-smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

/**
 * The foundation's own smoke: the stored session reaches the authenticated
 * shell without driving /sign-in, and the middleware does not bounce it to
 * /sign-in or /two-factor.
 */
test('the stored MD session lands inside the authenticated shell', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByRole('navigation', { name: 'Deals' })).toBeVisible();
});
```

- [ ] **Step 8: Boot a hermetic stack and run it to verify it fails honestly**

```bash
supabase init --force
supabase start
supabase db reset --local
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
export SEED_PASSWORD='e2e-local-password'
export NEXT_PUBLIC_APP_ENV=dev
export INVITE_VERIFICATION_PEPPER='e2e-local-pepper'
npm run seed:flags && npm run seed:flags:enable && npm run seed:users
npm run test:e2e
```

Expected on the first run: the smoke test FAILS on the `navigation` locator (the exact accessible name of the sidebar deal group is what this step pins down), while the `setup` project PASSES — the session minted, the page loaded, no redirect to `/sign-in`.

- [ ] **Step 9: Correct the smoke assertion against what actually renders**

Open the failure trace (`npx playwright show-report`) and replace the locator in `e2e/journeys/shell-smoke.spec.ts` with a role query that matches the rendered shell. The deal switcher is the stable landmark: `src/components/deals/DealSelect.tsx:212` labels it `Deal: {codename}. Switch deal` when a deal is active, `Select a deal` when none is. Use:

```ts
  await expect(
    page.getByRole('button', { name: /Switch deal|Select a deal/ }),
  ).toBeVisible();
```

Keep the `toHaveURL(/\/projects/)` assertion — it is the one that proves no auth bounce.

- [ ] **Step 10: Run it to verify it passes**

Run: `npm run test:e2e`
Expected: PASS, 1 setup + 1 test.

- [ ] **Step 11: Commit**

```bash
git add playwright.config.ts package.json package-lock.json .gitignore scripts/enable-flags.ts e2e/
git commit -m "test(e2e): playwright runner, hermetic stack, and API-minted MD session"
```

---

## Task 2: The support layer — runId, evidence, selectors, fixtures

Delivers: a `test` fixture that hands every journey a `runId`, a `page`, and an `evidence` client that reads `/api/v1` **as the MD**, proven by a self-test.

**Files:**
- Create: `e2e/support/runId.ts`
- Create: `e2e/support/selectors.ts`
- Create: `e2e/support/evidence.ts`
- Create: `e2e/support/fixtures.ts`
- Modify: `e2e/journeys/shell-smoke.spec.ts`

**Interfaces:**
- Consumes: `MD_STATE_PATH`, `MD_EMAIL` (Task 1).
- Produces:
  - `newRunId(): string` — e.g. `k3f9x2`.
  - `Evidence` class with `me()`, `listCompanies(query)`, `getDeal(ref)`, `listSteps(ref)`, `listDocuments(ref)`, `listOutbox()`, `listAudit(ref)`, `expectAudit(ref, opts)`.
  - `expectSingleComplianceInstrument(page: Page): Promise<void>` from `e2e/support/selectors.ts`.
  - `test` and `expect` re-exported from `e2e/support/fixtures.ts`, with fixtures `runId: string`, `evidence: Evidence`, `since: string`.

- [ ] **Step 1: Write the run-id helper**

Create `e2e/support/runId.ts`:

```ts
/**
 * Per-run unique suffix for created entities. The hermetic tier resets the
 * database per run and would not need it; the live tier runs against a shared
 * database somebody may be demonstrating on, and the journey code is shared —
 * so it is always on (design: data strategy).
 */
export function newRunId(): string {
  return Math.random().toString(36).slice(2, 8);
}
```

- [ ] **Step 2: Write the selector helper**

Create `e2e/support/selectors.ts`:

```ts
import { expect, type Page } from '@playwright/test';

/**
 * The one deliberate exception to the role-first selector contract. Compliance
 * is mounted exactly once by invariant (ComplianceRibbon in the floating
 * command console); that invariant is the thing worth testing, and
 * [data-compliance-status] is already the sanctioned hook for it. Asserted by
 * every verify(), so the invariant is checked continuously.
 */
export async function expectSingleComplianceInstrument(page: Page): Promise<void> {
  await expect(page.locator('[data-compliance-status]')).toHaveCount(1);
}
```

- [ ] **Step 3: Write the evidence client**

A thin typed wrapper with one function per read the spine needs — not a general-purpose HTTP client. It authenticates through the normal `requireApiUser` path, which exercises the access predicates in `src/lib/api/v1/access.ts` as a side effect.

Create `e2e/support/evidence.ts`:

```ts
import { expect, type APIRequestContext } from '@playwright/test';

export type AuditEvent = {
  id: string;
  ts: string;
  action: string;
  document_id: string | null;
  detail: unknown;
  actor: { id: string; full_name: string | null; display_name: string | null } | null;
};

export type DealRow = {
  id: string;
  code: string;
  codename: string;
  status: string;
  entry_step_seq: number | null;
  current_step_seq: number | null;
};

export type DealMember = {
  deal_role: string;
  user: { id: string; email: string } | null;
};

export type DocumentRow = {
  id: string;
  name: string;
  room: string;
  classification: number;
  hasFile: boolean;
  canOpen: boolean;
};

export type OutboxMessage = {
  id: string;
  status: string;
  verdict: string;
  provider: string | null;
  llmChecked: boolean;
  subject: string;
  to: string[];
};

export type StepRow = { stepId: string; seq: number; label: string; railStatus: string };

async function json<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return (await response.json()) as T;
}

/**
 * Reads back as the MD, not with the service key. The service key would prove a
 * row exists; the MD's own session proves the row exists AND is visible to the
 * identity that created it (design: evidence layer).
 */
export class Evidence {
  constructor(private readonly request: APIRequestContext) {}

  me() {
    return json<{ user: { id: string; email: string }; memberships: Array<{ deal_id: string; deal_role: string; deal_code: string | null }> }>(
      this.request,
      '/api/v1/me',
    );
  }

  listCompanies(query: string) {
    return json<{ companies: Array<{ id: string; name: string; type: string }> }>(
      this.request,
      `/api/v1/companies?query=${encodeURIComponent(query)}`,
    );
  }

  getDeal(ref: string) {
    return json<{ deal: DealRow; members: DealMember[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}`,
    );
  }

  listSteps(ref: string) {
    return json<{ steps: StepRow[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/steps`,
    );
  }

  listDocuments(ref: string) {
    return json<{ documents: DocumentRow[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/documents`,
    );
  }

  listOutbox() {
    return json<{ messages: OutboxMessage[] }>(this.request, '/api/v1/outbox');
  }

  listAudit(ref: string) {
    return json<{ events: AuditEvent[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/audit`,
    );
  }

  /**
   * One shared audit assertion. `since` is the run's start timestamp, so a
   * shared database carrying other people's rows cannot produce a false
   * positive (design: evidence layer).
   */
  async expectAudit(
    ref: string,
    opts: { action: string; actorId?: string; since: string },
  ): Promise<AuditEvent> {
    const { events } = await this.listAudit(ref);
    const match = events.find(
      (event) =>
        event.action === opts.action &&
        event.ts >= opts.since &&
        (!opts.actorId || event.actor?.id === opts.actorId),
    );
    expect(
      match,
      `no '${opts.action}' audit entry on ${ref} after ${opts.since}; saw: ${events
        .map((e) => `${e.action}@${e.ts}`)
        .join(', ')}`,
    ).toBeTruthy();
    return match as AuditEvent;
  }
}
```

- [ ] **Step 4: Write the fixtures**

The evidence context is built from the **same** storage state as the browser context, so `/api/v1` authenticates it exactly as it authenticates the page.

Create `e2e/support/fixtures.ts`:

```ts
import { test as base, request as playwrightRequest } from '@playwright/test';
import { MD_STATE_PATH } from '../auth/session';
import { Evidence } from './evidence';
import { newRunId } from './runId';

export const test = base.extend<{
  runId: string;
  since: string;
  evidence: Evidence;
}>({
  runId: async ({}, use) => {
    await use(newRunId());
  },
  since: async ({}, use) => {
    // The lower bound for every audit assertion in this test.
    await use(new Date(Date.now() - 5_000).toISOString());
  },
  evidence: async ({ baseURL }, use) => {
    const context = await playwrightRequest.newContext({
      baseURL,
      storageState: MD_STATE_PATH,
    });
    await use(new Evidence(context));
    await context.dispose();
  },
});

export { expect } from '@playwright/test';
```

- [ ] **Step 5: Write the failing self-test**

Replace the body of `e2e/journeys/shell-smoke.spec.ts` with:

```ts
import { expect, test } from '../support/fixtures';
import { MD_EMAIL } from '../auth/session';

/**
 * The foundation's own smoke: the stored session reaches the authenticated
 * shell without driving /sign-in, and the evidence client authenticates
 * through the same identity via the normal requireApiUser path.
 */
test('the stored MD session lands inside the authenticated shell', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/projects/);
  await expect(
    page.getByRole('button', { name: /Switch deal|Select a deal/ }),
  ).toBeVisible();
});

test('the evidence client reads /api/v1 as the same MD', async ({ evidence, runId }) => {
  const me = await evidence.me();
  expect(me.user.email).toBe(MD_EMAIL);
  expect(runId).toMatch(/^[a-z0-9]{6}$/);
});
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:e2e`
Expected: PASS, 2 tests. A 401 on `/api/v1/me` means the storage-state cookies are not reaching the API context — fix the cookie `domain`/`path` in `e2e/auth/session.ts` before continuing, never by widening the assertion.

- [ ] **Step 7: Commit**

```bash
git add e2e/support e2e/journeys/shell-smoke.spec.ts
git commit -m "test(e2e): run-id, evidence client, selector helper, and shared fixtures"
```

---

## Task 3: The step model and step 1 — registerLead

Delivers: the step-module contract, the MD spine spec file, and its first green step.

**Files:**
- Create: `e2e/steps/types.ts`
- Create: `e2e/steps/registerLead.ts`
- Create: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `Evidence` (Task 2), `expectSingleComplianceInstrument` (Task 2), the `test` fixture (Task 2).
- Produces:
  - `type JourneyContext = { page: Page; evidence: Evidence; runId: string; since: string; state: JourneyState }`.
  - `type JourneyState = { leadName?: string; leadCompanyId?: string; dealCode?: string; dealId?: string; documentName?: string; mailSubject?: string; stepSeqBefore?: number }`.
  - `type Step = { name: string; act(ctx): Promise<void>; assertUi(ctx): Promise<void>; verify(ctx): Promise<void> }`.
  - `registerLead: Step`.

- [ ] **Step 1: Write the step-module contract**

Steps are modules, not page objects: a page object organizes by screen, but the subject under test is a journey, and the same screen means different things at different points in it.

Create `e2e/steps/types.ts`:

```ts
import type { Page } from '@playwright/test';
import type { Evidence } from '../support/evidence';

/** Everything a later step needs from an earlier one. */
export type JourneyState = {
  leadName?: string;
  leadCompanyId?: string;
  dealCode?: string;
  dealId?: string;
  documentName?: string;
  mailSubject?: string;
  stepSeqBefore?: number;
};

export type JourneyContext = {
  page: Page;
  evidence: Evidence;
  runId: string;
  /** Lower bound for every audit assertion in this run. */
  since: string;
  state: JourneyState;
};

/**
 * A journey is an ordered list of steps. Each step's verify() runs only after
 * its assertUi() passes, so a failure reports the earliest true cause rather
 * than a cascade.
 */
export type Step = {
  name: string;
  act(ctx: JourneyContext): Promise<void>;
  assertUi(ctx: JourneyContext): Promise<void>;
  verify(ctx: JourneyContext): Promise<void>;
};
```

- [ ] **Step 2: Write the registerLead step**

Create `e2e/steps/registerLead.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 1 — register a lead on /leads. The lead persists as a `client`-type
 * company via POST /api/v1/companies and becomes selectable in the Gate 0
 * wizard's lead typeahead, which is how step 2 reaches it.
 */
export const registerLead: Step = {
  name: 'registerLead',

  async act(ctx) {
    ctx.state.leadName = `E2E Lead ${ctx.runId}`;

    await ctx.page.goto('/leads');
    await ctx.page.getByRole('button', { name: 'Register a lead' }).first().click();

    const dialog = ctx.page.getByRole('dialog', { name: 'Register a lead' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Company name (e.g. Atlassian)').fill(ctx.state.leadName);
    await dialog.getByRole('button', { name: 'Register lead' }).click();
  },

  async assertUi(ctx) {
    const leadName = ctx.state.leadName as string;
    await expect(
      ctx.page.getByRole('region', { name: 'Registered leads' }).getByText(leadName),
    ).toBeVisible();
  },

  async verify(ctx) {
    const leadName = ctx.state.leadName as string;
    const { companies } = await ctx.evidence.listCompanies(leadName);
    const lead = companies.find((company) => company.name === leadName);
    expect(lead, `no company named "${leadName}" via GET /api/v1/companies`).toBeTruthy();
    expect(lead?.type).toBe('client');
    ctx.state.leadCompanyId = lead?.id;

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 3: Write the journey spec**

Create `e2e/journeys/md-spine.spec.ts`:

```ts
import { expect, test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The MD spine, single identity: lead -> mandate -> rail -> data room -> mail
 * -> advance. Project-agnostic on purpose: the same file runs under the
 * hermetic and the live project (design D1).
 */
const SPINE: Step[] = [registerLead];

test('the MD spine', async ({ page, evidence, runId, since }) => {
  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of SPINE) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }

  expect(state.leadCompanyId, 'the journey produced no lead').toBeTruthy();
});
```

- [ ] **Step 4: Run it**

Run: `npm run test:e2e`
Expected: PASS. Two failure modes to handle without weakening assertions:
- The `[data-compliance-status]` count is 0 on `/leads`. That is correct product behavior — the floating command console is scoped to project routes (`src/components/shell/AppShell.tsx:25`). Fix it in `e2e/support/selectors.ts` by making the helper assert *at most one* on non-project routes and *exactly one* on project routes:

```ts
export async function expectSingleComplianceInstrument(page: Page): Promise<void> {
  const isProjectRoute = /\/projects\/[^/]+/.test(new URL(page.url()).pathname);
  await expect(page.locator('[data-compliance-status]')).toHaveCount(isProjectRoute ? 1 : 0);
}
```

- The registered lead does not appear in the list without a reload. If so, the assertion stays as written and the product bug is reported; the step does **not** gain a `page.reload()` to paper over it.

- [ ] **Step 5: Commit**

```bash
git add e2e/steps e2e/journeys/md-spine.spec.ts e2e/support/selectors.ts
git commit -m "test(e2e): step model and the MD spine's registerLead step"
```

---

## Task 4: Step 2 — createDeal

Delivers: the Gate 0 wizard driven end to end, landing on the deal's rail, with the deal row, the MD membership, and the `create` audit entry read back.

**Files:**
- Create: `e2e/steps/createDeal.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `Step`, `JourneyContext` (Task 3); `ctx.state.leadName` set by `registerLead`.
- Produces: `createDeal: Step`; sets `ctx.state.dealCode` (the human-readable deal code, which is the `/projects/{...}` URL segment) and `ctx.state.dealId` (the UUID).

- [ ] **Step 1: Write the createDeal step**

The wizard's visible sub-steps are code name → conflicts → team → notify (the entry-point picker is hidden; `VISIBLE_WIZARD_STEPS`, `Gate0Wizard.tsx:140`), so the path is three `Next` clicks then `Create the mandate`. Advancing off the code-name sub-step needs a selected lead and a code name that does not contain the target's name; advancing off conflicts needs an approver, a date, and the attestation checkbox.

Create `e2e/steps/createDeal.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const CONFLICTS_APPROVER = 'Pat Rivera';

/**
 * Step 2 — open the mandate through Gate 0. The wizard is a dialog launched
 * from the sidebar deal switcher, not a route: the gate is a short ceremony and
 * the created deal owns the destination URL, not the wizard.
 */
export const createDeal: Step = {
  name: 'createDeal',

  async act(ctx) {
    const codename = `Project E2E ${ctx.runId}`;

    await ctx.page.goto('/projects');
    await ctx.page.getByRole('button', { name: /Switch deal|Select a deal/ }).click();
    await ctx.page.getByRole('menuitem', { name: 'New deal' }).click();

    const wizard = ctx.page.getByRole('dialog', { name: 'New mandate' });
    await expect(wizard).toBeVisible();

    // Sub-step 1 — the lead, then the code name.
    await wizard.getByPlaceholder('Search a registered lead…').fill(ctx.state.leadName as string);
    await wizard
      .getByRole('listbox', { name: 'Matching companies' })
      .getByRole('option', { name: ctx.state.leadName as string })
      .click();
    await wizard.getByLabel('Code name').fill(codename);
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Sub-step 2 — the senior-partner conflicts approval.
    await wizard.getByLabel('Approved by').fill(CONFLICTS_APPROVER);
    await wizard.getByLabel('Confirm the conflicts approval').check();
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Sub-step 3 — team. Defaults are accepted; the roster is not the subject
    // of this journey.
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Sub-step 4 — notify compliance and management, then create.
    await wizard.getByRole('button', { name: 'Create the mandate' }).click();
  },

  async assertUi(ctx) {
    // The wizard routes to /projects/{code}/rail?new=1 on success.
    await ctx.page.waitForURL(/\/projects\/[^/]+\/rail/);
    const code = new URL(ctx.page.url()).pathname.split('/')[2];
    expect(code, 'no deal code in the landing URL').toBeTruthy();
    ctx.state.dealCode = decodeURIComponent(code);

    await expect(
      ctx.page.getByRole('heading', { name: `Project E2E ${ctx.runId}` }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal, members } = await ctx.evidence.getDeal(ref);
    ctx.state.dealId = deal.id;

    expect(deal.codename).toBe(`Project E2E ${ctx.runId}`);
    expect(deal.code).toBe(ref);

    const me = await ctx.evidence.me();
    const mine = members.find((member) => member.user?.id === me.user.id);
    expect(mine, 'the creating MD is not a member of the deal').toBeTruthy();

    await ctx.evidence.expectAudit(ref, {
      action: 'create',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Wire it into the journey**

In `e2e/journeys/md-spine.spec.ts`, add the import and extend the list:

```ts
import { createDeal } from '../steps/createDeal';
```

```ts
const SPINE: Step[] = [registerLead, createDeal];
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: PASS.

If the wizard reports "No leads registered yet" the `gate0_api_create` flag is off — re-run `npm run seed:flags:enable` against the stack rather than changing the step. If the "Approved on" date is empty and `Next` stays disabled, add `await wizard.getByLabel('Approved on').fill(new Date().toISOString().slice(0, 10));` before the checkbox.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/createDeal.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): drive Gate 0 and verify the deal, membership, and create audit"
```

---

## Task 5: Step 3 — openRail

Delivers: the rail renders for the new deal with its phases and active step, and the displayed position matches the server.

**Files:**
- Create: `e2e/steps/openRail.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `ctx.state.dealCode` (Task 4).
- Produces: `openRail: Step`; sets `ctx.state.stepSeqBefore` (the deal's `current_step_seq` before any advance), consumed by Task 8.

- [ ] **Step 1: Write the openRail step**

Create `e2e/steps/openRail.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 3 — the deal rail: the canonical sell-side lifecycle as phases and
 * steps, with the cursor on the entry step Gate 0 chose. `/deal-folder` is the
 * fixture explorer over the internal manifest; the surface backed by /steps and
 * the persisted rail position is /rail.
 */
export const openRail: Step = {
  name: 'openRail',

  async act(ctx) {
    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`);
  },

  async assertUi(ctx) {
    // Focus view carries the position readout ("N of M · Phase P").
    await ctx.page.getByRole('button', { name: 'Focus' }).click();
    await expect(ctx.page.getByRole('region', { name: 'Deal rail · focus' })).toBeVisible();
    await expect(ctx.page.getByText(/\d+ of \d+ · Phase \d+/)).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    const { steps } = await ctx.evidence.listSteps(ref);
    expect(steps.length, 'the deal has no rail steps').toBeGreaterThan(0);

    const { deal } = await ctx.evidence.getDeal(ref);
    const seq = deal.current_step_seq ?? deal.entry_step_seq;
    expect(seq, 'the deal has no rail position').toBeTruthy();
    ctx.state.stepSeqBefore = seq as number;

    // The rendered position and the server's cursor are the same number.
    await expect(
      ctx.page.getByText(new RegExp(`\\b${seq} of \\d+ · Phase \\d+`)),
    ).toBeVisible();

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Wire it into the journey**

```ts
import { openRail } from '../steps/openRail';
```

```ts
const SPINE: Step[] = [registerLead, createDeal, openRail];
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: PASS.

Note on the position readout: `DealRail` renders `{progress.done} of {progress.total}`, where `progress.done` is derived from the rail cursor index, not directly from `current_step_seq`. If the two are off by a constant, replace the last `expect` in `verify()` with an assertion that the focused step's title matches the label of the step whose `seq === seq` in the `/steps` response — that is the same claim ("the displayed phase matches the server") expressed against a stable identifier, not a weakening of it.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/openRail.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): rail renders and its position matches the server"
```

---

## Task 6: Step 4 — uploadToDataRoom

Delivers: a PDF uploaded through the live data room, appearing in the room and recorded as a document row plus an `upload` audit entry.

**Files:**
- Create: `e2e/assets/e2e-fixture.pdf`
- Create: `e2e/steps/uploadToDataRoom.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `ctx.state.dealCode` (Task 4).
- Produces: `uploadToDataRoom: Step`; sets `ctx.state.documentName`.

- [ ] **Step 1: Create the upload payload**

A real, minimal, valid PDF — not a renamed text file, because the upload path stores bytes through the storage seam and records a content type.

```bash
mkdir -p e2e/assets
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > e2e/assets/e2e-fixture.pdf
file e2e/assets/e2e-fixture.pdf
```

Expected from `file`: `PDF document`.

- [ ] **Step 2: Write the uploadToDataRoom step**

Create `e2e/steps/uploadToDataRoom.ts`:

```ts
import path from 'node:path';
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const FIXTURE = path.join(__dirname, '..', 'assets', 'e2e-fixture.pdf');

/**
 * Step 4 — the deal room. With platform_onboarding on this is the live
 * document store over GET/POST /api/v1/deals/{dealId}/documents; the server
 * walls rows per viewer and every upload is audited.
 */
export const uploadToDataRoom: Step = {
  name: 'uploadToDataRoom',

  async act(ctx) {
    ctx.state.documentName = `E2E Upload ${ctx.runId}.pdf`;

    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/data-room`,
    );

    const panel = ctx.page.getByRole('region', { name: 'Upload a document' });
    await expect(panel).toBeVisible();
    await panel.getByLabel('File').setInputFiles(FIXTURE);
    await panel.getByLabel('Name override (optional)').fill(ctx.state.documentName);
    await panel.getByRole('button', { name: 'Upload' }).click();
  },

  async assertUi(ctx) {
    await expect(
      ctx.page.getByRole('region', { name: 'Deal room' }).getByText(ctx.state.documentName as string),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { documents } = await ctx.evidence.listDocuments(ref);
    const doc = documents.find((d) => d.name === ctx.state.documentName);
    expect(doc, `no document named "${ctx.state.documentName}" on the deal`).toBeTruthy();
    expect(doc?.hasFile, 'the document row carries no stored file').toBe(true);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'upload',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 3: Wire it into the journey**

```ts
import { uploadToDataRoom } from '../steps/uploadToDataRoom';
```

```ts
const SPINE: Step[] = [registerLead, createDeal, openRail, uploadToDataRoom];
```

- [ ] **Step 4: Run it**

Run: `npm run test:e2e`
Expected: PASS. The upload rides `LocalStorage` (Supabase Storage `dataroom` bucket, created by `supabase/migrations/20260731121000_dataroom_bucket.sql`) because `STORAGE_PROVIDER=local` — no Box credentials are involved.

If the "Deal room" region name does not match, read the rendered section title from the trace and use it verbatim; `RoomSection` sets `aria-label={title}` (`src/components/dataroom/DataRoomLive.tsx:155`).

- [ ] **Step 5: Commit**

```bash
git add e2e/assets e2e/steps/uploadToDataRoom.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): upload to the deal room and verify the row and its audit"
```

---

## Task 7: Step 5 — composeAndSendMail

Delivers: a message composed, screened, and sent through the noop transport, with the receipt shown and the outbox row read back.

**Files:**
- Create: `e2e/steps/composeAndSendMail.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `ctx.state.dealCode` (Task 4).
- Produces: `composeAndSendMail: Step`; sets `ctx.state.mailSubject`.

- [ ] **Step 1: Write the composeAndSendMail step**

The body must be benign: the deterministic rule pack decides the verdict without an LLM (`ANTHROPIC_API_KEY` is unset), so a message with no promissory and no MNPI hits screens `compliant` every time, which is why this assertion may name the verdict rather than settle for "a verdict was produced".

Create `e2e/steps/composeAndSendMail.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const RECIPIENT = 'e2e.counterparty@dev.com';
// Deliberately routine logistics: no promissory commitment, no MNPI signal.
const BODY = 'Confirming the working session on Thursday at ten. The agenda follows tomorrow.';

/**
 * Step 5 — the compliance email client. Nothing leaves unscreened: the fast
 * layer runs as you type, the full layer runs server-side on send, and the
 * verdict decides the outcome. Under EMAIL_PROVIDER=noop the send succeeds and
 * is marked simulated, so screen -> verdict -> outbox is exercised end to end.
 */
export const composeAndSendMail: Step = {
  name: 'composeAndSendMail',

  async act(ctx) {
    ctx.state.mailSubject = `E2E Spine ${ctx.runId}`;

    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/mail`);
    await ctx.page.getByRole('button', { name: 'New message' }).click();

    const composer = ctx.page.getByRole('region', { name: 'Compose email' });
    await expect(composer).toBeVisible();
    await composer.getByLabel('To').fill(RECIPIENT);
    await composer.getByPlaceholder('Subject').fill(ctx.state.mailSubject);
    await composer.getByRole('textbox', { name: 'Message' }).click();
    await ctx.page.keyboard.type(BODY);
    await composer.getByRole('button', { name: 'Send' }).click();
  },

  async assertUi(ctx) {
    await expect(
      ctx.page.getByText('Screened and delivered to the provider.'),
    ).toBeVisible();
  },

  async verify(ctx) {
    const { messages } = await ctx.evidence.listOutbox();
    const sent = messages.find((message) => message.subject === ctx.state.mailSubject);
    expect(sent, `no outbox receipt for "${ctx.state.mailSubject}"`).toBeTruthy();
    expect(sent?.status).toBe('sent');
    expect(sent?.verdict).toBe('compliant');
    expect(sent?.to).toContain(RECIPIENT);
    // The hermetic tier runs the noop transport: the send is real end to end
    // and nothing left the building.
    if (!process.env.E2E_BASE_URL) {
      expect(sent?.provider).toBe('noop');
      expect(sent?.llmChecked).toBe(false);
    }

    const ref = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, { action: 'screen', actorId: me.user.id, since: ctx.since });
    await ctx.evidence.expectAudit(ref, { action: 'send', actorId: me.user.id, since: ctx.since });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Wire it into the journey**

```ts
import { composeAndSendMail } from '../steps/composeAndSendMail';
```

```ts
const SPINE: Step[] = [registerLead, createDeal, openRail, uploadToDataRoom, composeAndSendMail];
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: PASS.

Two things to check, not to paper over:
- If the mail surface 404s, the `mail_channel` flag is off (`requireFlag('mail_channel')` is the server-side kill switch) — re-run `npm run seed:flags:enable`.
- If the `screen` / `send` audit entries are not on the deal, the composer sent without a deal reference. `MailClient` passes `resolveProjectId(params?.projectId)` as `dealRef` and `resolveDealRefLenient` resolves the code, so this should hold; if it does not, assert the entries at the tenant level is **not** the fix — file it and mark this specific assertion `test.fixme()` with the issue number.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/composeAndSendMail.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): compose, screen, and send through the noop transport"
```

---

## Task 8: Step 6 — advanceRail, and the absent close transition

Delivers: the rail advanced from the UI with the new cursor and the `advance` audit entry read back, plus an honest `test.fixme()` for the close transition that does not exist.

**Files:**
- Create: `e2e/steps/advanceRail.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `ctx.state.dealCode` (Task 4), `ctx.state.stepSeqBefore` (Task 5).
- Produces: `advanceRail: Step`.

- [ ] **Step 1: Write the advanceRail step**

"Mark complete" moves the cursor and persists it: `markComplete` → `persistProgress` → `PATCH /api/v1/deals/{ref}/progress`, which writes `deals.current_step_seq` and audits `advance` with the from/to seq.

Create `e2e/steps/advanceRail.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 6 — advance the deal. There is no close transition to drive: deals.status
 * has a 'closed' value but no route handler writes it (GET is the only method on
 * /api/v1/deals/[dealId]), so the durable forward movement this journey can
 * honestly assert is the rail cursor. The close transition is marked fixme in
 * the spec rather than faked here.
 */
export const advanceRail: Step = {
  name: 'advanceRail',

  async act(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail?view=focus`,
    );
    await ctx.page.getByRole('button', { name: 'Mark complete' }).click();
  },

  async assertUi(ctx) {
    const before = ctx.state.stepSeqBefore as number;
    // The position readout moves off the pre-advance number.
    await expect(ctx.page.getByText(new RegExp(`\\b${before} of \\d+ · Phase \\d+`))).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const before = ctx.state.stepSeqBefore as number;

    await expect
      .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
        message: 'the rail advance never reached the server',
      })
      .toBeGreaterThan(before);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'advance',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Wire it into the journey and record the absent close transition**

In `e2e/journeys/md-spine.spec.ts`:

```ts
import { advanceRail } from '../steps/advanceRail';
```

```ts
const SPINE: Step[] = [
  registerLead,
  createDeal,
  openRail,
  uploadToDataRoom,
  composeAndSendMail,
  advanceRail,
];
```

Then append, after the existing `test(...)` block:

```ts
// No route handler writes deals.status = 'closed' (GET is the only method on
// /api/v1/deals/[dealId]), so there is no close transition for the MD to drive.
// The suite's job is to make that visible, not to absorb it.
test.fixme('the MD closes the deal and the transition is audited', async () => {});
```

- [ ] **Step 3: File the gap**

```bash
gh issue create \
  --title "No close transition: deals.status can never reach 'closed' through the API" \
  --body "The MD spine E2E journey (e2e/journeys/md-spine.spec.ts) marks the close step test.fixme(). deals.status carries a 'closed' value (src/lib/constants/deals.ts) but no route handler writes it: /api/v1/deals/[dealId] exposes GET only. Wire the transition, then unskip the fixme."
```

Replace the bare `test.fixme(...)` title with the issue number once it exists, e.g. `test.fixme('#NNN — the MD closes the deal and the transition is audited', ...)`.

- [ ] **Step 4: Run it**

Run: `npm run test:e2e`
Expected: PASS, with 1 skipped.

- [ ] **Step 5: Commit**

```bash
git add e2e/steps/advanceRail.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): advance the rail and mark the absent close transition fixme"
```

---

## Task 9: The Ignatious degraded state as a first-class outcome (D6)

Delivers: the hermetic tier asserting that an unconfigured Ignatious degrades visibly and cleanly on a skill-bearing surface, with nothing thrown and no `console.error` escaping.

**Files:**
- Create: `e2e/steps/assertSkillsDegraded.ts`
- Modify: `e2e/journeys/md-spine.spec.ts`

**Interfaces:**
- Consumes: `ctx.state.dealCode` (Task 4).
- Produces: `assertSkillsDegraded: Step`.

- [ ] **Step 1: Write the degraded-state step**

`readIgnatiousConfig()` returns `null` with no `IGNATIOUS_CONTROL_PLANE_URL` / `IGNATIOUS_API_KEY`, and every server-side caller degrades to a clean `503` with an explanatory message rather than throwing. `BenchCatalog` renders that message verbatim as `role="status"`.

Create `e2e/steps/assertSkillsDegraded.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const UNCONFIGURED =
  'Ignatious is not configured. Set IGNATIOUS_CONTROL_PLANE_URL and IGNATIOUS_API_KEY.';

/**
 * D6 — the hermetic tier does not configure Ignatious and does not stub it. The
 * degraded path is real behavior the beta can hit when credentials lapse, so it
 * is asserted as a first-class outcome: the surface renders, the unconfigured
 * message is visible, nothing throws, and no console.error escapes. Real skill
 * execution is live-tier only.
 */
export const assertSkillsDegraded: Step = {
  name: 'assertSkillsDegraded',

  async act(ctx) {
    // Live tier: Ignatious IS configured there, so this step asserts nothing.
    if (process.env.E2E_BASE_URL) return;

    ctx.page.on('console', (message) => {
      if (message.type() === 'error') {
        throw new Error(`console.error escaped the skills surface: ${message.text()}`);
      }
    });
    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/skills`);
  },

  async assertUi(ctx) {
    if (process.env.E2E_BASE_URL) return;
    const bench = ctx.page.getByRole('region', { name: 'Ignatious skill bench' });
    await expect(bench).toBeVisible();
    await expect(bench.getByText(UNCONFIGURED)).toBeVisible();
  },

  async verify(ctx) {
    if (process.env.E2E_BASE_URL) return;
    const response = await ctx.page.request.get('/api/v1/bench/skills');
    expect(response.status(), 'the unconfigured bench must degrade, not throw').toBe(503);
    expect((await response.json()).error).toBe(UNCONFIGURED);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Wire it into the journey**

Place it after `openRail` — the deal exists, and it runs before the surfaces that mutate state, so a crash here is reported on its own terms.

```ts
import { assertSkillsDegraded } from '../steps/assertSkillsDegraded';
```

```ts
const SPINE: Step[] = [
  registerLead,
  createDeal,
  openRail,
  assertSkillsDegraded,
  uploadToDataRoom,
  composeAndSendMail,
  advanceRail,
];
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e`
Expected: PASS.

If the console listener trips on an unrelated pre-existing error (a favicon 404, a React hydration warning promoted to error), narrow it to messages whose text mentions Ignatious or the bench path rather than removing it.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/assertSkillsDegraded.ts e2e/journeys/md-spine.spec.ts
git commit -m "test(e2e): assert the unconfigured Ignatious degraded state (D6)"
```

---

## Task 10: The hermetic CI job

Delivers: an "E2E (hermetic)" job on `ci.yml` that runs the whole hermetic suite on every pull request with zero third-party credentials, and uploads the trace and HTML report on failure.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run test:e2e` (Task 1) and the seeded stack contract (Task 1 Step 8).
- Produces: a required status check named `E2E (hermetic)`.

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml`, after the `integration` job and before `security` (indentation: two spaces, matching its siblings):

```yaml
  e2e:
    # Browser E2E, hermetic tier. Zero third-party credentials by construction:
    # Box falls back to LocalStorage (STORAGE_PROVIDER=local), email rides the
    # noop transport, Anthropic screening and Ignatious are unconfigured and
    # their degraded paths are asserted. A third-party outage cannot fail this
    # job, which is why it is allowed to gate a merge (design D4).
    #
    # One job per TIER, never per journey (design D5): adding a journey means
    # adding a spec file. When the suite outgrows the timeout, scale it with
    # `--shard=${{ matrix.shard }}/N`.
    name: E2E (hermetic)
    runs-on: ubuntu-latest
    timeout-minutes: 25

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Chromium
        run: npx playwright install --with-deps chromium

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          # Pinned for the same reason as the integration job: `latest`
          # resolves via the GitHub releases API and flakes under rate limit.
          version: 2.114.0

      - name: Start local Supabase and apply migrations
        run: |
          supabase init --force
          supabase start
          supabase db reset --local

      - name: Seed the tenant and run the hermetic suite
        run: |
          eval "$(supabase status -o env)"
          export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
          export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
          export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
          npm run seed:flags
          npm run seed:flags:enable
          npm run seed:users
          npm run test:e2e
        env:
          NEXT_PUBLIC_APP_ENV: dev
          SEED_PASSWORD: e2e-ci-password
          INVITE_VERIFICATION_PEPPER: e2e-ci-pepper
          NEXT_TELEMETRY_DISABLED: 1

      - name: Upload the report and traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-hermetic-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

- [ ] **Step 2: Verify the workflow parses**

```bash
npx --yes yaml-lint .github/workflows/ci.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"
```

Expected: `ok` (or the linter's success output).

- [ ] **Step 3: Commit and confirm the job runs green on a pull request**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(e2e): run the hermetic browser suite on every pull request"
git push -u origin feat/e2e-foundation
gh pr create --fill --base develop
gh pr checks --watch
```

Expected: `E2E (hermetic)` passes. If it is the only red check, read the uploaded report artifact before changing any assertion.

- [ ] **Step 4: Register it as a required status check**

This is a repository-settings change, not a code change:

```bash
gh api -X GET repos/FutureProofingDev/intelibank/branches/develop/protection --jq '.required_status_checks.contexts'
```

Add `E2E (hermetic)` to that list through the branch-protection settings (Settings → Branches → develop → Require status checks). Re-run the command above and confirm it now lists `E2E (hermetic)`.

---

## Task 11: The live workflow

Delivers: `e2e-live.yml` — dispatchable and nightly, targeting a deployed environment with real credentials, structurally incapable of gating a merge, reporting breaks as a list.

**Files:**
- Create: `.github/workflows/e2e-live.yml`

**Interfaces:**
- Consumes: `npm run test:e2e:live` (Task 1); repository secrets `E2E_BASE_URL`, `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `E2E_SEED_PASSWORD`.
- Produces: a single tracking issue, opened or updated on failure.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/e2e-live.yml`:

```yaml
name: E2E (live)

# NO pull_request trigger, deliberately. This tier exercises real Box, Resend,
# Microsoft 365, and the Ignatious skill API; an outage, a rate limit, or a
# rotated credential on someone else's system carries no information about the
# change under review, so it must be structurally incapable of gating a merge
# (design D4). Its output is a list, not a verdict.
on:
  workflow_dispatch:
  schedule:
    # 06:00 UTC nightly.
    - cron: '0 6 * * *'

permissions:
  contents: read
  issues: write

concurrency:
  group: e2e-live
  cancel-in-progress: true

jobs:
  live:
    # One job per TIER, never per journey (design D5).
    name: E2E (live)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    continue-on-error: true

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Chromium
        run: npx playwright install --with-deps chromium

      - name: Run the live suite
        id: run
        continue-on-error: true
        run: npm run test:e2e:live
        env:
          E2E_BASE_URL: ${{ secrets.E2E_BASE_URL }}
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.E2E_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.E2E_SUPABASE_PUBLISHABLE_KEY }}
          SEED_PASSWORD: ${{ secrets.E2E_SEED_PASSWORD }}

      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-live-report
          path: playwright-report/
          retention-days: 14

      - name: Open or update the tracking issue
        if: steps.run.outcome == 'failure'
        env:
          GH_TOKEN: ${{ github.token }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          TITLE="E2E (live) is failing"
          BODY="The nightly live suite broke. Report: $RUN_URL

          This is a list, not a gate: it never blocks a merge. Work the failing
          steps from the uploaded Playwright report."
          EXISTING=$(gh issue list --state open --search "$TITLE in:title" --json number --jq '.[0].number')
          if [ -n "$EXISTING" ]; then
            gh issue comment "$EXISTING" --body "$BODY"
          else
            gh issue create --title "$TITLE" --body "$BODY" --label ci
          fi
```

- [ ] **Step 2: Verify the workflow parses and carries no pull_request trigger**

```bash
python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/e2e-live.yml')); t=d[True] if True in d else d['on']; assert 'pull_request' not in t, t; print('no pull_request trigger:', list(t))"
```

Expected: `no pull_request trigger: ['workflow_dispatch', 'schedule']`.

- [ ] **Step 3: Commit and run it once on demand**

```bash
git add .github/workflows/e2e-live.yml
git commit -m "ci(e2e): nightly live tier that never gates a merge"
git push
gh workflow run "E2E (live)" --ref feat/e2e-foundation
gh run watch
```

Expected: the run completes. Its result is informational; a red live run does not block this branch. If the secrets are not yet set, the run fails at `setup` with the explicit message from `e2e/auth/setup.ts` — set them, do not soften the check.

---

## Task 12: Document the contract

Delivers: the selector contract and the tier rules under `docs/03-engineering/`, so the next journey follows them without asking.

**Files:**
- Create: `docs/03-engineering/e2e-testing.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the reference the deferred multi-identity onboarding journey is written against.

- [ ] **Step 1: Write the document**

Create `docs/03-engineering/e2e-testing.md`:

```markdown
# Browser E2E

The suite under `e2e/` proves that a Managing Director can complete a deal in a
browser. It is separate from `tests/`, which remains vitest's; the two runners
never see each other's files.

Design of record: `docs/superpowers/specs/2026-08-26-e2e-foundation-design.md`.

## Two tiers, one codebase

| Tier | Project | Gates a merge | Third-party services |
|---|---|---|---|
| Hermetic | `hermetic` | Yes, required check "E2E (hermetic)" | None. Box falls back to LocalStorage, email rides the noop transport, Anthropic screening and Ignatious are unconfigured. |
| Live | `live` | Never | Real Box, Resend, Microsoft 365, Ignatious. |

Journey specs are project-agnostic: the same file runs under both.

**No test that depends on a third-party service may block a merge.** An outage,
a rate limit, or a rotated credential on someone else's system carries no
information about the change under review. `e2e-live.yml` has no `pull_request`
trigger and runs `continue-on-error: true`; its output is a list, not a verdict.

**CI jobs are per tier, never per journey.** Adding a journey means adding a
spec file, not editing a workflow. When the suite outgrows its timeout, scale it
with a shard matrix (`--shard=${{ matrix.shard }}/N`).

## Authentication

Specs do not drive `/sign-in`. The `setup` project mints a Supabase session for
a seeded account and writes cookies into a stored browser state; journey specs
start already inside the shell. The auth boundary is covered at the unit tier
(`tests/middleware-mfa.test.ts`, `tests/sign-in-mfa.test.tsx`,
`tests/two-factor-page.test.tsx`, `tests/mfa-policy.test.ts`,
`tests/mfa-bypass.test.ts`).

Accepted consequence: no browser test covers sign-in or `/two-factor`.

## Selector contract

In priority order:

1. `getByRole(role, { name })`. This matches how the vitest suite queries and
   keeps E2E pressure pointed at accessibility.
2. `getByLabel` / `getByPlaceholder` for form fields.
3. `data-testid` **only** where roles genuinely cannot disambiguate: repeated
   cards, a rail item, one row among identical rows. Adding one is a normal
   product change, in the same commit as the step that needs it.
4. Never CSS or structural selectors. Never assert on marketing copy: brand
   voice is actively edited and pinning it guarantees churn.

One deliberate exception: the compliance ribbon is asserted by its instrument
attribute `[data-compliance-status]`. It is mounted exactly once by invariant,
that invariant is the thing worth testing, and the attribute is already the
sanctioned hook for it. Every `verify()` asserts the count, so the invariant is
checked continuously rather than once. The console is scoped to project routes,
so the expected count is 1 there and 0 elsewhere.

## The step model

Steps are modules, not page objects: a page object organizes by screen, but the
subject under test is a journey, and the same screen means different things at
different points in it.

Each step exports `act` (drive the UI), `assertUi` (the visible outcome), and
`verify` (the durable consequence, read through `/api/v1`). A journey is an
ordered list of steps; each step's `verify()` runs only after its `assertUi()`
passes, so a failure reports the earliest true cause rather than a cascade.

Every step asserts a visible outcome **and** a durable consequence. Compliance
is this product's stated moat; a journey that clicks through without checking
the audit trail proves the wrong thing.

## Evidence

The `evidence` fixture is an `APIRequestContext` built from the same storage
state as the browser context, so handlers authenticate it through the normal
`requireApiUser` path. Reading back with the service key would prove a row
exists; reading back as the MD proves the row exists **and** is visible to the
identity that created it, which exercises `src/lib/api/v1/access.ts` as a side
effect.

Audit assertions go through `expectAudit(ref, { action, actorId, since })`. The
`since` bound is the run's start timestamp, so a shared database carrying other
people's rows cannot produce a false positive.

## Data

Journeys create their own entities under a run-unique name (`E2E Lead {runId}`,
`Project E2E {runId}`) on top of the seeded tenant. Seeded fixtures are
read-only backdrop. The hermetic tier resets the database per run and would not
need uniquing; the live tier runs against a shared database somebody may be
demonstrating on, and the journey code is shared, so `runId` is always on.

## When a step is not yet wired

Use `test.fixme()` carrying the issue number. Never weaken the assertion. The
suite's job is to make the gap visible, not to absorb it.

## Running it

```bash
# Hermetic, against a local Supabase stack.
supabase start && supabase db reset --local
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
export SEED_PASSWORD='e2e-local-password'
npm run seed:flags && npm run seed:flags:enable && npm run seed:users
npm run test:e2e

# Live, against a deployed environment.
E2E_BASE_URL=https://... npm run test:e2e:live
```

## Adding a journey

Add a spec file under `e2e/journeys/`, reusing the step modules. Reuse across
journeys is the point: the deferred multi-identity onboarding journey reuses
`uploadToDataRoom` verbatim under a different storage state. No change to
`playwright.config.ts` and no change to either workflow.
```

- [ ] **Step 2: Link it from the docs map**

Add a row to the engineering section of `docs/README.md`:

```markdown
| Browser E2E (tiers, selectors, step model) | `docs/03-engineering/e2e-testing.md` |
```

Match the surrounding table's column layout; if that section is a list rather
than a table, add a list item in the same style instead.

- [ ] **Step 3: Verify the done-when criteria**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
```

Expected: all four pass. Then confirm by inspection:
- `npm run test:e2e` ran the MD spine green with no third-party credentials present.
- `E2E (hermetic)` is green on the pull request and listed as a required check.
- `E2E (live)` has completed at least one on-demand run.
- Adding a second journey would require no change to `playwright.config.ts` or either workflow (both glob `e2e/journeys/**/*.spec.ts`).

- [ ] **Step 4: Commit**

```bash
git add docs/03-engineering/e2e-testing.md docs/README.md
git commit -m "docs(e2e): selector contract, tier rules, and the step model"
```

---

## Self-review notes

- **Spec coverage.** Runner/config → Task 1. Auth by API, no 2FA (D2) → Task 1. Fixtures/evidence/runId/selectors → Task 2. Step model → Task 3. Spine steps 1-6 → Tasks 3-8. D6 → Task 9. Hermetic CI (D4, D5) → Task 10. Live workflow (D4, D5) → Task 11. Documentation done-when → Task 12. Deferred onboarding journey: out of scope by design, and the layout keeps it additive.
- **Type consistency.** `Step` / `JourneyContext` / `JourneyState` are defined once in `e2e/steps/types.ts` and imported everywhere. `Evidence` method names used in steps (`me`, `listCompanies`, `getDeal`, `listSteps`, `listDocuments`, `listOutbox`, `expectAudit`) all exist on the class in Task 2. `MD_STATE_PATH` and `MD_EMAIL` are exported from `e2e/auth/session.ts` and consumed by `playwright.config.ts`, `e2e/auth/setup.ts`, `e2e/support/fixtures.ts`, and the smoke spec.
- **Spec claims corrected against the code** (`simulated`, the missing close transition, `/progress` having no GET, `deal-folder` vs `rail`, flags defaulting off, `/projects` as the authenticated home) are listed under "Spec deltas resolved during reconnaissance" and each is reflected in the task that depends on it.
