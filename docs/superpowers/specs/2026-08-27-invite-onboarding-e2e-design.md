# Invite Onboarding E2E Journey — Design

**Date:** 2026-08-27
**Status:** Approved design, pending implementation plan
**Base branch:** `feat/e2e-foundation`
**Predecessor:** `docs/superpowers/specs/2026-08-26-e2e-foundation-design.md`

## Problem

The foundation spec deferred exactly one journey and named it as the intended
second: *"the multi-identity onboarding journey (firm admin invites an external
director, who receives mail, accepts, verifies, and lands in a scoped shell). It
is the flow with the most demo risk and the one that is manual today."*

It is still manual today. An engineer proves it by running `npm run
dev:mint-invite`, opening a private window, pasting a link, typing a code, and
looking at the result. Nothing in CI notices when any link in that chain breaks,
and the chain is long: invite creation, domain preflight, credential
containment, two emails in a required order, a Supabase action link, a six-digit
challenge with a five-attempt lock, TOTP enrollment, acceptance, and a shell
whose navigation must be narrower than the MD's.

The MD spine proves one identity can work a deal. It proves nothing about the
moment a second firm joins one.

## Evidence

The flow is fully built and well covered at the unit tier — `tests/` carries
more than a dozen files across invite routes, delivery, authority parity, the
challenge digest, phase carry, and the accept page. What no tier covers is the
composition: the same browser session travelling from a sent invitation to a
scoped shell.

Two properties of the shipped code make that composition worth proving in a
browser specifically, because neither is visible to a unit test:

1. **Containment is cross-layer.** `deliverInvite` flips the mirror row to
   `status='invited'` before the credential leaves the process
   (`src/lib/api/v1/inviteDelivery.ts:143-151`), and `(authed)/layout.tsx:36`
   redirects such a user to `/accept-invite`. Whether those two agree is a
   runtime question.
2. **The scoped shell is a navigation guarantee.**
   `ALLOWED_DESTINATIONS.external` (`src/lib/perspective/access.ts:62`) is the
   promise that a counterparty never reaches the internal Deal Folder, the
   ranked Buyers, or Skills. Today nothing renders that set in a real browser
   and checks it.

## Scope

**In scope.** One journey — `invite-onboarding` — carrying two invitations: a
bank-internal colleague queued during Gate 0, and an external director invited
from the deal Team roster who accepts, enrols TOTP, and lands in a scoped shell.
Plus the infrastructure that journey needs: a mail seam and stub inbox, a TOTP
helper, and a second browser context.

**Out of scope.** Resend and revoke of a pending invitation; the company members
page at `/companies/[companyId]/members`; the `grant_existing_account_to_deal`
path for an invitee who already has an active account; the five-attempt
challenge lock. Each is a candidate for a later, smaller spec.

## Decisions

### D7 — The mail seam is ours, and the journey is hermetic-only

Invite email is real Resend, called server-side by raw `fetch`
(`src/lib/email/resend.ts`). There is no outbox table for it — `outbound_messages`
is the unrelated compliance channel — and Supabase's local Inbucket never sees
it, because `generateLink` mints a link without sending. A browser cannot
intercept it.

`src/lib/email/resend.ts` gains a base URL read from `RESEND_API_BASE`,
defaulting to `https://api.resend.com`. A stub inbox in the test suite speaks
that endpoint's shape. The hermetic tier points at the stub.

A hosted sandbox inbox was considered and rejected. It requires the same seam,
so it adds a mechanism rather than replacing one; it cannot run on the gating
tier, which is credential-free by construction (D4/D6); and the only coverage it
buys over the stub is "the vendor accepted our HTTP call", which
`tests/invite-email.test.ts` already pins at the payload level and which goes red
during a vendor incident. The stub's guarantee that nothing reaches a real
person is stronger, because nothing leaves the process.

**Consequence, accepted:** this journey is hermetic-only. It is tagged to skip
under the `live` project. This is the first journey to bend D1's
project-agnostic rule, and it bends because real delivery genuinely cannot be
read back by a test — not for convenience.

### D8 — MFA enrollment is driven in the browser, not configured away

Under `MFA_ENFORCEMENT=invite_only`, `isMfaRequiredForUser` returns
`wasCreatedFromEmailInvite(user)` and **does not consult `isMfaBypassEnabled`**
(`src/lib/auth/mfaPolicy.ts:23-28`). `DISABLE_MFA=1` therefore does not exempt an
invitee. Enrollment is a mandatory step of the invite flow, not an adjacent auth
concern.

Removing `MFA_ENFORCEMENT` from the hermetic environment would make the suite
test a configuration the product does not run, and would skip a gate every real
invitee passes. The variable stays, and the journey enrols for real: the
enrollment screen renders the base32 secret as visible text beside the QR
(`src/app/two-factor/page.client.tsx:264-266`), so the test reads it from the
DOM and computes the current code.

This does not contradict D2. D2 excludes `/sign-in` because that boundary is
unit-covered and re-driving it adds cost without coverage. Here the gate is
unavoidable: the journey cannot reach the scoped shell without passing it.

**Consequence, accepted:** a bounded timing hazard at the 30-second window
boundary, mitigated in D9.

### D9 — TOTP is computed in-suite, with an explicit window guard

`e2e/support/totp.ts` implements RFC 6238 over `node:crypto` — roughly 25 lines,
no new dependency and no supply-chain surface added to the suite.

Before generating, the helper computes the time remaining in the current 30
second step and waits for the next one if under three seconds. On rejection it
regenerates once. GoTrue tolerates one step of skew, and the hermetic Supabase
runs on the host clock, so drift is not a factor.

### D10 — The journey invites into a company it created itself

Step 1 registers a lead; Gate 0 seats that lead as the deal's counterparty; the
Team invite modal's company picker offers the bank plus every deal party
(`src/components/team/InviteModal.tsx:93-115`). The external director is
therefore invited into the journey's own lead company, with no dependency on
`seed-onboarding-demo.ts`.

That company has no active director yet, so `POST /api/v1/invites` returns 409
`company_requires_director` for a `member` invite
(`src/app/api/v1/invites/route.ts:197-211`). The first invitation into it must
carry `companyRole: 'director'` — which is the role the journey wants regardless.

### D11 — Gate 0 covers the internal path, Team covers the external one

Gate 0's invite queue is bank-internal by construction: `postQueuedInvite(chip,
bankId, …)` with `companyRole` fixed to `member`
(`src/components/wizard/Gate0Wizard.tsx:169-215, 971`). It cannot produce an
external identity and therefore cannot reach a scoped shell.

Both surfaces are in the journey because they cover different things. The Gate 0
chip is nearly free — the suite already drives that wizard — and covers how
invitations are born on the real onboarding path, including the receipt banner.
The Team invitation is the one that carries the demo risk and the one whose
acceptance the journey follows to the end.

### D12 — The journey tears down its own rows, but only when it passed

The MD spine leaves everything it creates. That is survivable for ordinary
tenant data, and in CI it is moot: `ci.yml:133` runs `supabase db reset --local`
on an ephemeral runner. Locally, where `reuseExistingServer` is on and nothing
resets, rows accumulate indefinitely.

This journey creates two things the spine does not. Each acceptance mints a real
`auth.users` row, its mirrored `public.users` row, and after step 6 an enrolled
TOTP factor — a global identity namespace rather than deal-scoped data. And a
run that dies between steps 3 and 5 strands a `pending` invitation permanently.
Neither blocks a later run, because every address carries the run id, but both
grow without bound.

A Playwright teardown project therefore deletes this run's invitations and the
identities it created, keyed on the run id and executed with the service key. It
reuses the deletion and tombstoning logic `scripts/reset-demo-invitee.ts`
already implements for recycling a demo address.

**It runs only when the journey passed.** A failed run is exactly when the rows
matter: the trace refers to them, and reading the invite row is often how the
failure is diagnosed. Unconditional cleanup would destroy the evidence at the
only moment anyone wants it.

**Scope note.** This covers the invite journey's own rows. Retrospective cleanup
of everything the foundation and the MD spine already leave behind is tracked
separately in [#15](https://github.com/Conductia/Conductia/issues/15), and is
deliberately not folded into this design. That issue should converge on this
mechanism rather than inventing a second one.

## Architecture

### Layout

Additions only. Nothing in the foundation moves.

```
e2e/
  support/
    mailStub.ts       # NEW · HTTP server speaking the Resend send endpoint
    inbox.ts          # NEW · client reading the stub's captured messages
    totp.ts           # NEW · RFC 6238 over node:crypto
    teardown.ts       # NEW · deletes this run's invites and identities
  steps/
    gate0.ts          # NEW · runGate0Wizard(ctx, { inviteEmails })
    createDealWithColleagueInvite.ts   # NEW
    inviteExternalDirector.ts   # NEW
    readInviteMail.ts           # NEW
    acceptInvite.ts             # NEW
    enrolMfa.ts                 # NEW
    assertScopedShell.ts        # NEW
    assertRosterReflectsAcceptance.ts  # NEW
  journeys/
    invite-onboarding.spec.ts   # NEW
```

`createDeal` is not forked. Its wizard driving moves into
`runGate0Wizard(ctx, opts)`, and both `createDeal` (no chips) and the new
`createDealWithColleagueInvite` call it. `md-spine` keeps its current behaviour
unchanged.

### The journey

Eight steps, each with the foundation's `act` / `assertUi` / `verify` contract.

| # | Step | What the browser does | What `verify()` reads back |
|---|---|---|---|
| 1 | `registerLead` | existing, unchanged | company row, type `client` |
| 2 | `createDealWithColleagueInvite` | Gate 0 wizard with one queued chip; asserts the receipt banner | deal row; the colleague's invite `pending` |
| 3 | `inviteExternalDirector` | Team → "Invite to platform" → lead company, role `director`, domain confirmation | invite `pending`, `delivery_status: sent`; audit `invite_sent` |
| 4 | `readInviteMail` | — (reads the stub) | exactly two messages to that address, code before link, idempotency keys present |
| 5 | `acceptInvite` | second context: action link → code → name, password, ToS | containment redirect before accepting; `accept` returns the deal |
| 6 | `enrolMfa` | `/two-factor`: read secret, generate, submit | session reaches AAL2 |
| 7 | `assertScopedShell` | invitee's rail | `GET /api/v1/me`: `status: active`, `is_external: true`, membership with carried phase |
| 8 | `assertRosterReflectsAcceptance` | MD reloads Team; pending row is now a seated member | deal members include the invitee; audit `invite_accepted` and `grant` |

Step 7's UI assertion is concrete rather than impressionistic: the invitee's rail
offers mandate, rail, data room, team, mail and audit, and **must not** offer
Deal Folder, Buyers, or Skills — the `ALLOWED_DESTINATIONS.external` set. Direct
navigation to the denied destinations is attempted and must not land.

### The second identity

`browser.newContext()` with no storage state. The invitee's session comes
entirely from the real acceptance path: the Supabase action link redirects with
tokens in the URL hash, the page exchanges them via `setSession`, then
`/invites/context` → `/invites/verify` → `/invites/accept`.

No second storage state is minted. The setup project is untouched.

One assertion falls out on the way: before acceptance, that context visiting a
project route must be redirected to `/accept-invite`.

### The mail stub

`e2e/support/mailStub.ts` is a `node:http` server exposing `POST /emails`
(returns `{id}`) and `GET /messages`. It is registered as a second entry in
Playwright's `webServer` array so it boots before Next and is reachable from the
Next server process.

It observes everything real delivery does short of the vendor: the verification
email arriving **before** the link email, the `Idempotency-Key` headers, retry
behaviour, and `finalize_invite_delivery` flipping `delivery_status` to `sent`.

### Environment

Added to the hermetic `webServer` env block:

- `RESEND_API_BASE` — the stub's origin
- `RESEND_API_KEY` — a dummy non-empty value; the send functions throw without one
- `RESEND_FROM`
- `INVITE_VERIFICATION_PEPPER`

`MFA_ENFORCEMENT=invite_only` and `DISABLE_MFA=1` both stay as they are (D8).

One change beyond additions: `supabase/config.toml` allowlists only
`https://127.0.0.1:3000` — the wrong scheme, and a bare origin. The accept link
redirects to `http://127.0.0.1:3000/accept-invite`, which GoTrue would reject in
favour of a silent fallback to `site_url`, stranding the invitee on `/`. The
allowlist needs a path pattern for the hermetic origin.

`platform_onboarding` is a database flag and every invite route returns 404
without it. CI already enables it; `npm run seed:flags:enable` becomes a
documented prerequisite for running the suite locally. `INVITE_VERIFICATION_PEPPER`
is likewise already set in CI, and is needed locally either in the `webServer`
env block or in `.env.local`.

### Data strategy

Both invitee addresses carry the run id. This is required, not merely tidy:
`invites_pending_email_uniq` is a **global** partial unique index on pending
email (`supabase/migrations/20260731120000_onboarding_invites.sql:50-51`), so a
fixed address would collide with any pending invitation left by an earlier run.

The external director's domain will not match a `company_verified_domains` entry,
so `POST /api/v1/invites/preflight` returns `confirmationRequired`. The journey
walks that confirmation rather than seeding around it: it is a real safeguard on
the flow carrying the most demo risk, and skipping it would leave the
`invite_domain_confirmations` path unexercised in a browser.

## CI

No new job and no new step. D5 defines jobs per tier, and the existing "E2E
(hermetic)" job globs `e2e/journeys/**/*.spec.ts`, so it picks the new spec up.
The two prerequisites this journey needs are already there: `ci.yml:141` runs
`enable-flags.ts`, and `ci.yml:146` sets `INVITE_VERIFICATION_PEPPER`.

The mail stub is started by Playwright, not by CI.

## Open questions, to be resolved during implementation

1. **Does the Gate 0 receipt banner expose a role-addressable outcome per chip?**
   Step 2 asserts the queued colleague's invitation reports as sent. If the
   banner has no accessible name per chip, adding one is a normal product change
   under the selector contract.
2. **Is the manual-entry secret addressable?** It renders inside a bare `<code>`
   element. If no role or label disambiguates it, step 6 adds a `data-testid` in
   the same commit — the contract's sanctioned third resort.
3. **Does the accept flow's password step interact with
   `minimum_password_length`?** `supabase/config.toml` sets 6; the fixture
   password must satisfy whatever the accept page enforces.

## Done when

- `npm run test:e2e` runs both journeys green against a local hermetic stack
- The invite journey is skipped, not failed, under the `live` project
- No third-party credential is required to run the hermetic tier
- A passing run leaves no invitation rows and no auth identities behind; a
  failing one leaves them intact for diagnosis
- A regression in containment, the challenge, MFA enrollment, or the external
  destination set fails CI rather than surfacing during a demo
