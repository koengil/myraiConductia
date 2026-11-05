# Invite Onboarding E2E Journey — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second browser journey, `invite-onboarding`, that drives a bank-internal Gate 0 invitation and an external director's full acceptance — mail, six-digit challenge, TOTP enrollment, scoped shell — against a hermetic stack, and tears its own rows down when it passes.

**Architecture:** Additions only on top of the shipped E2E foundation. A `node:http` stub speaking Resend's send endpoint is registered as a second Playwright `webServer`, and `src/lib/email/resend.ts` gains a `RESEND_API_BASE` seam so the hermetic Next server posts to it. The journey reuses the foundation's `act` / `assertUi` / `verify` step contract, adds a second browser context for the invitee (no storage state — its session comes from the real action link) and a third storage state for the seeded firm admin, who is the only identity the product permits to send a company's first director invitation. A Playwright teardown project recycles the run's invitations and identities, driven by a manifest the journey writes only on success.

**Tech Stack:** Playwright (`@playwright/test`), TypeScript, `node:http`, `node:crypto` (RFC 6238 in-suite), Supabase local stack, Next.js 16, Vitest for the unit-tier tests this plan adds.

**Spec:** `docs/superpowers/specs/2026-08-27-invite-onboarding-e2e-design.md`
(predecessor: `docs/superpowers/specs/2026-08-26-e2e-foundation-design.md`;
foundation plan: `docs/superpowers/plans/2026-08-26-e2e-foundation.md`)

## Global Constraints

- **Branch:** work continues on `feat/e2e-foundation`. Never commit to `main` or `develop` directly.
- **The seam is untouched.** `ConductiaAPI` (`src/lib/api/`) is not modified. Invite work rides `/api/v1/*`, which lives beside the seam.
- **Selector contract, in order:** ARIA role + accessible name first; `getByLabel` / `getByPlaceholder` second; `data-testid` only as a sanctioned third resort, added in the same commit as the test that needs it. The one standing exception is `[data-compliance-status]`.
- **Every step asserts a visible outcome AND a durable consequence** (design D3): `act()` drives the browser, `assertUi()` asserts what the user sees, `verify()` reads the row back through `/api/v1`. `verify()` runs only after `assertUi()` passes.
- **No third-party credential may be required by the hermetic tier** (design D4). `RESEND_API_KEY` in the hermetic env is a dummy non-empty string; nothing leaves the process.
- **No new CI job and no new CI step** (design D5). The existing "E2E (hermetic)" job globs `e2e/journeys/**/*.spec.ts`.
- **Brand voice in visible copy:** senior, precise, decisive; statements not questions; **no em-dashes** in user-visible strings (ARIA and regulatory separators excepted).
- **Surgical changes only.** The MD spine (`e2e/journeys/md-spine.spec.ts`) must keep its current behaviour exactly.
- **Ports:** the mail stub listens on **4310**; the hermetic app on **3000**; local Supabase on its default **54321**.
- **Hermetic base URL:** `http://127.0.0.1:3000` (note the scheme — `http`, not `https`).
- **Run id in every created address.** `invites_pending_email_uniq` is a *global* partial unique index on pending email (`supabase/migrations/20260731120000_onboarding_invites.sql:50-51`); a fixed address collides with any pending invitation an earlier run left behind.
- **Fixture addresses:**
  - colleague: `` `e2e-colleague-${runId}@futureproofing.com` `` — matches the bank's seeded verified domain, so preflight classifies it `match` and no domain confirmation is required.
  - external director: `` `e2e-director-${runId}@e2e-external.test` `` — the lead company has no verified domain, so preflight classifies it `unverified` and the confirmation IS required and IS walked.
- **Fixture password:** `E2e-Invitee-Passw0rd!` (16 chars, satisfies both `minimum_password_length = 6` in `supabase/config.toml` and the accept form's `minLength={8}`).
- **Local prerequisites** (documented, not automated): a running local Supabase stack, `npm run seed:users`, and `npm run seed:flags:enable` — every `/api/v1/invites*` route 404s without the `platform_onboarding` flag.

---

## Decisions resolved during planning

The design left three open questions and the plan surfaced two more. All five are
answered here so no executor has to re-derive them.

### OQ1 — The Gate 0 receipt banner has no per-chip outcome. Resolved: assert the summary line, and give the banner an accessible name.

`Gate0ReceiptBanner` (`src/components/rail/Gate0ReceiptBanner.tsx`) renders
`summarizeInviteOutcomes(...)` as one sentence (`"1 invitation sent."`) and lists
individual addresses only for *failures*. There is no role-addressable per-chip
outcome and inventing one would be a product change with no product reason.

The step therefore asserts the summary sentence, and the chip's identity is
proven durably in `verify()` (the invite row for that exact address, `pending`
/ `sent`). The one product change is a `aria-label="Mandate opened"` on the
banner's `role="status"` container so the assertion is scoped to that region
rather than to any status node on the page (Task 3).

### OQ2 — The manual TOTP secret is a bare `<code>`. Resolved: `data-testid`.

`src/app/two-factor/page.client.tsx:264-266` renders the base32 secret inside a
`<code>` with no role and no label. Nothing in the accessibility tree
disambiguates it. This is exactly the contract's sanctioned third resort:
Task 3 adds `data-testid="mfa-manual-secret"`, in the same commit as the unit
test that pins it.

### OQ3 — Password minimum. Resolved: no conflict; use a strong fixture.

`supabase/config.toml` sets `minimum_password_length = 6`; the accept form sets
`minLength={8}` and `PASSWORD_MIN_LENGTH = 8`
(`src/lib/auth/passwordStrength.ts`). The form is the stricter gate. The fixture
password above satisfies both and scores `Strong`, so no configuration changes.

### OQ4 (new) — Storm cannot send the first director invitation. Resolved: step 3 acts as the seeded firm admin.

The design's D10 has the MD invite an external **director** into the lead
company the journey just created. The shipped product refuses this, twice and
deliberately:

- `src/app/api/v1/invites/route.ts:197-211` — a `director` invite requires
  `canManageCompanyMembers(actor, companyId)`, which is `firm_role = 'admin'`
  (tenant-wide) or director **of that company**
  (`src/lib/api/v1/access.ts:38-77`). Storm's seed is `firmRole: null`,
  `companyRole: 'director'` of the **bank** (`scripts/seed-data.ts:84-92`), so
  he is neither. The route answers 403.
- `supabase/migrations/20260808120000_invite_phase.sql` re-derives the same rule
  inside the write transaction: `v_company_role = 'director' and not
  v_can_manage_company` raises `not_permitted`.
- A `member` invite is refused too: the lead company has no active director, so
  the route returns 409 `company_requires_director`.

This is not a bug. `InviteModal` renders the product's own instruction for it:
*"This company has no active director. A firm admin must send its first Company
Director invitation."*

So the journey uses the seeded firm admin — `admin.intelibank@dev.com`
(`scripts/seed-data.ts:126-131`, `firmRole: FIRM_ROLE.ADMIN`) — for step 3 only.
The admin reaches the deal (admins have tenant-wide deal access,
`userCanAccessDeal`) and the Team page renders the invite affordance for them
(`LiveTeamRoster` `canInvite` is true for any non-external viewer). Storm stays
the identity for steps 1, 2 and 8. A second storage state is minted by the
setup project (Task 4).

A useful consequence: the lookup route computes
`companyRolePolicy = { memberAllowed: false, directorAllowed: true,
requiresDirector: true }` for this actor and company
(`src/app/api/v1/invites/lookup/route.ts:270-293`), so `InviteModal` renders
**Director** as the only Role option and clears `roleBlocked`. The journey does
not have to fight the form.

### OQ5 (new) — The pre-acceptance containment redirect lands on `/two-factor`, not `/accept-invite`.

The design asserts that, before acceptance, the invitee's context visiting a
project route is redirected to `/accept-invite` (`(authed)/layout.tsx:36`). Under
`MFA_ENFORCEMENT=invite_only` that is not the first gate the request meets.
`middleware.ts` runs before the layout, and `isMfaRequiredForUser` is true for
this identity (`deliverInvite` writes `app_metadata.account_origin =
'email_invite'`), so an AAL1 session is redirected to
`/two-factor?redirectTo=…` before the layout ever renders.

Both redirects are containment. The step therefore asserts the property that
actually matters and is stable under either ordering:

1. the browser does **not** remain on `/projects/{code}` — the landing URL is
   `/two-factor` or `/accept-invite`; and
2. `GET /api/v1/deals/{code}` from the invitee's own session is refused (403),
   which is the API-layer wall `requireApiUser` enforces.

The probe navigates away immediately afterwards. Landing on `/two-factor` mounts
the enrollment screen and creates an *unverified* factor; that is harmless,
because step 6's `prepareMfa` unenrolls stale unverified TOTP factors before
enrolling (`src/app/two-factor/page.client.tsx:45-52`).

---

## File structure

**Created**

| Path | Responsibility |
|---|---|
| `e2e/support/mailStub.ts` | `node:http` server speaking Resend's `POST /emails`; in-memory capture; `GET /messages`. Runs as a Playwright `webServer`. |
| `e2e/support/inbox.ts` | Test-side client over the stub: poll for a recipient's messages, extract the six-digit code and the action link. |
| `e2e/support/totp.ts` | RFC 6238 over `node:crypto`, plus the 30-second window guard. |
| `e2e/support/teardown.ts` | Playwright teardown project: recycles this run's invitations and identities from the manifest. |
| `e2e/steps/gate0.ts` | `runGate0Wizard(ctx, opts)` — the wizard driving, extracted from `createDeal`. |
| `e2e/steps/createDealWithColleagueInvite.ts` | Step 2. |
| `e2e/steps/inviteExternalDirector.ts` | Step 3. |
| `e2e/steps/readInviteMail.ts` | Step 4. |
| `e2e/steps/acceptInvite.ts` | Step 5. |
| `e2e/steps/enrolMfa.ts` | Step 6. |
| `e2e/steps/assertScopedShell.ts` | Step 7. |
| `e2e/steps/assertRosterReflectsAcceptance.ts` | Step 8. |
| `e2e/journeys/invite-onboarding.spec.ts` | The journey. |
| `scripts/lib/recycleInvitee.ts` | The delete-and-tombstone routine, extracted so the teardown and `reset-demo-invitee` share one implementation. |
| `tests/e2e-totp.test.ts` | Unit tier: RFC 6238 vectors + window guard. |
| `tests/e2e-mail-stub.test.ts` | Unit tier: the stub's capture, ordering, and idempotency-key recording. |

**Modified**

| Path | Change |
|---|---|
| `src/lib/email/resend.ts` | Base URL read from `RESEND_API_BASE`, default `https://api.resend.com`. |
| `playwright.config.ts` | `webServer` becomes an array (stub + app); new env; `cleanup` teardown project. |
| `supabase/config.toml` | `additional_redirect_urls` gains the hermetic origin as a path pattern. |
| `src/components/rail/Gate0ReceiptBanner.tsx` | `aria-label` on the `role="status"` container. |
| `src/app/two-factor/page.client.tsx` | `data-testid` on the manual setup key. |
| `e2e/auth/session.ts` | Firm-admin email + storage state path. |
| `e2e/auth/setup.ts` | Mint the firm-admin state alongside the MD's. |
| `e2e/steps/types.ts` | Journey state and context carry the second and third identities. |
| `e2e/steps/createDeal.ts` | Delegates its wizard driving to `runGate0Wizard`. |
| `scripts/reset-demo-invitee.ts` | Calls the extracted routine. |
| `tests/invite-email.test.ts` | Cover the configurable base URL. |
| `tests/two-factor-page.test.tsx` | Cover the manual-secret test id. |
| `docs/03-engineering/e2e-testing.md` | The journey, the stub, prerequisites, teardown. |
| `docs/07-decisions/decision-log.md` | D-entry recording D7–D12 and OQ4/OQ5. |

---

## Task 1: The mail seam and the stub inbox

Everything downstream needs captured mail. This task delivers the seam, the
stub, the test-side client, the Playwright wiring and the Supabase redirect
allowlist together, because none of them is independently useful and they are
verified by one run.

**Files:**
- Modify: `src/lib/email/resend.ts` (the two `fetch('https://api.resend.com/emails', …)` call sites)
- Modify: `tests/invite-email.test.ts`
- Create: `e2e/support/mailStub.ts`
- Create: `e2e/support/inbox.ts`
- Create: `tests/e2e-mail-stub.test.ts`
- Modify: `playwright.config.ts`
- Modify: `supabase/config.toml:163`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resendBaseUrl(): string` (module-private in `resend.ts`; no export needed)
  - `e2e/support/mailStub.ts`: `export type CapturedMessage = { id: string; seq: number; to: string[]; from: string; subject: string; html: string; idempotencyKey: string | null; receivedAt: string }`, `export function createMailStub(): { handler: import('node:http').RequestListener; messages: CapturedMessage[] }`, `export function startMailStub(port: number): Promise<{ url: string; close: () => Promise<void> }>`
  - `e2e/support/inbox.ts`: `export const MAIL_STUB_URL: string`, `export type StubMessage = CapturedMessage`, `export async function messagesFor(email: string, opts?: { expect?: number; timeoutMs?: number }): Promise<StubMessage[]>`, `export function verificationCodeFrom(html: string): string`, `export function acceptUrlFrom(html: string): string`

- [ ] **Step 1: Write the failing unit test for the configurable base URL**

Append to `tests/invite-email.test.ts` (keep the file's existing imports and
`beforeEach`/`afterEach` env handling; add these two cases):

```ts
describe('RESEND_API_BASE', () => {
  it('posts to api.resend.com when unset', async () => {
    delete process.env.RESEND_API_BASE;
    process.env.RESEND_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'someone@example.com',
      acceptUrl: 'http://127.0.0.1:3000/accept-invite#token',
      inviterName: 'Storm Duncan',
      companyName: 'Futureproofing Capital',
      dealCodename: 'Project Test',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  });

  it('posts to RESEND_API_BASE when set, for both send functions', async () => {
    process.env.RESEND_API_BASE = 'http://127.0.0.1:4310';
    process.env.RESEND_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteVerificationEmail({
      to: 'someone@example.com',
      verificationCode: '123456',
      challengeVersion: 1,
    });
    await sendInviteEmail({
      to: 'someone@example.com',
      acceptUrl: 'http://127.0.0.1:3000/accept-invite#token',
      inviterName: 'Storm Duncan',
      companyName: null,
      dealCodename: null,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4310/emails');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4310/emails');
  });
});
```

If `tests/invite-email.test.ts` does not already import
`sendInviteVerificationEmail`, add it to the existing import from
`@/lib/email/resend`. If the file has no `vi.unstubAllGlobals()` in its
`afterEach`, add one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/invite-email.test.ts`
Expected: FAIL — the second case reports `'https://api.resend.com/emails'` where `'http://127.0.0.1:4310/emails'` was expected.

- [ ] **Step 3: Add the base-URL seam**

In `src/lib/email/resend.ts`, add beside `sender()`:

```ts
/**
 * Resend's REST origin. Overridable so the hermetic E2E tier can point the
 * send path at an in-suite stub (design D7): invite mail is real Resend called
 * server-side, there is no outbox row for it, and Supabase's Inbucket never
 * sees it — so a browser cannot intercept it without a seam here. Production
 * never sets this.
 */
function resendBaseUrl(): string {
  return (process.env.RESEND_API_BASE ?? 'https://api.resend.com').replace(/\/+$/, '');
}
```

Then replace the URL literal at both call sites:

```ts
  const res = await fetch(`${resendBaseUrl()}/emails`, {
```

(once inside `sendInviteEmail`, once inside `sendInviteVerificationEmail`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/invite-email.test.ts`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Write the failing unit test for the stub**

Create `tests/e2e-mail-stub.test.ts`:

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { startMailStub } from '../e2e/support/mailStub';

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

describe('the E2E mail stub', () => {
  it('accepts a Resend-shaped send and reads it back in arrival order', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-code' },
      body: JSON.stringify({
        from: 'Conductia <invites@e2e.local>',
        to: ['director@e2e-external.test'],
        subject: 'Your Conductia verification code (1)',
        html: '<p>Your Conductia verification code is <strong>314159</strong>.</p>',
      }),
    });
    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-link' },
      body: JSON.stringify({
        from: 'Conductia <invites@e2e.local>',
        to: ['director@e2e-external.test'],
        subject: 'You have a Conductia invitation',
        html: '<a href="http://127.0.0.1:54321/auth/v1/verify?token=abc">Continue securely</a>',
      }),
    });

    const res = await fetch(`${stub.url}/messages?to=director@e2e-external.test`);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].subject).toBe('Your Conductia verification code (1)');
    expect(body.messages[0].idempotencyKey).toBe('k-code');
    expect(body.messages[1].subject).toBe('You have a Conductia invitation');
    expect(body.messages[0].seq).toBeLessThan(body.messages[1].seq as number);
  });

  it('answers a send with an id, the way Resend does', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    const res = await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a@b.test', to: ['c@d.test'], subject: 's', html: 'h' }),
    });

    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { id?: unknown }).id).toBe('string');
  });

  it('filters by recipient, case-insensitively', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a@b.test', to: ['Someone@E2E.test'], subject: 's', html: 'h' }),
    });

    const res = await fetch(`${stub.url}/messages?to=someone@e2e.test`);
    expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/e2e-mail-stub.test.ts`
Expected: FAIL — `Cannot find module '../e2e/support/mailStub'`.

- [ ] **Step 7: Write the stub**

Create `e2e/support/mailStub.ts`:

```ts
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

/**
 * A stand-in for Resend's send endpoint (design D7). Invite email is real
 * Resend, called server-side by raw fetch, with no outbox row and no Inbucket
 * delivery — so the only way a browser test can read an invitation back is to
 * terminate the HTTP call ourselves. The hermetic tier points
 * RESEND_API_BASE here; nothing leaves the process, which is a stronger
 * guarantee than any hosted sandbox inbox.
 *
 * It observes everything real delivery does short of the vendor: the ordering
 * of the two emails, the Idempotency-Key on each, and the retry attempts.
 */
export type CapturedMessage = {
  id: string;
  /** Monotonic arrival counter — the ordering evidence (code before link). */
  seq: number;
  to: string[];
  from: string;
  subject: string;
  html: string;
  idempotencyKey: string | null;
  receivedAt: string;
};

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function createMailStub(): {
  handler: http.RequestListener;
  messages: CapturedMessage[];
} {
  const messages: CapturedMessage[] = [];
  let seq = 0;

  const handler: http.RequestListener = (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'POST' && url.pathname === '/emails') {
        const raw = await readBody(request);
        let payload: { from?: string; to?: string[] | string; subject?: string; html?: string };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'invalid JSON' }));
          return;
        }
        seq += 1;
        const id = randomUUID();
        const key = request.headers['idempotency-key'];
        messages.push({
          id,
          seq,
          to: Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [],
          from: payload.from ?? '',
          subject: payload.subject ?? '',
          html: payload.html ?? '',
          idempotencyKey: typeof key === 'string' ? key : null,
          receivedAt: new Date().toISOString(),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/messages') {
        const to = url.searchParams.get('to')?.toLowerCase() ?? null;
        const selected = to
          ? messages.filter((message) =>
              message.to.some((recipient) => recipient.toLowerCase() === to),
            )
          : messages;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messages: selected }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'not found' }));
    })();
  };

  return { handler, messages };
}

export function startMailStub(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { handler } = createMailStub();
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

// Executed directly by Playwright's webServer, imported by the unit test.
if (process.argv[1]?.endsWith('mailStub.ts')) {
  const port = Number(process.env.MAIL_STUB_PORT ?? 4310);
  void startMailStub(port).then(({ url }) => {
    console.log(`mail stub listening on ${url}`);
  });
}
```

- [ ] **Step 8: Run the stub test to verify it passes**

Run: `npx vitest run tests/e2e-mail-stub.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Write the inbox client**

Create `e2e/support/inbox.ts`:

```ts
import { expect } from '@playwright/test';
import type { CapturedMessage } from './mailStub';

export type StubMessage = CapturedMessage;

/** The stub's origin. Mirrors the port playwright.config.ts boots it on. */
export const MAIL_STUB_URL = process.env.E2E_MAIL_STUB_URL ?? 'http://127.0.0.1:4310';

/**
 * Poll the stub until `expect` messages have arrived for this address, in
 * arrival order. Delivery is server-side and asynchronous relative to the
 * click that triggered it, so a bare read races the second send.
 */
export async function messagesFor(
  email: string,
  opts: { expect?: number; timeoutMs?: number } = {},
): Promise<StubMessage[]> {
  const wanted = opts.expect ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let seen: StubMessage[] = [];

  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAIL_STUB_URL}/messages?to=${encodeURIComponent(email)}`,
    );
    if (response.ok) {
      seen = ((await response.json()) as { messages: StubMessage[] }).messages;
      if (seen.length >= wanted) return seen.sort((a, b) => a.seq - b.seq);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  expect(
    seen.length,
    `expected ${wanted} message(s) for ${email}; saw ${seen.length}: ${seen
      .map((message) => message.subject)
      .join(' | ')}`,
  ).toBeGreaterThanOrEqual(wanted);
  return seen.sort((a, b) => a.seq - b.seq);
}

/** The six-digit challenge, rendered by sendInviteVerificationEmail inside <strong>. */
export function verificationCodeFrom(html: string): string {
  const match = html.match(/<strong>(\d{6})<\/strong>/);
  expect(match, `no six-digit code in: ${html.slice(0, 300)}`).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

/** The Supabase action link, rendered by sendInviteEmail as the CTA href. */
export function acceptUrlFrom(html: string): string {
  const match = html.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/);
  expect(match, `no action link in: ${html.slice(0, 300)}`).toBeTruthy();
  // The HTML is escaped for email clients; unescape the query separators.
  return (match as RegExpMatchArray)[1].replace(/&amp;/g, '&');
}
```

- [ ] **Step 10: Wire the stub and the env into Playwright**

In `playwright.config.ts`, add above `export default`:

```ts
const MAIL_STUB_PORT = 4310;
const MAIL_STUB_URL = `http://127.0.0.1:${MAIL_STUB_PORT}`;
```

Replace the `webServer:` value with an array. The app entry keeps every line it
has today; only the `env` block gains four keys and the whole thing becomes the
second element:

```ts
  // Two servers: the mail stub first, so it is reachable from the Next server
  // process the moment an invite is sent (design D7), then the app. No
  // webServer at all when a live target is named.
  webServer: LIVE_BASE_URL
    ? undefined
    : [
        {
          command: `node --import tsx e2e/support/mailStub.ts`,
          url: `${MAIL_STUB_URL}/messages`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { MAIL_STUB_PORT: String(MAIL_STUB_PORT) },
        },
        {
          // ...every existing key of the current webServer object, unchanged...
          env: {
            // ...every existing key of the current env block, unchanged...

            // Invite delivery (design D7). RESEND_API_BASE points the send path
            // at the in-suite stub; the key is a dummy non-empty value because
            // both send functions throw without one, and nothing it could
            // authenticate is ever contacted.
            RESEND_API_BASE: MAIL_STUB_URL,
            RESEND_API_KEY: 'e2e-stub-key',
            RESEND_FROM: 'Conductia E2E <invites@e2e.local>',
            // The challenge digest's HMAC pepper. CI exports it
            // (.github/workflows/ci.yml); locally the fallback keeps the suite
            // runnable without a .env.local.
            INVITE_VERIFICATION_PEPPER:
              process.env.INVITE_VERIFICATION_PEPPER ?? 'e2e-hermetic-pepper',
          },
        },
      ],
```

Note: `E2E_MAIL_STUB_URL` is not set for the test process — `inbox.ts` defaults
to the same origin. Leave it as an escape hatch.

- [ ] **Step 11: Widen the Supabase redirect allowlist**

`supabase/config.toml:163` currently reads:

```toml
additional_redirect_urls = ["https://127.0.0.1:3000"]
```

Replace it with:

```toml
# The hermetic E2E origin, as a path pattern. deliverInvite generates the action
# link with redirectTo = http://127.0.0.1:3000/accept-invite; GoTrue matches a
# redirect against site_url EXACTLY or against these patterns, so without the
# /** the invite link would silently fall back to site_url and strand the
# invitee on the picker. The https entry is kept for anything already using it.
additional_redirect_urls = [
  "https://127.0.0.1:3000",
  "http://127.0.0.1:3000/**",
  "http://localhost:3000/**",
]
```

Do **not** touch `[auth.rate_limit] email_sent`. `generateLink` mints a link
without sending, and both real sends go to the stub, so no GoTrue mail is
emitted by this journey.

- [ ] **Step 12: Verify the whole unit tier is still green**

Run: `npm test`
Expected: PASS. `npx tsc --noEmit` and `npm run lint` also clean.

- [ ] **Step 13: Verify the stub boots under Playwright**

With a local Supabase stack running and the tenant seeded:

Run: `npm run test:e2e`
Expected: the MD spine still passes and the run log shows `mail stub listening on http://127.0.0.1:4310`. Restart Supabase (`supabase stop && supabase start`) after the config change so the new allowlist takes effect.

- [ ] **Step 14: Commit**

```bash
git add src/lib/email/resend.ts tests/invite-email.test.ts \
  e2e/support/mailStub.ts e2e/support/inbox.ts tests/e2e-mail-stub.test.ts \
  playwright.config.ts supabase/config.toml
git commit -m "test(e2e): capture invite mail through a stub Resend endpoint (D7)"
```

---

## Task 2: The TOTP helper

**Files:**
- Create: `e2e/support/totp.ts`
- Create: `tests/e2e-totp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function totpCode(secret: string, atMs?: number): string`, `export function secondsRemainingInStep(atMs?: number): number`, `export async function totpCodeWithWindowGuard(secret: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/e2e-totp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  secondsRemainingInStep,
  totpCode,
} from '../e2e/support/totp';

// RFC 6238 Appendix B, SHA-1, 8 digits, on the ASCII secret "12345678901234567890".
// Base32 of that secret is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ; the RFC's vectors
// are 8-digit, so the 6-digit expectation is the RFC value truncated on the
// left, which is exactly what a 6-digit authenticator shows.
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it('matches the RFC 6238 vector at T = 59s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 59_000)).toBe('287082');
  });

  it('matches the RFC 6238 vector at T = 1111111109s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 1_111_111_109_000)).toBe('081804');
  });

  it('matches the RFC 6238 vector at T = 1234567890s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 1_234_567_890_000)).toBe('005924');
  });

  it('tolerates a lowercase, padded secret the way an authenticator app does', () => {
    expect(totpCode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq====', 59_000)).toBe('287082');
  });

  it('returns the same code across one 30-second step', () => {
    expect(totpCode(RFC_SECRET_BASE32, 30_000)).toBe(totpCode(RFC_SECRET_BASE32, 59_999));
  });
});

describe('secondsRemainingInStep', () => {
  it('is 30 at the top of a step and 1 at its end', () => {
    expect(secondsRemainingInStep(30_000)).toBe(30);
    expect(secondsRemainingInStep(59_000)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/e2e-totp.test.ts`
Expected: FAIL — `Cannot find module '../e2e/support/totp'`.

- [ ] **Step 3: Write the helper**

Create `e2e/support/totp.ts`:

```ts
import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP over node:crypto (design D9). Roughly twenty-five lines, so
 * the suite gains no dependency and no supply-chain surface for what is a
 * fixed, thirty-year-old algorithm.
 *
 * MFA enrollment is a mandatory step of the invite flow, not an adjacent auth
 * concern: under MFA_ENFORCEMENT=invite_only, isMfaRequiredForUser returns
 * wasCreatedFromEmailInvite(user) and never consults isMfaBypassEnabled, so
 * DISABLE_MFA=1 does not exempt an invitee (design D8).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error(`"${character}" is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Whole seconds left in the current 30-second step. 30 at the top, 1 at the end. */
export function secondsRemainingInStep(atMs: number = Date.now()): number {
  return STEP_SECONDS - (Math.floor(atMs / 1000) % STEP_SECONDS);
}

export function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * The window guard (design D9). A code generated with under three seconds left
 * can expire between generation and GoTrue's verification, so wait for the
 * next step rather than submit a value that is about to be wrong. GoTrue
 * tolerates one step of skew and the hermetic Supabase runs on the host clock,
 * so drift is not a factor; only the boundary is.
 */
export async function totpCodeWithWindowGuard(secret: string): Promise<string> {
  const remaining = secondsRemainingInStep();
  if (remaining < 3) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
  }
  return totpCode(secret);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/e2e-totp.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add e2e/support/totp.ts tests/e2e-totp.test.ts
git commit -m "test(e2e): compute TOTP in-suite with an explicit window guard (D9)"
```

---

## Task 3: Two selector affordances

Both are product changes the selector contract sanctions, shipped in the same
commit as the tests that need them (see OQ1, OQ2 above).

**Files:**
- Modify: `src/components/rail/Gate0ReceiptBanner.tsx:57-60`
- Modify: `src/app/two-factor/page.client.tsx:264-266`
- Modify: `tests/two-factor-page.test.tsx`
- Modify or create: the Gate 0 receipt banner's unit test (search `tests/` for a spec that renders `Gate0ReceiptBanner`; if none exists, create `tests/gate0-receipt-banner.test.tsx` with the case below)

**Interfaces:**
- Consumes: nothing.
- Produces: DOM hooks used by Tasks 5 and 9 — `getByRole('status', { name: 'Mandate opened' })` and `getByTestId('mfa-manual-secret')`.

- [ ] **Step 1: Write the failing test for the banner's accessible name**

In the banner's unit test file:

```tsx
it('names its status region so a journey can scope an assertion to it', () => {
  stashGate0Receipt('ATLAS', {
    verdict: 'compliant',
    recipients: 1,
    at: new Date().toISOString(),
    invites: [{ email: 'colleague@futureproofing.com', state: 'sent' }],
  });

  render(<Gate0ReceiptBanner code="ATLAS" active />);

  const banner = screen.getByRole('status', { name: 'Mandate opened' });
  expect(banner).toHaveTextContent('1 invitation sent.');
});
```

The banner reads its receipt inside `requestAnimationFrame`, so wrap the
assertion in `await waitFor(...)` (or `findByRole`) if the existing file's
pattern does not already handle that. Import `stashGate0Receipt` from
`@/lib/deals/gate0Receipt`.

- [ ] **Step 2: Write the failing test for the manual secret**

In `tests/two-factor-page.test.tsx`, inside the enrollment-rendering describe:

```tsx
it('exposes the manual setup key under a stable test id', async () => {
  // (reuse the file's existing enrollment mock, whose secret is a base32 string)
  render(<TwoFactorPageClient destination="/projects/ATLAS" />);

  const secret = await screen.findByTestId('mfa-manual-secret');
  expect(secret).toHaveTextContent(/^[A-Z2-7]+$/);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run tests/two-factor-page.test.tsx tests/gate0-receipt-banner.test.tsx`
Expected: FAIL — "Unable to find an accessible element with the role \"status\" and name \"Mandate opened\"", and "Unable to find an element by: [data-testid=\"mfa-manual-secret\"]".

- [ ] **Step 4: Add the accessible name to the banner**

In `src/components/rail/Gate0ReceiptBanner.tsx`, on the outer `<div role="status" …>`:

```tsx
    <div
      role="status"
      // Named so a browser journey can scope its assertion to this receipt
      // rather than to any status node on the rail. The banner reports invite
      // outcomes as one summary sentence and lists addresses only for
      // failures, so the region, not a per-chip node, is the addressable unit.
      aria-label="Mandate opened"
      className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
    >
```

Leave the visible "Mandate opened" eyebrow exactly as it is — the label
matches it deliberately.

- [ ] **Step 5: Add the test id to the manual secret**

In `src/app/two-factor/page.client.tsx`:

```tsx
              <code
                // The one sanctioned data-testid on this surface: the secret
                // renders in a bare <code> with no role and no label, so
                // nothing in the accessibility tree disambiguates it. The E2E
                // invite journey reads it here to compute a real TOTP (D8).
                data-testid="mfa-manual-secret"
                className="mt-[var(--space-1)] block break-all text-[length:var(--text-sm)] text-[var(--ink-on-dark)]"
              >
                {preparation.secret}
              </code>
```

- [ ] **Step 6: Run both to verify they pass**

Run: `npx vitest run tests/two-factor-page.test.tsx tests/gate0-receipt-banner.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/rail/Gate0ReceiptBanner.tsx src/app/two-factor/page.client.tsx tests/
git commit -m "feat(a11y): name the Gate 0 receipt region and address the MFA setup key"
```

---

## Task 4: A firm-admin storage state

The seeded MD cannot send a company's first director invitation; the seeded
firm admin can (OQ4). This task mints that identity's session.

**Files:**
- Modify: `e2e/auth/session.ts`
- Modify: `e2e/auth/setup.ts`

**Interfaces:**
- Consumes: `mintStorageState` (existing, unchanged).
- Produces: `export const ADMIN_STATE_PATH: string`, `export const ADMIN_EMAIL: string` from `e2e/auth/session.ts`.

- [ ] **Step 1: Add the admin constants**

In `e2e/auth/session.ts`, beside the MD constants:

```ts
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
```

- [ ] **Step 2: Mint it in the setup project**

In `e2e/auth/setup.ts`, refactor the existing body into a helper and add a
second `setup(...)` block. The whole file becomes:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_STATE_PATH,
  MD_EMAIL,
  MD_STATE_PATH,
  mintStorageState,
} from './session';

/**
 * The setup project. E2E specs do not drive /sign-in: the auth boundary is
 * covered at the unit tier (tests/middleware-mfa.test.ts, sign-in-mfa,
 * two-factor-page, mfa-policy, mfa-bypass) and re-driving it in a browser adds
 * cost without adding coverage (design D2).
 *
 * The invitee is deliberately NOT minted here. Their session must come from the
 * real acceptance path — the Supabase action link, the challenge, the accept
 * endpoint — which is the thing the invite journey exists to prove.
 */
async function mint(email: string, statePath: string, baseURL: string | undefined) {
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
    email,
    password,
    baseURL: baseURL ?? 'http://127.0.0.1:3000',
  });

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

setup('mint the MD session', async ({ baseURL }) => {
  await mint(MD_EMAIL, MD_STATE_PATH, baseURL);
});

setup('mint the firm-admin session', async ({ baseURL }) => {
  await mint(ADMIN_EMAIL, ADMIN_STATE_PATH, baseURL);
});
```

- [ ] **Step 3: Run the setup project to verify both states are written**

Run: `npx playwright test --project=setup`
Expected: 2 passed. `e2e/auth/.state/md.json` and `e2e/auth/.state/admin.json` both exist and each contains a non-empty `cookies` array.

- [ ] **Step 4: Verify the MD spine is unaffected**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/auth/session.ts e2e/auth/setup.ts
git commit -m "test(e2e): mint the firm-admin session for company-management acts"
```

---

## Task 5: The Gate 0 extraction, the colleague invite, and the journey skeleton

Steps 1 and 2 of the journey, plus the spec file every later task appends to.

**Files:**
- Create: `e2e/steps/gate0.ts`
- Modify: `e2e/steps/createDeal.ts`
- Create: `e2e/steps/createDealWithColleagueInvite.ts`
- Modify: `e2e/steps/types.ts`
- Create: `e2e/journeys/invite-onboarding.spec.ts`
- Create: `e2e/support/invites.ts` (the evidence reads this journey needs)

**Interfaces:**
- Consumes: `Step`, `JourneyContext` (`e2e/steps/types.ts`); `expectSingleComplianceInstrument` (`e2e/support/selectors.ts`); `Evidence` (`e2e/support/evidence.ts`).
- Produces:
  - `e2e/steps/gate0.ts`: `export async function runGate0Wizard(ctx: JourneyContext, opts?: { inviteEmails?: string[] }): Promise<void>`
  - `e2e/steps/types.ts` gains, on `JourneyState`: `colleagueEmail?: string`, `directorEmail?: string`, `inviteId?: string`, `inviteAcceptUrl?: string`, `inviteVerificationCode?: string`, `mfaSecret?: string`, `inviteePhase?: number`; and on `JourneyContext` (all optional, so `md-spine.spec.ts` keeps compiling): `adminPage?: Page`, `adminEvidence?: Evidence`, `inviteePage?: Page`, `inviteeEvidence?: Evidence`. Plus `Evidence.request` becomes public (see Step 6).
  - `e2e/support/invites.ts`: `export type InviteRow = { id: string; email: string; companyId: string; companyRole: string; dealId: string | null; dealRole: string | null; status: string; deliveryStatus: string }`, `export async function listInvites(request: import('@playwright/test').APIRequestContext, dealRef: string): Promise<InviteRow[]>`, `export async function expectInvite(request: import('@playwright/test').APIRequestContext, dealRef: string, email: string, expected: { status: string; deliveryStatus?: string }): Promise<InviteRow>`
  - `e2e/steps/createDealWithColleagueInvite.ts`: `export const createDealWithColleagueInvite: Step`

- [ ] **Step 1: Extend the journey types**

In `e2e/steps/types.ts`, add to `JourneyState`:

```ts
  /** The bank-internal colleague queued as a Gate 0 chip (step 2). */
  colleagueEmail?: string;
  /** The external director invited from Team (step 3). */
  directorEmail?: string;
  /** The director's invite row id, from GET /api/v1/invites. */
  inviteId?: string;
  /** The Supabase action link, read out of the stub inbox (step 4). */
  inviteAcceptUrl?: string;
  /** The six-digit challenge, read out of the stub inbox (step 4). */
  inviteVerificationCode?: string;
  /** The base32 TOTP secret read off /two-factor (step 6). */
  mfaSecret?: string;
  /** The disclosure phase the inviter confirmed, carried to the granted seat. */
  inviteePhase?: number;
```

and to `JourneyContext`:

```ts
  /**
   * The firm admin's page. Present only for journeys that perform a
   * company-management act; the MD spine never sets it.
   */
  adminPage?: Page;
  adminEvidence?: Evidence;
  /**
   * The invitee's page — a context with NO storage state. Its session comes
   * entirely from the real acceptance path, which is the point.
   */
  inviteePage?: Page;
  inviteeEvidence?: Evidence;
```

- [ ] **Step 2: Extract the wizard driving**

Create `e2e/steps/gate0.ts`, moving the body of `createDeal.act` verbatim and
adding the chip loop:

```ts
import { expect } from '@playwright/test';
import type { JourneyContext } from './types';

const CONFLICTS_APPROVER = 'Pat Rivera';

/**
 * Drive the Gate 0 wizard to a created mandate. Shared by createDeal (no
 * chips) and createDealWithColleagueInvite (one chip), so the two journeys
 * cannot drift apart on how the gate is walked.
 *
 * Queued invitations are bank-internal by construction: postQueuedInvite fixes
 * companyRole to 'member' and the wizard's role list is the internal
 * allowlist (src/components/wizard/Gate0Wizard.tsx:169-215, 1461-1510). This
 * surface cannot produce an external identity, which is why the journey also
 * invites from Team (design D11).
 */
export async function runGate0Wizard(
  ctx: JourneyContext,
  opts: { inviteEmails?: string[] } = {},
): Promise<void> {
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
  // The code-name field seeds itself with an AI-suggested theme once the lead
  // is selected; wait for that async suggestion to land before typing ours, or
  // it overwrites the field a moment later.
  await expect(wizard.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  await wizard.getByLabel('Code name', { exact: true }).fill(codename);
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 2 — the senior-partner conflicts approval.
  await wizard.getByLabel('Approved by').fill(CONFLICTS_APPROVER);
  await wizard.getByLabel('Confirm the conflicts approval').check();
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 3 — team. Colleague invitations queue here as chips; the deal does
  // not exist yet, so they fire against POST /api/v1/invites only after create.
  for (const email of opts.inviteEmails ?? []) {
    await wizard.getByPlaceholder('colleague@bank.com').fill(email);
    await wizard.getByRole('button', { name: 'Check and add invitation' }).click();
    // The fixture address sits on the bank's seeded verified domain
    // (futureproofing.com), so preflight classifies it 'match' and no
    // confirmation is required. If the seed ever loses that domain the button
    // becomes "Confirm and add" instead; fail loudly rather than click blind.
    await expect(
      wizard.getByRole('button', { name: 'Confirm and add' }),
      `${email} unexpectedly required a domain confirmation at Gate 0; ` +
        'check the bank company still has a verified domain seeded.',
    ).toHaveCount(0);
    await expect(
      wizard.getByRole('list', { name: 'Queued invitations' }).getByText(email),
    ).toBeVisible();
  }
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 4 — notify compliance and management, then create.
  await wizard.getByRole('button', { name: 'Create the mandate' }).click();
}
```

- [ ] **Step 3: Point `createDeal` at it**

Replace `createDeal.act`'s body in `e2e/steps/createDeal.ts` with:

```ts
  async act(ctx) {
    await runGate0Wizard(ctx);
  },
```

Add `import { runGate0Wizard } from './gate0';`, and delete the now-unused
`CONFLICTS_APPROVER` constant and the `expect` import if nothing else in the
file uses them (`assertUi` and `verify` both still use `expect`, so keep it).
`assertUi` and `verify` are unchanged.

- [ ] **Step 4: Run the MD spine to prove the extraction is behaviour-preserving**

Run: `npm run test:e2e`
Expected: PASS, identical to before. This is the whole point of doing the extraction as its own step.

- [ ] **Step 5: Write the invite evidence reads**

Create `e2e/support/invites.ts`:

```ts
import { expect, type APIRequestContext } from '@playwright/test';

/** Mirrors serializeInvite in src/app/api/v1/invites/route.ts. */
export type InviteRow = {
  id: string;
  email: string;
  companyId: string;
  companyRole: string;
  dealId: string | null;
  dealRole: string | null;
  status: string;
  deliveryStatus: string;
};

export async function listInvites(
  request: APIRequestContext,
  dealRef: string,
): Promise<InviteRow[]> {
  const url = `/api/v1/invites?dealId=${encodeURIComponent(dealRef)}`;
  const response = await request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return ((await response.json()) as { invites: InviteRow[] }).invites;
}

/**
 * The durable half of an invite assertion: the row exists on the deal, for
 * that exact address, in the expected state. Addresses carry the run id
 * because invites_pending_email_uniq is a GLOBAL partial unique index on
 * pending email, so a fixed address would collide with anything an earlier run
 * stranded.
 */
export async function expectInvite(
  request: APIRequestContext,
  dealRef: string,
  email: string,
  expected: { status: string; deliveryStatus?: string },
): Promise<InviteRow> {
  const invites = await listInvites(request, dealRef);
  const row = invites.find((invite) => invite.email === email.toLowerCase());
  expect(
    row,
    `no invite for ${email} on ${dealRef}; saw: ${invites
      .map((invite) => `${invite.email}=${invite.status}/${invite.deliveryStatus}`)
      .join(', ')}`,
  ).toBeTruthy();
  expect(row?.status).toBe(expected.status);
  if (expected.deliveryStatus) {
    expect(row?.deliveryStatus).toBe(expected.deliveryStatus);
  }
  return row as InviteRow;
}
```

- [ ] **Step 6: Write step 2**

Create `e2e/steps/createDealWithColleagueInvite.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { expectInvite } from '../support/invites';
import { runGate0Wizard } from './gate0';
import type { Step } from './types';

/**
 * Step 2 — open the mandate through Gate 0 with one queued colleague
 * invitation. Gate 0's queue is bank-internal by construction and can never
 * reach a scoped shell, so it is here for what it alone covers: how an
 * invitation is born on the real onboarding path, including the receipt
 * (design D11).
 */
export const createDealWithColleagueInvite: Step = {
  name: 'createDealWithColleagueInvite',

  async act(ctx) {
    // The bank's seeded verified domain, so preflight returns 'match' and the
    // chip queues in one click. The run id keeps the pending-email unique
    // index from colliding with an earlier run.
    ctx.state.colleagueEmail = `e2e-colleague-${ctx.runId}@futureproofing.com`;
    await runGate0Wizard(ctx, { inviteEmails: [ctx.state.colleagueEmail] });
  },

  async assertUi(ctx) {
    await ctx.page.waitForURL(/\/projects\/[^/]+\/rail/);
    const code = new URL(ctx.page.url()).pathname.split('/')[2];
    expect(code, 'no deal code in the landing URL').toBeTruthy();
    ctx.state.dealCode = decodeURIComponent(code);

    await expect(
      ctx.page.getByRole('heading', { name: `Project E2E ${ctx.runId}` }),
    ).toBeVisible();

    // The honest receipt. The banner reports invite outcomes as one summary
    // sentence and names addresses only for failures, so "1 invitation sent."
    // IS the per-chip success statement; the chip's identity is proven durably
    // in verify() below.
    const receipt = ctx.page.getByRole('status', { name: 'Mandate opened' });
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('1 invitation sent.');
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal } = await ctx.evidence.getDeal(ref);
    ctx.state.dealId = deal.id;
    expect(deal.codename).toBe(`Project E2E ${ctx.runId}`);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'create',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectInvite(ctx.evidence.request, ref, ctx.state.colleagueEmail as string, {
      status: 'pending',
      deliveryStatus: 'sent',
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

`ctx.evidence.request` is not reachable yet. Make it so: in
`e2e/support/evidence.ts`, change the constructor parameter from
`private readonly request: APIRequestContext` to
`public readonly request: APIRequestContext`. Nothing else changes — every
existing method already calls `json(this.request, …)`.

Do **not** add a separate `evidenceRequest` field to `JourneyContext`:
`JourneyContext` is shared with the MD spine, and a new required field there
would break `e2e/journeys/md-spine.spec.ts`. Every field this plan adds to
`JourneyContext` is optional for exactly that reason.

- [ ] **Step 7: Write the journey spec with steps 1 and 2**

Create `e2e/journeys/invite-onboarding.spec.ts`:

```ts
import { expect, test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import { createDealWithColleagueInvite } from '../steps/createDealWithColleagueInvite';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The multi-identity onboarding journey: a firm invites an external director,
 * who receives mail, verifies, enrols, accepts, and lands in a scoped shell.
 *
 * Hermetic-only, unlike the MD spine. Real invite delivery cannot be read back
 * by a test (design D7): it is Resend called server-side by raw fetch, with no
 * outbox row and no Inbucket delivery. The suite terminates the send itself, so
 * this journey is meaningless against a deployed environment.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDealWithColleagueInvite,
];

test('the invite onboarding journey', async ({ page, evidence, runId, since }) => {
  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of JOURNEY) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }

  expect(state.dealCode, 'the journey produced no deal').toBeTruthy();
});
```

- [ ] **Step 8: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS. If the receipt asserts "1 invitations sent" or "0 invitations sent", read the invite row's `deliveryStatus` — an `unsent` chip means the stub is not reachable from the Next process, not that the assertion is wrong.

- [ ] **Step 9: Verify the MD spine still passes**

Run: `npm run test:e2e`
Expected: PASS, both journeys.

- [ ] **Step 10: Commit**

```bash
git add e2e/steps/gate0.ts e2e/steps/createDeal.ts \
  e2e/steps/createDealWithColleagueInvite.ts e2e/steps/types.ts \
  e2e/support/invites.ts e2e/support/evidence.ts \
  e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): open a mandate with a queued colleague invitation (D11)"
```

---

## Task 6: Step 3 — invite the external director

**Files:**
- Create: `e2e/steps/inviteExternalDirector.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `ctx.adminPage`, `ctx.adminEvidence`, `ctx.state.dealCode`, `ctx.state.leadName`; `expectInvite` (Task 5).
- Produces: `export const inviteExternalDirector: Step`; sets `ctx.state.directorEmail`, `ctx.state.inviteId`, `ctx.state.inviteePhase`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/inviteExternalDirector.ts`:

```ts
import { expect } from '@playwright/test';
import { expectInvite } from '../support/invites';
import type { Step } from './types';

/** Proven in verify(): the seat granted at acceptance is the one previewed. */
const CONFIRMED_PHASE = 1;

/**
 * Step 3 — invite the external director from the deal's Team roster.
 *
 * Driven by the FIRM ADMIN, not the MD. A company's first director invitation
 * is a company-management act: POST /api/v1/invites requires firm_role='admin'
 * or a directorship of the target company (route.ts:197-211, re-derived inside
 * create_invite). Storm is a director of the bank, not of the lead company the
 * journey just created, so the product refuses him — and says so on this very
 * screen: "A firm admin must send its first Company Director invitation."
 * A 'member' invite is refused too, 409 company_requires_director, because the
 * company has no active director yet.
 *
 * The company is the journey's own lead, seated as the deal's target party by
 * Gate 0, so nothing here depends on seed-onboarding-demo (design D10).
 */
export const inviteExternalDirector: Step = {
  name: 'inviteExternalDirector',

  async act(ctx) {
    const page = ctx.adminPage;
    expect(page, 'inviteExternalDirector needs ctx.adminPage').toBeTruthy();
    if (!page) return;

    // A domain the lead company has not verified. The journey walks the
    // resulting confirmation rather than seeding around it: it is a real
    // safeguard on the flow carrying the most demo risk.
    ctx.state.directorEmail = `e2e-director-${ctx.runId}@e2e-external.test`;
    ctx.state.inviteePhase = CONFIRMED_PHASE;

    await page.goto(`/projects/${ctx.state.dealCode}/team`);
    await page.getByRole('button', { name: 'Invite to platform' }).click();

    const modal = page.getByRole('dialog', { name: 'Invite to platform' });
    await expect(modal).toBeVisible();

    await modal.getByLabel('Email').fill(ctx.state.directorEmail);
    await modal.getByLabel('Company').selectOption({ label: ctx.state.leadName as string });

    // The lookup reports companyRolePolicy { memberAllowed: false,
    // directorAllowed: true } for this actor and company, so Director is the
    // only Role option the form renders. Select it explicitly rather than rely
    // on the lookup's auto-fill landing first.
    await expect(modal.getByLabel('Role')).toBeVisible();
    await modal.getByLabel('Role').selectOption({ label: 'Director' });

    // Phase travels with the invitation and is the phase actually granted, so
    // set a non-zero one: phase 0 is indistinguishable from the default.
    await modal
      .getByLabel('Starting disclosure phase')
      .fill(String(CONFIRMED_PHASE));

    // First click runs preflight and surfaces the unverified-domain decision.
    await modal.getByRole('button', { name: 'Check and send invite' }).click();
    await expect(
      modal.getByRole('alert').filter({ hasText: 'no verified email domain' }),
    ).toBeVisible();

    // Second click sends, carrying the confirmation id.
    await modal.getByRole('button', { name: 'Confirm and send' }).click();
  },

  async assertUi(ctx) {
    const page = ctx.adminPage;
    if (!page) return;
    const modal = page.getByRole('dialog', { name: 'Invite to platform' });
    await expect(
      modal.getByText(`Invite pending for ${ctx.state.directorEmail}`),
    ).toBeVisible();
    // No delivery failure alongside it — the stub accepted both sends.
    await expect(modal.getByText('Email failed. Resend.')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Done' }).click();

    // The roster now carries the pending row.
    await expect(
      page.getByText(ctx.state.directorEmail as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const request = ctx.adminEvidence?.request;
    expect(request, 'inviteExternalDirector needs ctx.adminEvidence').toBeTruthy();
    if (!request) return;

    const invite = await expectInvite(request, ref, ctx.state.directorEmail as string, {
      status: 'pending',
      deliveryStatus: 'sent',
    });
    expect(invite.companyRole).toBe('director');
    // The lead company is the deal's target party, so its people take the
    // seller seat (create_invite derives this and refuses anything else).
    expect(invite.dealRole).toBe('seller');
    ctx.state.inviteId = invite.id;

    // The MD reads the audit: the send is on the deal's trail regardless of
    // which authorized identity made it.
    await ctx.evidence.expectAudit(ref, { action: 'invite_sent', since: ctx.since });
  },
};
```

- [ ] **Step 2: Give the spec an admin context**

In `e2e/journeys/invite-onboarding.spec.ts`, change the test signature to take
`browser` and build the admin context before the loop:

```ts
import { request as playwrightRequest } from '@playwright/test';
import { ADMIN_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import { inviteExternalDirector } from '../steps/inviteExternalDirector';
```

```ts
test('the invite onboarding journey', async ({ page, evidence, runId, since, browser, baseURL }) => {
  const state: JourneyState = {};

  // The firm admin, for the one company-management act the journey needs
  // (see inviteExternalDirector). Its own context, so neither session's
  // cookies can leak into the other's page.
  const adminContext = await browser.newContext({ storageState: ADMIN_STATE_PATH, baseURL });
  const adminPage = await adminContext.newPage();
  const adminApi = await playwrightRequest.newContext({
    baseURL,
    storageState: ADMIN_STATE_PATH,
  });

  const ctx: JourneyContext = {
    page,
    evidence,
    adminPage,
    adminEvidence: new Evidence(adminApi),
    runId,
    since,
    state,
  };

  try {
    for (const step of JOURNEY) {
      await test.step(`${step.name} · act`, () => step.act(ctx));
      await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
      await test.step(`${step.name} · verify`, () => step.verify(ctx));
    }
    expect(state.dealCode, 'the journey produced no deal').toBeTruthy();
  } finally {
    await adminApi.dispose();
    await adminContext.close();
  }
});
```

Add `inviteExternalDirector` to `JOURNEY` after `createDealWithColleagueInvite`.

- [ ] **Step 3: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS. A 403 on the invite POST means the admin state was not minted (re-run `--project=setup`); a 409 `company_requires_director` means the Role select was left on Member.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/inviteExternalDirector.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): invite an external director from Team, domain confirmation and all (D10)"
```

---

## Task 7: Step 4 — read the invitation mail

**Files:**
- Create: `e2e/steps/readInviteMail.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `messagesFor`, `verificationCodeFrom`, `acceptUrlFrom` (`e2e/support/inbox.ts`, Task 1); `ctx.state.directorEmail`, `ctx.state.inviteId`.
- Produces: `export const readInviteMail: Step`; sets `ctx.state.inviteVerificationCode`, `ctx.state.inviteAcceptUrl`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/readInviteMail.ts`:

```ts
import { expect } from '@playwright/test';
import {
  acceptUrlFrom,
  messagesFor,
  verificationCodeFrom,
} from '../support/inbox';
import { expectInvite } from '../support/invites';
import type { Step } from './types';

/**
 * Step 4 — read the two invitation emails out of the stub. The only step with
 * no browser action: the assertion IS the mail.
 *
 * Order matters and is asserted. deliverInvite sends the non-actionable code
 * FIRST, so that a failure there means no credential has escaped; sending the
 * link first could leave an invitee holding a valid link that acceptance
 * rejects because delivery never finalized
 * (src/lib/api/v1/inviteDelivery.ts). Idempotency keys are asserted because
 * they are what makes retrying a transient provider failure safe.
 */
export const readInviteMail: Step = {
  name: 'readInviteMail',

  async act(ctx) {
    const email = ctx.state.directorEmail as string;
    const messages = await messagesFor(email, { expect: 2 });

    expect(
      messages,
      `expected exactly two messages for ${email}; saw ${messages.length}`,
    ).toHaveLength(2);

    const [code, link] = messages;
    expect(code.subject).toMatch(/^Your Conductia verification code \(\d+\)$/);
    expect(link.subject).toBe('You have a Conductia invitation');
    expect(code.seq, 'the code email must arrive before the link email').toBeLessThan(
      link.seq,
    );

    const inviteId = ctx.state.inviteId as string;
    expect(code.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-code`);
    expect(link.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-link`);

    ctx.state.inviteVerificationCode = verificationCodeFrom(code.html);
    ctx.state.inviteAcceptUrl = acceptUrlFrom(link.html);
  },

  async assertUi(ctx) {
    // No browser surface. The two artifacts the rest of the journey needs are
    // the assertion.
    expect(ctx.state.inviteVerificationCode).toMatch(/^\d{6}$/);
    expect(ctx.state.inviteAcceptUrl).toContain('/auth/v1/verify');
    expect(decodeURIComponent(ctx.state.inviteAcceptUrl as string)).toContain(
      'http://127.0.0.1:3000/accept-invite',
    );
  },

  async verify(ctx) {
    // finalize_invite_delivery ran: the row says sent, which is the durable
    // consequence of both emails having left.
    await expectInvite(
      ctx.adminEvidence!.request,
      ctx.state.dealCode as string,
      ctx.state.directorEmail as string,
      { status: 'pending', deliveryStatus: 'sent' },
    );
  },
};
```

- [ ] **Step 2: Add it to the journey**

Import `readInviteMail` and append it to `JOURNEY` after `inviteExternalDirector`.

- [ ] **Step 3: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS. If `assertUi` reports a redirect other than `http://127.0.0.1:3000/accept-invite`, the `supabase/config.toml` allowlist change from Task 1 has not been applied to the running stack — restart Supabase.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/readInviteMail.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): assert both invitation emails, their order, and their idempotency keys"
```

---

## Task 8: Step 5 — accept the invitation in a second identity

**Files:**
- Create: `e2e/steps/acceptInvite.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `ctx.inviteePage`, `ctx.state.inviteAcceptUrl`, `ctx.state.inviteVerificationCode`, `ctx.state.dealCode`.
- Produces: `export const acceptInvite: Step`, `export const INVITEE_PASSWORD: string`, `export const INVITEE_DISPLAY_NAME: string`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/acceptInvite.ts`:

```ts
import { expect } from '@playwright/test';
import type { Step } from './types';

/** Satisfies the accept form's minLength={8} and scores "Strong". */
export const INVITEE_PASSWORD = 'E2e-Invitee-Passw0rd!';
export const INVITEE_DISPLAY_NAME = 'E2E External Director';

/**
 * Step 5 — the invitee accepts, in a context with NO storage state. Their
 * session comes entirely from the real path: the Supabase action link
 * redirects with tokens in the URL hash, the page exchanges them via
 * setSession, then /invites/context -> /invites/verify -> /invites/accept.
 * No second storage state is minted; the setup project is untouched.
 */
export const acceptInvite: Step = {
  name: 'acceptInvite',

  async act(ctx) {
    const page = ctx.inviteePage;
    expect(page, 'acceptInvite needs ctx.inviteePage').toBeTruthy();
    if (!page) return;

    await page.goto(ctx.state.inviteAcceptUrl as string);
    await page.waitForURL(/\/accept-invite/);

    // Containment, before anything is accepted. Two walls stand between this
    // session and the deal and the browser meets the MFA one first: middleware
    // runs before the (authed) layout, and isMfaRequiredForUser is true for an
    // invite-created identity, so an AAL1 session is bounced to /two-factor
    // rather than to /accept-invite. Both are containment; assert the property
    // that holds under either — the project route is not reachable.
    await page.goto(`/projects/${ctx.state.dealCode}`);
    await expect(page).toHaveURL(/\/(two-factor|accept-invite)/);

    // And the API layer's own wall, which is the authoritative one.
    const denied = await page.request.get(
      `/api/v1/deals/${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(
      denied.status(),
      'an unaccepted invitee reached the deal API',
    ).toBe(403);

    // Back to the invitation and finish it.
    await page.goto('/accept-invite');
    await page
      .getByLabel('Verification code')
      .fill(ctx.state.inviteVerificationCode as string);
    await page.getByRole('button', { name: 'Verify code' }).click();

    await expect(page.getByLabel('Your name')).toBeVisible();
    await page.getByLabel('Your name').fill(INVITEE_DISPLAY_NAME);
    await page.getByLabel('Password').fill(INVITEE_PASSWORD);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Accept invitation' }).click();
  },

  async assertUi(ctx) {
    const page = ctx.inviteePage;
    if (!page) return;
    // Acceptance routes to the server-owned MFA gate, carrying the deal as the
    // destination. Under MFA_ENFORCEMENT=invite_only this gate is mandatory
    // for an invitee and DISABLE_MFA does not exempt them (design D8).
    await page.waitForURL(/\/two-factor/);
    expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(
      `/projects/${ctx.state.dealCode}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Set up two-factor authentication' }),
    ).toBeVisible();
  },

  async verify(ctx) {
    // The invitation is spent. Read as the firm admin, who can see the deal's
    // invite rows; the invitee themselves is mid-enrollment.
    const invites = await ctx.adminEvidence!.request.get(
      `/api/v1/invites?dealId=${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(invites.status()).toBe(200);
    const row = ((await invites.json()) as {
      invites: Array<{ email: string; status: string }>;
    }).invites.find((invite) => invite.email === ctx.state.directorEmail);
    expect(row?.status, 'the invitation is still pending after acceptance').toBe(
      'accepted',
    );
  },
};
```

- [ ] **Step 2: Give the spec an invitee context**

In the spec, after the admin context:

```ts
  // The second identity. No storage state, deliberately: the invitee's session
  // is the thing this journey proves, so it must come from the action link.
  const inviteeContext = await browser.newContext({ baseURL });
  const inviteePage = await inviteeContext.newPage();
```

Add `inviteePage` to `ctx`, add `await inviteeContext.close();` to the
`finally` block, and append `acceptInvite` to `JOURNEY`.

- [ ] **Step 3: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS. A dead-end reading "This invitation could not be verified for your account" means the action link was consumed twice — check that nothing navigates to `inviteAcceptUrl` more than once.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/acceptInvite.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): accept the invitation in a second identity, containment first"
```

---

## Task 9: Step 6 — enrol MFA for real

**Files:**
- Create: `e2e/steps/enrolMfa.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `totpCodeWithWindowGuard` (Task 2); `getByTestId('mfa-manual-secret')` (Task 3); `ctx.inviteePage`.
- Produces: `export const enrolMfa: Step`; sets `ctx.state.mfaSecret`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/enrolMfa.ts`:

```ts
import { expect } from '@playwright/test';
import { totpCodeWithWindowGuard } from '../support/totp';
import type { Step } from './types';

/**
 * Step 6 — enrol a real TOTP factor. Not configured away: under
 * MFA_ENFORCEMENT=invite_only, isMfaRequiredForUser returns
 * wasCreatedFromEmailInvite(user) and does not consult isMfaBypassEnabled, so
 * DISABLE_MFA=1 does not exempt an invitee. Removing the variable would make
 * the suite test a configuration the product does not run and skip a gate
 * every real invitee passes (design D8).
 *
 * The enrollment screen renders the base32 secret as visible text beside the
 * QR, so the test reads it and computes the current code the way an
 * authenticator app would.
 */
export const enrolMfa: Step = {
  name: 'enrolMfa',

  async act(ctx) {
    const page = ctx.inviteePage;
    expect(page, 'enrolMfa needs ctx.inviteePage').toBeTruthy();
    if (!page) return;

    const secret = (await page.getByTestId('mfa-manual-secret').innerText()).trim();
    expect(secret, 'the manual setup key is empty').toMatch(/^[A-Z2-7]+$/);
    ctx.state.mfaSecret = secret;

    // The guard waits out a step boundary rather than submit a code that is
    // about to expire between generation and verification (design D9).
    await page.getByLabel('Six-digit code').fill(await totpCodeWithWindowGuard(secret));
    await page.getByRole('button', { name: 'Verify and continue' }).click();

    // GoTrue tolerates one step of skew, so a rejection here is a genuine
    // failure rather than a boundary artifact. Regenerate once regardless: the
    // page clears the field and stays put on rejection, which is exactly the
    // recoverable case.
    const rejected = page.getByRole('alert').filter({
      hasText: 'The authenticator code was not accepted',
    });
    if (await rejected.isVisible().catch(() => false)) {
      await page.getByLabel('Six-digit code').fill(await totpCodeWithWindowGuard(secret));
      await page.getByRole('button', { name: 'Verify and continue' }).click();
    }
  },

  async assertUi(ctx) {
    const page = ctx.inviteePage;
    if (!page) return;
    // Enrollment succeeded, the mfa_enrolled audit was recorded, and the page
    // continued to the destination it was handed.
    await page.waitForURL(`**/projects/${ctx.state.dealCode}`);
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  },

  async verify(ctx) {
    const page = ctx.inviteePage;
    if (!page) return;
    // The session reached AAL2: every project route is middleware-gated on it
    // for this identity, so simply being on one is the proof — assert it
    // directly anyway, from the invitee's own session.
    const me = await page.request.get('/api/v1/me');
    expect(me.status(), 'the invitee session cannot read /api/v1/me').toBe(200);
  },
};
```

- [ ] **Step 2: Add it to the journey**

Import `enrolMfa` and append it to `JOURNEY`.

- [ ] **Step 3: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS. Two consecutive rejections mean host-clock skew against the Supabase container, not a boundary problem; check `date` on both.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/enrolMfa.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): drive real TOTP enrollment for the invitee (D8/D9)"
```

---

## Task 10: Step 7 — the scoped shell

**Files:**
- Create: `e2e/steps/assertScopedShell.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `ctx.inviteePage`, `ctx.state.dealCode`, `ctx.state.inviteePhase`.
- Produces: `export const assertScopedShell: Step`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/assertScopedShell.ts`:

```ts
import { expect } from '@playwright/test';
import type { Step } from './types';

/**
 * The desktop rail's per-deal rows for the 'external' perspective, derived
 * from ALLOWED_DESTINATIONS.external (src/lib/perspective/access.ts:62) mapped
 * through the Sidebar's PER_DEAL_NAV_REST labels. Written out rather than
 * imported: importing the set would let a widened perspective pass a test whose
 * whole job is to notice that it widened.
 */
const OFFERED = ['Rails', 'Team', 'Mail', 'Data Room', 'Audit Trail'];

/** Never offered to a counterparty. 'Ask' is chat, which external does not hold. */
const WITHHELD = ['Deal Folder', 'Skills', 'Ask'];

/** Denied destinations, as URL suffixes. Buyers has no rail row at all, so the
 *  navigation attempt is the only way to cover it. */
const DENIED_ROUTES = ['/deal-folder', '/skills', '/acquirers'];

/**
 * Step 7 — the scoped shell. ALLOWED_DESTINATIONS.external is the promise that
 * a counterparty never reaches the internal Deal Folder, the ranked Buyers, or
 * Skills. Nothing else renders that set in a real browser and checks it.
 */
export const assertScopedShell: Step = {
  name: 'assertScopedShell',

  async act(ctx) {
    const page = ctx.inviteePage;
    expect(page, 'assertScopedShell needs ctx.inviteePage').toBeTruthy();
    if (!page) return;
    await page.goto(`/projects/${ctx.state.dealCode}/rail`);
  },

  async assertUi(ctx) {
    const page = ctx.inviteePage;
    if (!page) return;
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });

    for (const label of OFFERED) {
      await expect(
        nav.getByRole('link', { name: label, exact: true }),
        `the invitee's rail does not offer ${label}`,
      ).toBeVisible();
    }
    for (const label of WITHHELD) {
      await expect(
        nav.getByRole('link', { name: label, exact: true }),
        `the invitee's rail offers ${label}, which is internal-only`,
      ).toHaveCount(0);
    }

    // Direct navigation is attempted and must not land: the shell bounces a
    // denied destination back to the deal home.
    for (const suffix of DENIED_ROUTES) {
      await page.goto(`/projects/${ctx.state.dealCode}${suffix}`);
      await expect(
        page,
        `the invitee landed on ${suffix}`,
      ).toHaveURL(new RegExp(`/projects/${ctx.state.dealCode}/?$`));
    }
  },

  async verify(ctx) {
    const page = ctx.inviteePage;
    if (!page) return;
    const response = await page.request.get('/api/v1/me');
    expect(response.status()).toBe(200);
    const me = (await response.json()) as {
      user: { email: string; status: string; is_external: boolean };
      memberships: Array<{ deal_code: string | null; deal_role: string; phase: number }>;
    };

    expect(me.user.email).toBe(ctx.state.directorEmail);
    expect(me.user.status, 'the invitee was not activated by acceptance').toBe('active');
    expect(me.user.is_external, 'the invitee is not flagged external').toBe(true);

    const membership = me.memberships.find(
      (seat) => seat.deal_code === ctx.state.dealCode,
    );
    expect(membership, 'the invitee has no seat on the deal').toBeTruthy();
    expect(membership?.deal_role).toBe('seller');
    // The phase the inviter confirmed on screen is the phase actually granted.
    expect(membership?.phase).toBe(ctx.state.inviteePhase);
  },
};
```

- [ ] **Step 2: Add it to the journey**

Import `assertScopedShell` and append it to `JOURNEY`.

- [ ] **Step 3: Run the journey**

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/assertScopedShell.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): render the external destination set in a browser and check it"
```

---

## Task 11: Step 8 — the roster reflects the acceptance

**Files:**
- Create: `e2e/steps/assertRosterReflectsAcceptance.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: `ctx.page` (the MD), `ctx.evidence`, `ctx.state.dealCode`, `ctx.state.directorEmail`.
- Produces: `export const assertRosterReflectsAcceptance: Step`.

- [ ] **Step 1: Write the step**

Create `e2e/steps/assertRosterReflectsAcceptance.ts`:

```ts
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { INVITEE_DISPLAY_NAME } from './acceptInvite';
import type { Step } from './types';

/**
 * Step 8 — close the loop on the MD's own screen. The pending row the MD saw
 * in step 3 is now a seated member, and the deal's audit trail carries both
 * halves of the transaction.
 */
export const assertRosterReflectsAcceptance: Step = {
  name: 'assertRosterReflectsAcceptance',

  async act(ctx) {
    await ctx.page.goto(`/projects/${ctx.state.dealCode}/team`);
  },

  async assertUi(ctx) {
    const roster = ctx.page.getByRole('region', { name: 'Team roster' });
    await expect(roster).toBeVisible();

    // The seated member row: a button carrying the name and the email.
    const seat = roster.getByRole('button', {
      name: new RegExp(INVITEE_DISPLAY_NAME),
    });
    await expect(seat).toBeVisible();
    await expect(seat).toContainText(ctx.state.directorEmail as string);
    await expect(seat).toContainText('On platform');

    // And the pending row is gone: no "Invite pending" line for that address.
    await expect(
      roster
        .getByRole('listitem')
        .filter({ hasText: ctx.state.directorEmail as string })
        .filter({ hasText: 'Invite pending' }),
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { members } = await ctx.evidence.getDeal(ref);
    const seat = members.find(
      (member) => member.user?.email === ctx.state.directorEmail,
    );
    expect(
      seat,
      `the invitee is not a member of ${ref}; saw: ${members
        .map((member) => member.user?.email ?? '(none)')
        .join(', ')}`,
    ).toBeTruthy();
    expect(seat?.deal_role).toBe('seller');

    await ctx.evidence.expectAudit(ref, { action: 'invite_accepted', since: ctx.since });
    await ctx.evidence.expectAudit(ref, { action: 'grant', since: ctx.since });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
```

- [ ] **Step 2: Add it to the journey**

Import `assertRosterReflectsAcceptance` and append it to `JOURNEY`. The list is
now the design's eight steps in order.

- [ ] **Step 3: Run both journeys**

Run: `npm run test:e2e`
Expected: PASS, 2 journeys.

- [ ] **Step 4: Commit**

```bash
git add e2e/steps/assertRosterReflectsAcceptance.ts e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): close the loop on the MD's roster and the deal's audit trail"
```

---

## Task 12: Skip the journey under the live tier

**Files:**
- Modify: `e2e/journeys/invite-onboarding.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Add the skip**

At the top of the test body in `e2e/journeys/invite-onboarding.spec.ts`, before
any context is created:

```ts
test('the invite onboarding journey', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  // The first journey to bend D1's project-agnostic rule, and it bends because
  // real delivery genuinely cannot be read back by a test (design D7): the
  // suite terminates the Resend call itself. Skipped, not failed, under live.
  test.skip(
    testInfo.project.name === 'live',
    'invite delivery is stubbed in-suite; there is nothing to assert against a deployed environment',
  );
```

- [ ] **Step 2: Verify it skips under live and runs under hermetic**

Run: `E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test --project=live --grep "invite onboarding" --list`
then: `E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test --project=live --grep "invite onboarding"`
Expected: reported as **skipped**, not failed, and not passed.

Run: `npm run test:e2e -- --grep "invite onboarding"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/journeys/invite-onboarding.spec.ts
git commit -m "test(e2e): skip the invite journey under the live project (D7)"
```

---

## Task 13: Teardown on success only

**Files:**
- Create: `scripts/lib/recycleInvitee.ts`
- Modify: `scripts/reset-demo-invitee.ts`
- Create: `e2e/support/teardown.ts`
- Modify: `e2e/journeys/invite-onboarding.spec.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: `@supabase/supabase-js` `createClient`; `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`.
- Produces:
  - `scripts/lib/recycleInvitee.ts`: `export type RecycleResult = { invitesRemoved: number; seatsRemoved: number; tombstone: string | null }`, `export async function recycleInvitee(admin: SupabaseClient, email: string): Promise<RecycleResult>`
  - `e2e/support/teardown.ts`: a Playwright test file, no exports.
  - `e2e/journeys/invite-onboarding.spec.ts` writes `e2e/auth/.state/invite-teardown.json` on success.

- [ ] **Step 1: Extract the recycling routine**

Create `scripts/lib/recycleInvitee.ts`, moving the body of
`scripts/reset-demo-invitee.ts`'s `main()` verbatim into a function that takes
the client and the email:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type RecycleResult = {
  invitesRemoved: number;
  seatsRemoved: number;
  /** The address the identity was renamed to, or null when none existed. */
  tombstone: string | null;
};

/**
 * Free an invitee address for reuse: delete its invitations, drop the mirror
 * user's seats, and TOMBSTONE the identity rather than delete it.
 *
 * Tombstoning, not deletion, because audit_log.actor_id references users and
 * the audit log is immutable evidence. The row is renamed to
 * <local>+used-<ts>@<domain> and suspended; the auth identity takes the same
 * name, so a fresh invitation for the original address mints a brand-new
 * identity. Never touches any other account.
 *
 * Shared by `npm run demo:reset-invitee` and the E2E teardown project, so the
 * two cannot drift (design D12).
 */
export async function recycleInvitee(
  admin: SupabaseClient,
  rawEmail: string,
): Promise<RecycleResult> {
  const email = rawEmail.trim().toLowerCase();

  // invite_domain_confirmations references consumed invites without ON DELETE;
  // clear those rows first so the invite delete can proceed.
  const { data: staleInvites } = await admin.from('invites').select('id').eq('email', email);
  const staleIds = (staleInvites ?? []).map((row) => row.id as string);
  if (staleIds.length > 0) {
    const { error } = await admin
      .from('invite_domain_confirmations')
      .delete()
      .in('consumed_invite_id', staleIds);
    if (error) throw new Error(`confirmations delete failed: ${error.message}`);
  }

  const { error: invitesError, count } = await admin
    .from('invites')
    .delete({ count: 'exact' })
    .eq('email', email);
  if (invitesError) throw new Error(`invites delete failed: ${invitesError.message}`);

  const { data: user, error: userError } = await admin
    .from('users')
    .select('id, status')
    .eq('email', email)
    .maybeSingle();
  if (userError) throw new Error(`user lookup failed: ${userError.message}`);
  if (!user) {
    return { invitesRemoved: count ?? 0, seatsRemoved: 0, tombstone: null };
  }

  const { error: seatsError, count: seatCount } = await admin
    .from('deal_memberships')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  if (seatsError) throw new Error(`seat delete failed: ${seatsError.message}`);

  const [local, domain] = email.split('@');
  const tombstone = `${local}+used-${Date.now()}@${domain}`;

  const { error: authError } = await admin.auth.admin.updateUserById(user.id as string, {
    email: tombstone,
    user_metadata: { invite_id: null, credential_nonce: null },
  });
  if (authError) throw new Error(`auth tombstone failed: ${authError.message}`);

  const { error: mirrorError } = await admin
    .from('users')
    .update({ email: tombstone, status: 'suspended', company_id: null, company_role: null })
    .eq('id', user.id);
  if (mirrorError) throw new Error(`mirror tombstone failed: ${mirrorError.message}`);

  return { invitesRemoved: count ?? 0, seatsRemoved: seatCount ?? 0, tombstone };
}
```

- [ ] **Step 2: Point the demo script at it**

Rewrite `scripts/reset-demo-invitee.ts`'s `main()` to:

```ts
async function main() {
  const result = await recycleInvitee(admin, email);
  console.log(`invites removed: ${result.invitesRemoved}`);
  if (!result.tombstone) {
    console.log('No mirror user for that email. Fresh state — done.');
    return;
  }
  console.log(`deal seats removed: ${result.seatsRemoved}`);
  console.log(
    `identity recycled: ${email} -> ${result.tombstone} (suspended). Ready for a fresh invite.`,
  );
}
```

Keep the file's header comment, its env validation, its `admin` client, and its
`main().catch(...)` tail exactly as they are. Add
`import { recycleInvitee } from './lib/recycleInvitee';`.

- [ ] **Step 3: Verify the demo script still runs**

Run: `INVITEE_EMAIL=nobody-here@example.test npm run demo:reset-invitee`
Expected: `invites removed: 0` then `No mirror user for that email. Fresh state — done.` (needs a `.env.local` pointing at a local stack).

- [ ] **Step 4: Have the journey record what it created, on success only**

At the end of `e2e/journeys/invite-onboarding.spec.ts`, inside the `try` block
after the final assertion:

```ts
    // A passing run leaves nothing behind; a failing one leaves everything.
    // The manifest is written HERE, after the last assertion, so it exists
    // only on success — and a failed run is exactly when the rows matter,
    // because the trace refers to them and reading the invite row is often how
    // the failure is diagnosed (design D12).
    writeTeardownManifest([state.colleagueEmail, state.directorEmail]);
```

with, above the test:

```ts
import fs from 'node:fs';
import path from 'node:path';

export const TEARDOWN_MANIFEST = path.join(
  __dirname,
  '..',
  'auth',
  '.state',
  'invite-teardown.json',
);

function writeTeardownManifest(emails: Array<string | undefined>) {
  const addresses = emails.filter((email): email is string => Boolean(email));
  fs.mkdirSync(path.dirname(TEARDOWN_MANIFEST), { recursive: true });
  const existing: string[] = fs.existsSync(TEARDOWN_MANIFEST)
    ? (JSON.parse(fs.readFileSync(TEARDOWN_MANIFEST, 'utf8')) as string[])
    : [];
  fs.writeFileSync(
    TEARDOWN_MANIFEST,
    JSON.stringify([...new Set([...existing, ...addresses])], null, 2),
  );
}
```

`e2e/auth/.state/` is already gitignored (`.gitignore:25`), so the manifest is
never committed.

- [ ] **Step 5: Write the teardown project**

Create `e2e/support/teardown.ts`:

```ts
import fs from 'node:fs';
import { test as teardown } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { recycleInvitee } from '../../scripts/lib/recycleInvitee';
import { TEARDOWN_MANIFEST } from '../journeys/invite-onboarding.spec';

/**
 * Delete this run's invitations and the identities it created (design D12).
 *
 * The MD spine leaves everything it creates, which is survivable for ordinary
 * tenant data. This journey creates two things it does not: each acceptance
 * mints a real auth.users row, its mirror, and an enrolled TOTP factor — a
 * GLOBAL identity namespace rather than deal-scoped data — and a run that dies
 * mid-flight strands a pending invitation permanently. Neither blocks a later
 * run, because every address carries the run id, but both grow without bound
 * where reuseExistingServer is on and nothing resets.
 *
 * It runs only when the journey passed: the manifest is written by the spec
 * after its last assertion. A failing run leaves no manifest, so this is a
 * no-op and the rows survive for diagnosis.
 *
 * Scope: this journey's own rows. Retrospective cleanup of what the foundation
 * and the MD spine already leave behind is issue #15, which should converge on
 * this mechanism rather than inventing a second one.
 */
teardown('recycle the invite journey rows', async () => {
  if (!fs.existsSync(TEARDOWN_MANIFEST)) {
    console.log('no teardown manifest; the journey did not pass. Rows left intact.');
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(
      'E2E teardown needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.',
    );
  }
  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const emails = JSON.parse(fs.readFileSync(TEARDOWN_MANIFEST, 'utf8')) as string[];
  for (const email of emails) {
    const result = await recycleInvitee(admin, email);
    console.log(
      `recycled ${email}: ${result.invitesRemoved} invite(s), ${result.seatsRemoved} seat(s)` +
        (result.tombstone ? `, identity -> ${result.tombstone}` : ', no identity'),
    );
  }

  fs.rmSync(TEARDOWN_MANIFEST);
});
```

- [ ] **Step 6: Register the teardown project**

In `playwright.config.ts`, add a project and attach it to `hermetic` only (the
journey is skipped under `live`, so no manifest is ever written there):

```ts
    {
      name: 'cleanup',
      testDir: path.join(__dirname, 'e2e/support'),
      testMatch: /teardown\.ts$/,
      use: { baseURL: HERMETIC_BASE_URL },
    },
```

and on the `hermetic` project add:

```ts
      teardown: 'cleanup',
```

- [ ] **Step 7: Verify teardown runs and cleans up after a pass**

Run: `npm run test:e2e`
Expected: PASS, and the run log shows `recycled e2e-colleague-…` and
`recycled e2e-director-…`. Then confirm nothing survives:

```bash
psql "$(supabase status -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')" \
  -c "select email, status from public.users where email like 'e2e-%@%' and email not like '%+used-%';" \
  -c "select email, status from public.invites where email like 'e2e-%';"
```

Expected: both queries return zero rows.

- [ ] **Step 8: Verify a failing run leaves the rows intact**

Temporarily break the last assertion in `assertRosterReflectsAcceptance.verify`
(for example change `'seller'` to `'buyer'`), run
`npm run test:e2e -- --grep "invite onboarding"`, and confirm the same two
queries DO return rows and that no manifest was written. Then revert the
deliberate break and re-run to green.

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/recycleInvitee.ts scripts/reset-demo-invitee.ts \
  e2e/support/teardown.ts e2e/journeys/invite-onboarding.spec.ts playwright.config.ts
git commit -m "test(e2e): tear down the invite journey's rows on success only (D12)"
```

---

## Task 14: Documentation and the decision record

**Files:**
- Modify: `docs/03-engineering/e2e-testing.md`
- Modify: `docs/07-decisions/decision-log.md`
- Modify: `CLAUDE.md` (the "W1 remaining" line)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Document the journey**

Add to `docs/03-engineering/e2e-testing.md`, after the tier table:

```markdown
## The journeys

| Journey | Spec | Tiers | What it proves |
|---|---|---|---|
| MD spine | `e2e/journeys/md-spine.spec.ts` | hermetic + live | One identity can work a deal: lead, mandate, rail, data room, mail, advance. |
| Invite onboarding | `e2e/journeys/invite-onboarding.spec.ts` | **hermetic only** | A second firm joins one: Gate 0 colleague invite, external director invited from Team, mail, six-digit challenge, TOTP enrollment, acceptance, scoped shell. |

Design of record for the second: `docs/superpowers/specs/2026-08-27-invite-onboarding-e2e-design.md`.

### Why the invite journey is hermetic-only

It is the one journey that bends the project-agnostic rule, and it bends
because real delivery cannot be read back by a test. Invite email is real
Resend, called server-side by raw `fetch` (`src/lib/email/resend.ts`); there is
no outbox row for it (`outbound_messages` is the unrelated compliance channel),
and Supabase's local Inbucket never sees it because `generateLink` mints a link
without sending. So the suite terminates the send itself: `RESEND_API_BASE`
points the send path at `e2e/support/mailStub.ts`, a `node:http` server
speaking that endpoint's shape, booted as a second Playwright `webServer` on
port 4310. Nothing leaves the process, which is a stronger guarantee than any
hosted sandbox inbox — and the vendor contract itself stays pinned at the
payload level by `tests/invite-email.test.ts`.

The journey is `test.skip`-ed under the `live` project rather than failed.

### The three identities

- **Storm Duncan (MD)** — registers the lead, opens the mandate, reads the
  roster at the end. Storage state from the setup project.
- **The firm admin** — sends the external director's invitation, and only that.
  A company's FIRST director invitation is a company-management act, so
  `POST /api/v1/invites` requires `firm_role = 'admin'` or a directorship of
  the target company. Storm directs the bank, not the freshly registered lead,
  so the product refuses him and says so on screen. Storage state from the
  setup project.
- **The invitee** — a context with **no** storage state. Their session comes
  entirely from the real acceptance path: the action link's hash tokens,
  `setSession`, then context → verify → accept. Nothing about this identity is
  minted for the test.

### MFA is driven, not configured away

Under `MFA_ENFORCEMENT=invite_only`, `isMfaRequiredForUser` returns
`wasCreatedFromEmailInvite(user)` and never consults `isMfaBypassEnabled`, so
`DISABLE_MFA=1` does not exempt an invitee. Enrollment is a step of the invite
flow, not an adjacent auth concern, and the journey enrols for real:
`e2e/support/totp.ts` implements RFC 6238 over `node:crypto` (no dependency
added) and waits out a 30-second step boundary rather than submit a code about
to expire.

### Running it locally

Beyond the foundation's prerequisites:

```
npm run seed:flags:enable   # platform_onboarding; every invite route 404s without it
```

`INVITE_VERIFICATION_PEPPER`, `RESEND_API_BASE`, `RESEND_API_KEY` and
`RESEND_FROM` are set for you in `playwright.config.ts`'s `webServer` env. The
Supabase stack must be restarted after `supabase/config.toml`'s
`additional_redirect_urls` change, or the invite link falls back to `site_url`
and strands the invitee on the picker.

### Teardown

A `cleanup` teardown project recycles the run's invitations and identities
using the same delete-and-tombstone routine as `npm run demo:reset-invitee`
(`scripts/lib/recycleInvitee.ts`). It runs **only when the journey passed** —
the spec writes `e2e/auth/.state/invite-teardown.json` after its last assertion,
and the teardown is a no-op without it. A failing run is exactly when the rows
matter: the trace refers to them, and reading the invite row is often how the
failure is diagnosed.

Identities are tombstoned rather than deleted because `audit_log.actor_id`
references `users` and the audit log is immutable evidence.
```

- [ ] **Step 2: Record the decision**

Append a dated entry to `docs/07-decisions/decision-log.md` in the file's
existing format, covering: the mail seam and the hermetic-only consequence
(D7); MFA driven rather than configured away (D8); TOTP in-suite with a window
guard (D9); inviting into the journey's own lead company (D10); Gate 0 and Team
covering different things (D11); teardown on success only (D12); and the two
resolutions this plan added — the firm admin sends the first director
invitation (OQ4), and the pre-acceptance containment redirect lands on
`/two-factor` first because middleware precedes the layout (OQ5).

- [ ] **Step 3: Update the repo's status line**

In `CLAUDE.md`, the line

```
**W1 remaining:** E2E Ignatious path.
```

becomes

```
**W1 remaining:** E2E Ignatious path. Shipped: the MD spine and the invite onboarding journey (`e2e/`, hermetic-gating).
```

- [ ] **Step 4: Final verification**

Run each and confirm the output before claiming completion:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run test:e2e
```

Expected: all four clean, and `npm run test:e2e` reports 2 journeys passed plus
the setup and cleanup projects.

- [ ] **Step 5: Commit**

```bash
git add docs/03-engineering/e2e-testing.md docs/07-decisions/decision-log.md CLAUDE.md
git commit -m "docs(e2e): document the invite onboarding journey and its decisions"
```

---

## Done when

- `npm run test:e2e` runs both journeys green against a local hermetic stack.
- The invite journey is **skipped**, not failed, under the `live` project.
- No third-party credential is required to run the hermetic tier.
- A passing run leaves no invitation rows and no auth identities behind; a failing one leaves them intact for diagnosis.
- A regression in containment, the challenge, MFA enrollment, or the external destination set fails CI rather than surfacing during a demo.
- No CI job and no CI step were added.
