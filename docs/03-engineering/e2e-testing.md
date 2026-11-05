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

## The journeys

| Journey | Spec | Tiers | What it proves |
|---|---|---|---|
| MD spine | `e2e/journeys/md-spine.spec.ts` | hermetic + live | One identity can work a deal: lead, mandate, rail, data room, mail, advance. |
| Invite onboarding | `e2e/journeys/invite-onboarding.spec.ts` | **hermetic only** | A second firm joins one: Gate 0 colleague invite, external director invited from Team, mail, six-digit challenge, TOTP enrollment, acceptance, scoped shell. |
| Invite rotation | `e2e/journeys/invite-rotation.spec.ts` | **hermetic only** | The invitation lifecycle after the send: resend rotates the credential and retires the previous code, revoke closes the invitation with its dead-end, a re-invitation reopens acceptance. |
| Step ownership | `e2e/journeys/step-ownership.spec.ts` | **hermetic only** | Who may work a rail step: the MD seats a bank member and assigns them one, the member saves and completes it, and is refused on a step somebody else owns — on screen and at the API. |
| Book | `e2e/journeys/book.spec.ts` | **hermetic only** | The whole book in view: the Book home's lifecycle sections and dashes, the MD setting all four graduated Book fields, their survival of a reload, the deal regrouping, and a seated bank member who can only read them. |
| Route guards | `e2e/journeys/route-guards.spec.ts` | hermetic + live (perimeter only under live) | The perimeter: a guarded route bounces a signed-out visitor to `/sign-in`, `/terms` and `/privacy` read without a session, the retired `/about` never renders, the profile is the signed-in person's own record, and Logout puts the browser back outside. |
| Data room wall | `e2e/journeys/data-room-wall.spec.ts` | **hermetic only** | Two rooms, two identities: the MD files internal work product and a client document, a seated counterparty is served the client room alone, and the trail carries the uploads and the download. |
| Access propagation | `e2e/journeys/access-propagation.spec.ts` | **hermetic only** | Permission changes reach an open page: an employee requests Create leads, the director approves it from the bell, the employee's dialog unlocks in place, then the director revokes View Leads and the wall returns. |
| Audit scoping | `e2e/journeys/audit-scoping.spec.ts` | hermetic + live | Two deals in one session: each Audit Trail shows only its own events, and the two durable trails share no row. |
| Step completion | `e2e/journeys/step-completion.spec.ts` | hermetic + live | Bug-bash case 5: a manual rail step refused while a required field is empty, then saved, filed and completed; the next station skipped with a logged approver and reason; both read back on the audit trail and the Conductor Center. |
| Work identity | `e2e/journeys/work-identity-onboarding.spec.ts` | **hermetic only, opt-in** (`E2E_WORK_IDENTITY=1`); CI job `e2e_work_identity` | A banker joins and returns with the firm's work account (#316): invite, one email, provider, TOTP enrolment, acceptance, sign out and back in, with the wrong account and a suspended banker denied. As Microsoft (`E2E_WORK_IDENTITY_PROVIDER=azure`) it adds guest, no `xms_edov`, foreign-tenant and uninvited refusals and a refresh refused once the binding is gone. |

The suite keeps one worker because the access and invitation journeys share
mutable state. CI's list reporter prints individual test durations alongside
the existing HTML/JSON reports and GitHub annotations. Hermetic CI records
traces and video on the first retry, avoiding recording overhead for tests
that pass on their first attempt. Screenshots still capture the initial
failure; full recordings capture only the retry.
Local runs and live E2E retain their existing recording-on-failure behavior.

Design of record for the second: `docs/superpowers/specs/2026-08-27-invite-onboarding-e2e-design.md`.

A third spec, `e2e/journeys/shell-smoke.spec.ts`, predates both and covers the
shell chrome rather than a journey; it is not documented here.

### Why the step-ownership journey is hermetic-only

Its second identity is a seeded account (`deal-team.intelibank@dev.com`, the
bank's company-role member) whose session is minted from `SEED_PASSWORD`.
Neither the account nor the password is something this suite controls on a
deployed environment, which is the same reason the firm-admin mint is gated. The
journey `test.skip`s itself under `live`, and the member mint in `e2e/auth/setup.ts`
skips with it.

Ownership is read off `resolveDealStepCapabilities` (`src/lib/api/v1/access.ts`):
for an internal user, assignment is the deal MD's alone, completion belongs to
the MD or the assignee, and work may be edited by the MD, the assignee, or
anyone internal while the step is UNASSIGNED. That last clause is deliberate, so
the journey pins it explicitly rather than leaving it to drift: on an unassigned
step the member saves work and is still refused completion, 403 "Not permitted
to complete this step". Every refusal is asserted twice — the disabled control
on screen, and the same act forced through the member's own request context, so
a button that stopped being disabled could never pass for a rule.
### Why the data-room wall journey is hermetic-only

Its second identity is the seeded external counterparty
(`seller.intelibank@dev.com`), minted from `SEED_PASSWORD` like the firm
admin. A deployed environment carries no guaranteed external seat holder, so
the journey `test.skip`s itself under `live` and its session is minted only
for the hermetic tier.

The counterparty's seat is granted through `POST /api/v1/deals/{ref}/members`
rather than the invitation wizard: the subject here is the room wall, and the
invitation ceremony is already driven end to end by the invite journey.
### Why the access journey is hermetic-only

It rewrites a seeded employee's company access (`read-only.intelibank@dev.com`,
COMPANY_ROLE.MEMBER), and on a deployed environment those rows are somebody's
real permissions. The spec captures the employee's roles and direct permissions
before it starts and restores them in a `finally`, so repeated local runs stay
green, but the write itself has no business happening against a live tenant. It
`test.skip`s under `live` for the same reason the invite journey does: skipped,
never failed.

The subject must be neither a director nor the holder of a root permission. Both
are protected company authority, which the product refuses to change
(`protected_access_root`); the drawer says so on screen. The spec asserts this
before it writes anything, so a bad choice of subject fails as a setup error
rather than as a mysterious 409 six steps later.

Two of its assertions cannot be produced by a real browser event under headless
Chromium. `bringToFront()`, `Page.setWebLifecycleState` and a second tab in the
same context all leave `window`'s `focus` and `visibilitychange` unfired, and
the product's live revalidation (`useCurrentUser`) listens on exactly those. The
suite therefore dispatches them itself (`e2e/support/focus.ts`). Only the
environment signal is substituted: the assertions around it, and the
"no reload happened" proof (`e2e/support/navigationWatch.ts` counts main-frame
navigations and expects zero), are unchanged. The Create-leads half needs no
substitute at all: that dialog polls every four seconds on its own.

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
hosted sandbox inbox. The vendor contract itself stays pinned at the payload
level by `tests/invite-email.test.ts`.

The journey is `test.skip`-ed under the `live` project rather than failed.

`invite-rotation.spec.ts` is hermetic-only for the same reason and skips the
same way. It also documents a property of the credential that the resend path's
own comments state too strongly: **a resend does not kill the previously
delivered action link.** Local GoTrue keeps one live one-time token per
identity, so the old link and the new one are both valid until either is
consumed, and consuming one retires the other. What the resend genuinely
rotates is the six-digit challenge — `rotate_invite_credential` bumps
`challenge_version` and clears the verification — so the previously delivered
credential PAIR can no longer accept. That is the property the journey asserts,
and the reason the invitation carries the code in a second email is exactly
this: the link alone was never sufficient.
### Why the route-guard journey mints a third seeded account

`/profile` must show the signed-in person, never the fixture persona. The
seeded MD *is* that persona — `scripts/seed-data.ts` names him Storm Duncan and
seats him on the Atlassian mandate — so asserting "no fixture data on the
profile" against his own account would pass whatever the page rendered. The
journey therefore mints a second seeded banker (`nw-member.intelibank@dev.com`,
on Project Northwind, the one seeded deal the MD holds no seat on) with
`mintSeededSession`, the same helper the `setup` project mints with, reads the
MD's name and mandate target out of `/api/v1/me`, and asserts neither appears on that second person's
profile. The mint lives in the spec rather than the `setup` project: setup's
mints are dependencies of every spec, and this identity is one journey's alone.

That mint is skipped under `live`, for the reason `setup.ts` gives for gating
the firm admin's: the suite controls neither the account's existence nor its
password on a deployed environment, and a mismatch would fail the spec before
a single perimeter assertion ran. A live run therefore stops after the
signed-out guards and the MD's own profile; the second-identity and Logout
steps are hermetic only.

Logout is driven on that second identity for the same reason the invitee gets
its own context: signing out revokes the session behind the storage state, and
the MD's is shared with every other spec in the suite.

### The work-identity journey and its CI job

Contract of record: `docs/03-engineering/work-identity-contract.md` (section 4
for the substitution, section 3 for the rules the cases hold). The spec skips
under `live` and, unless `E2E_WORK_IDENTITY=1`, everywhere else, so
`playwright test --list` collects every case without a stack. Its header lists
the setup: the custom access token hook, the mock issuer
(`node --import tsx e2e/support/mockOidc.ts`, port 56430), the
`work_identity_onboarding` flag, the seeded bank mapped by
`scripts/set-firm-identity-provider.ts`, and the service-role env for the
operator acts that have no UI (suspension, binding removal).

`E2E_WORK_IDENTITY_PROVIDER` picks the provider: `google` (default; the original
journey, through the `keycloak` substitution) or `azure`. Cases for the other
provider skip. The member and uninvited cases are steps of the main
journey test; the guest, no `xms_edov`, foreign-tenant and unbound cases are
azure-only tests of their own. The azure cases:

| Case | Identity the mock issues | Expected |
|---|---|---|
| Member | `acct` 0, `xms_edov` true, the firm's `tid` | invite, TOTP, accept, the deal; sign out and in, the same seats |
| Guest | `acct` 1, `idp` `live.com`, the firm's `tid` | 403 `organization_mismatch` at accept; profile stays invited, no binding |
| No `xms_edov` | `xms_edov` absent | the same refusal, from Conductia's rule alone: GoTrue's Azure parser stores the email as verified (contract C3) |
| Foreign tenant | another `tid` | the same refusal |
| Uninvited | a firm address with no invitation | `/sign-in?error=work_identity_not_connected`, `/api/v1/me` 401 |
| Unbound | the member's binding deleted by the operator, session cookie expired to force a refresh | a control refresh succeeds with the binding, then the next refresh is refused: signed out, `/api/v1/me` 401 |

CI job `e2e_work_identity` (`.github/workflows/ci.yml`, calling
`.github/workflows/e2e-work-identity.yml`) runs it on its own local stack, so the
shared `hermetic` job is untouched. It runs on every push to `develop`, and on a
pull request only when `scripts/ci/work-identity-changed.sh` finds a change to
the work sign-in path (callback, join and two-factor pages, middleware, the
`http*.ts` boundary, `src/lib/auth`, the work-identity migrations,
`supabase/config.toml`, the journey, the mock, the broker suite, and the job's
own workflow and scripts); an uncertain change range runs it, a docs-only pull
request does not. A docs-only push to `develop` still runs it. Like `e2e_gmail` it is advisory: it is not one of `verify`'s workers and
blocks no merge. Whether it becomes a required check is the orchestrator's call.
In order, the workflow patches `supabase/config.toml` in the ephemeral checkout
(`scripts/ci/enable-work-identity-broker.sh`, because `env()` cannot set a
boolean), starts the stack, brings the mock up, runs the broker contract suite
(`tests/integration/work-identity-broker.test.ts`), maps the seeded firm to
azure, then runs this spec under the `hermetic` project. The log names which
provider ran, "azure provider" or "keycloak fallback"; the repository variable
`WORK_IDENTITY_E2E_PROVIDER=keycloak` selects the fallback without a code
change. The azure pgTAP cases (`supabase/tests/work_identity_onboarding.sql`) run
in the database test suite, not in this job.

Spike outcome, first CI run (39064775122, CLI GoTrue `v2.196.0`): the real
`azure` provider runs against the mock issuer (the log reads "Journey provider:
azure provider"; GoTrue clears the expected issuer for a non-Microsoft host), so
the keycloak fallback is not needed. Its token parsing is a different matter:
GoTrue applies its Azure parser only to a Microsoft issuer, so against the mock
it used the generic OIDC parser and stored the member with no `tid`, `acct` or
`email_verified` (run 39087361279: accept answered 403 `organization_mismatch`,
and the refusal cases passed only because everything was refused). The mock now
states the Azure-parsed `custom_claims` and `email_verified` in its token (#586),
and the spec waits for navigations to commit rather than load.

**Coverage status: green.** `e2e_work_identity` passed end to end on #587 in run
39088341993 (real `azure` provider, GoTrue `v2.196.0`): the member journey, the
guest, no-`xms_edov` and foreign-tenant refusals, and the refresh refused once
the binding is gone, all on the first attempt. What it proves stops at GoTrue's
token parsing, which the mock states for it (above); a real Entra token is the
dev proof's to show (contract HQ2).

### The three identities

- **Storm Duncan (MD):** registers the lead, opens the mandate, reads the
  roster at the end. Storage state from the setup project.
- **The firm admin:** sends the external director's invitation, and only that.
  A company's FIRST director invitation is a company-management act, so
  `POST /api/v1/invites` requires `firm_role = 'admin'` or a directorship of
  the target company. Storm directs the bank, not the freshly registered lead,
  so the product refuses him and says so on screen. Storage state from the
  setup project.
- **The invitee:** a context with **no** storage state. Their session comes
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
`RESEND_FROM` are set for you in `playwright.config.ts`'s `webServer` env, which
also pins `NEXT_PUBLIC_APP_ENV=dev` — the signal that keeps the sender fallback
and the request-origin fallback available. Both fail closed outside dev.

Two prerequisites live in `supabase/config.toml`, and both need a stack
restart to take effect. First, `additional_redirect_urls` widened to allow
both loopback spellings: without it, the invite link falls back to `site_url`
and strands the invitee on the picker. Second, `[auth.mfa.totp]`'s
`enroll_enabled` and `verify_enabled` turned on: the local GoTrue ships both
off by default, and with them off enrollment 422s, so the journey's mandatory
MFA step cannot pass at all.

The hermetic base URL is `http://localhost:3000`, not `127.0.0.1`. The app
derives the invite link's redirect origin from `NEXT_PUBLIC_APP_URL` when it is
set (`src/lib/api/v1/publicOrigin.ts`); the hermetic `webServer` pins it to `''`
so the tier keeps falling back to `new URL(request.url).origin`, which under
`next start` reports
`localhost:3000` regardless of the request's Host header. Browser cookies are
origin-scoped, so an invitee whose session was established against one
spelling cannot present it to the other. Every origin in the journey, the
app's self-reported origin, the test's `baseURL`, the storage-state cookie
domain, and the action link — are all aligned on `localhost` as a result.

### Teardown

A `cleanup` teardown project recycles the run's invitations and identities
using the same delete-and-tombstone routine as `npm run demo:reset-invitee`
(`scripts/lib/recycleInvitee.ts`). It runs **only when the journey passed**:
the spec writes `e2e/auth/.state/invite-teardown.json` after its last assertion,
and the teardown is a no-op without it. The manifest-writing helper lives in
`e2e/support/teardownManifest.ts`, not in the spec file: Playwright attributes
every `test()` call made while a file is loading to the file being loaded, so a
teardown that imported the spec would register the whole invite journey inside
the `cleanup` project and run it a second time. A failing run is exactly when
the rows matter: the trace refers to them, and reading the invite row is often
how the failure is diagnosed.

Identities are tombstoned rather than deleted because `audit_log.actor_id`
references `users` and the audit log is immutable evidence. This means a
passing run does NOT leave no auth identities behind: `auth.users` and
`public.users` each accumulate one suspended `<local>+used-<timestamp>@…` row
per green run, because the row that produced the invitee's audit trail can be
renamed and suspended but never deleted. The code is correct; do not read
"recycles" above as "removes". These rows are otherwise harmless — the
tombstoned address can never receive a fresh invite — but they do accumulate
across repeated local runs, and the only thing that clears them is
`supabase db reset --local`, which wipes the whole local database.

### Why the Book journey is hermetic-only

Its second identity is a SEEDED account (`legal.intelibank@dev.com`, a bank
member holding no MD seat), minted by the setup project the same way the firm
admin's is. A deployed environment guarantees neither that the account exists
nor that its password is `SEED_PASSWORD`, so the journey `test.skip`s itself
under `live` rather than fail on somebody else's data. The MD half would run
anywhere; splitting the file to buy that would trade one end-to-end proof for
a partial one.

The journey also carries the Book's MD-only rule, which the product states in
words only at the API: no editor renders for a member, and
`PATCH /api/v1/deals/{ref}` answers 403 "Only the deal MD can set the Book
fields". The step asserts both, the second through the member's own request
context.

Journey specs are project-agnostic: the same file runs under both (both
`playwright.config.ts` projects point at `testDir: e2e/journeys`, `testMatch:
/.*\.spec\.ts$/`).

**No test that depends on a third-party service may block a merge.** An outage,
a rate limit, or a rotated credential on someone else's system carries no
information about the change under review. `e2e-live.yml` has no `pull_request`
trigger and runs `continue-on-error: true`; its output is a list, not a verdict. A failing run opens or comments on a tracking issue instead of failing CI.

**When the live tier runs.** Three triggers, none of them `pull_request`:
`workflow_dispatch` on demand, `push` to `develop`, and a 06:00 UTC nightly
`schedule`. The push trigger is post-merge, so it still gates nothing, but it
pins a break to a single merge commit — the nightly alone cannot say which of a
day's merges broke it. Runs are serialized (`concurrency: e2e-live`,
`cancel-in-progress: false`) because the live environment is shared mutable
state; cancelling would also discard the coverage for the merge being
attributed. GitHub fires `schedule` only from the repository default branch
(`main`), so main's copy of the workflow runs the nightly; its checkout pins the
nightly to `develop`. A change to the nightly takes effect once a release
carries it to `main`.

**Reading a hermetic failure.** The job posts the failing spec names, their
`file:line`, and the head of each error as a sticky comment on the pull request
(and to the run's step summary), so the first read costs no download. The
comment is keyed on a hidden `<!-- e2e-hermetic -->` marker, so a re-run edits
it rather than stacking. Both reporting steps are `continue-on-error`: they
describe a failure and must never cause one. Screenshots and traces cannot be
inlined — GitHub markdown cannot render an image or play a video out of an
artifact zip, whose URLs require auth — so they stay in the
`e2e-hermetic-report` artifact, and the comment prints the exact commands to
open them:

```
gh run download <run-id> -n e2e-hermetic-report -D ci-report
npx playwright show-report ci-report/playwright-report
```

Hermetic CI keeps screenshots of failed attempts under `test-results/<spec>/`
and captures **video** (`video.webm`) and a trace on the first retry. A passing
retry also retains those recordings locally, but the existing failure-only
upload step does not upload them for an ultimately green job. Local and live
runs use `retain-on-failure`, recording each attempt and deleting passing
recordings. The video plays anywhere; the trace needs the viewer but adds DOM
snapshots, network, and console.

**Where results surface.** The Actions run shows a green check even on failure
(`continue-on-error`), so it is not eyeballable for breakage: read the open
tracking issue `E2E (live) is failing`, which names the trigger and commit, and
the `e2e-live-report` artifact (14-day retention). Slack alerting is tracked in
issue #12.

**CI jobs are per tier, never per journey.** Adding a journey means adding a
spec file, not editing a workflow. When the suite outgrows its timeout, scale it
with a shard matrix (`--shard=${{ matrix.shard }}/N`).

## Authentication

Specs do not drive `/sign-in`. The `setup` project (`e2e/auth/setup.ts`) mints
a Supabase session for the seeded MD account (`md.intelibank@dev.com`) via
`signInWithPassword` and writes the resulting cookies to `e2e/auth/.state/md.json`
(`e2e/auth/session.ts`); journey specs start already inside the shell, with that
file as their `storageState`. The auth boundary is covered at the unit tier
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
attribute `[data-compliance-status]` (`e2e/support/selectors.ts`,
`expectSingleComplianceInstrument`). It is mounted exactly once by invariant,
that invariant is the thing worth testing, and the attribute is already the
sanctioned hook for it. Every `verify()` calls this helper, so the invariant is
checked continuously rather than once. The floating command console is scoped
to project routes, so the expected count is 1 on `/projects/[id]/...` and 0
elsewhere.

## The step model

Steps are modules under `e2e/steps/`, not page objects: a page object organizes
by screen, but the subject under test is a journey, and the same screen means
different things at different points in it.

Each step (typed by `e2e/steps/types.ts`) exports `act` (drive the UI),
`assertUi` (the visible outcome), and `verify` (the durable consequence, read
through `/api/v1`). A journey is an ordered list of steps; the runner
(`e2e/journeys/md-spine.spec.ts`) runs each step's `act`, then `assertUi`, then
`verify` in `test.step()` blocks, so a failure reports the earliest true cause
rather than a cascade.

Every step asserts a visible outcome **and** a durable consequence. Compliance
is this product's stated moat; a journey that clicks through without checking
the audit trail proves the wrong thing.

The shipped MD spine (`e2e/journeys/md-spine.spec.ts`) is seven steps, in order:

1. `registerLead`: creates the lead.
2. `createDeal`: the lead becomes a mandate.
3. `openRail`: opens `/projects/[dealCode]/rail`, the surface backed by
   `/api/v1/deals/[ref]/steps` and the persisted rail cursor. (`/deal-folder`
   is a separate fixture explorer over the internal manifest, not the rail.)
4. `assertSkillsDegraded`: asserts the honest degraded state when Ignatious
   is unconfigured (hermetic tier).
5. `uploadToDataRoom`: uploads a document to the Box-backed data room.
6. `composeAndSendMail`: drives the compliance email client end to end.
7. `advanceRail`: moves the rail cursor forward.

## Evidence

The `evidence` fixture (`e2e/support/fixtures.ts`, `e2e/support/evidence.ts`)
is an `APIRequestContext` built from the same storage state as the browser
context, so handlers authenticate it through the normal `requireApiUser` path.
Reading back with the service key would prove a row exists; reading back as the
MD proves the row exists **and** is visible to the identity that created it,
which exercises `src/lib/api/v1/access.ts` as a side effect.

Audit assertions go through `evidence.expectAudit(ref, { action, actorId,
since })`. The `since` bound is the run's start timestamp, so a shared database
carrying other people's rows cannot produce a false positive.

## Data

Journeys create their own entities under a run-unique name (`E2E Lead {runId}`,
`Project E2E {runId}`, minted by `e2e/support/runId.ts`) on top of the seeded
tenant. Seeded fixtures are read-only backdrop. The hermetic tier resets the
database per run and would not strictly need it; the live tier runs against a
shared database somebody may be demonstrating on, and the journey code is
shared between tiers, so `runId` is always on.

## Known gaps

Recorded honestly rather than patched over, because the suite's job is to make
gaps visible, not absorb them.

- **No close transition.** `deals.status` carries a `'closed'` value in the
  schema, but no route handler writes it: `/api/v1/deals/[dealId]` is GET-only.
  There is no way for the MD to close a deal through the product today. The
  spine marks this `test.fixme()`:

  ```ts
  test.fixme('#TODO(issue) — the MD closes the deal and the transition is audited', async () => {});
  ```

  Replace `#TODO(issue)` with a real issue number once one is filed.

- **The compliance receipt is unreachable after send.** `MailComposer` sets its
  "Screened and delivered to the provider." receipt and calls `onSent` in the
  same continuation where `MailClient` switches to the Sent folder and empties
  the composer view, so that banner never has a chance to render. The Sent
  list also shows no verdict indicator for a compliant message. `composeAndSendMail`
  therefore asserts the Sent-folder row as its visible outcome
  (`assertUi`) and asserts the verdict durably through `/api/v1/outbox` in
  `verify()`. This is a product/spec gap, not a test shortcut, and it is not
  yet filed as an issue.

- **The leads directory is still one capped page.** `GET /api/v1/companies`
  with no `query` returns the newest 200 rows in the tenant; `LeadList` and the
  Gate 0 lead catalog filter that page client-side. The audit-scoping journey
  exposed the ordering half of this (a name-ordered typeahead-sized page hid
  just-registered leads) and that half is fixed, but the ceiling is only moved:
  past 200 client companies the oldest leads leave both surfaces again. The
  real fix is server-side filtering for the directory surfaces, which is a
  product decision, not a test change.

- **Journey-created `companies` rows are never recycled.** Teardown covers
  invitations and identities only. Each MD-spine run leaves one `E2E Lead
  {runId}` row and each audit-scoping run leaves two, and the live tier is
  shared and never reset, so those rows accumulate there and count against the
  200-row directory page above. Only `supabase db reset --local` clears them
  locally; on the live tier nothing does.

- **The empty audit register is unreachable.** `AuditTrail` renders "No
  activity yet. Actions you take across the deal are recorded here." when the
  merged register is empty, but Gate 0 writes the `create` audit row before the
  trail can be opened, so every deal the MD creates already has an event. The
  audit-scoping journey marks this `test.fixme()` rather than reaching for a
  seeded deal whose emptiness nothing guarantees.

- **`/steps` does not cover every rail position.** `GET
  /api/v1/deals/{ref}/steps` returns only the five dataroom-linked steps, so
  there is no API answer for "what step is this deal on, by title" for most of
  the rail. `openRail` works around this by reading the canonical `seq` off
  `GET /api/v1/deals/{ref}` and translating it to a title with `stepBySeq`
  (`src/lib/rail/dealRail.ts`), the same rail census the client renders from,
  rather than hardcoding a title.

### What a skip does not leave behind

`SkipModal` writes the approver and the reason to the browser (the rail run
state and the local audit log). The only row the platform records is the cursor
`advance`, so no `/api/v1` read — by the MD, the CCO, or the next banker on the
deal — can answer who approved a skip or why. `skipStepAtCursor` asserts the
approver and reason visibly and the cursor move durably; the missing server
record is a `test.fixme()` in the journey rather than an assertion softened to
match a browser cache.

## When a step is not yet wired

Use `test.fixme()` carrying the issue number. Never weaken the assertion. The
suite's job is to make the gap visible, not to absorb it.

## Running it

```bash
# Hermetic, against a local Supabase stack.
supabase start && supabase db reset --local
eval "$(npx --yes supabase@2.114.0 status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
export SEED_PASSWORD='e2e-local-password'
export NEXT_PUBLIC_APP_ENV=dev
export INVITE_VERIFICATION_PEPPER='e2e-local-pepper'

# Do NOT use `npm run seed:flags` / `npm run seed:users` here: both scripts
# run under `node --env-file=.env.local`, which hard-fails if `.env.local` is
# missing and, when present, loads a developer's REMOTE Supabase project,
# silently seeding the wrong database. Invoke the scripts directly instead, so
# only the local-stack env exported above is in effect:
node --import tsx scripts/seed-flags.ts
node --import tsx scripts/enable-flags.ts
node --import tsx scripts/seed-users.ts
node --import tsx scripts/seed-discovery.ts --corpus demo
# The owner's recording when it exists, else the labelled stub (see the demo runbook).
REPLIES=tests/fixtures/discovery/demo/model-replies/extract.v1.json
[ -f "$REPLIES" ] || REPLIES=tests/fixtures/discovery/demo/model-replies/extract.v1.stub.json
node --import tsx worker/extract.ts --once --strict --replies "$REPLIES"

# Runs the `hermetic` project, then `hermetic-discovery-demo` (the deal-discovery
# demo journey, which mutates discovery state, so a second run needs a reset stack).
npm run test:e2e

# Runs `hermetic-discovery-demo-gmail` (the same journey on the Gmail replay; its own
# reset stack, seeded with --google-replay --corpus demo --phase seeded).
# playwright.config.ts refuses a non-loopback Supabase URL: export the local stack's env first
# (eval "$(supabase status -o env)" and the exports above). A shell that still holds a hosted
# NEXT_PUBLIC_SUPABASE_URL fails at config load.
npm run test:e2e:discovery-gmail

# Live, against a deployed environment.
E2E_BASE_URL=https://... npm run test:e2e:live
```

Two operational traps that have actually bitten a run:

- **A stray `next dev` on port 3000.** `playwright.config.ts` sets
  `reuseExistingServer: !process.env.CI`, so locally, if something is already
  listening on port 3000, Playwright reuses it instead of booting its own
  build, silently running the suite against whatever database that other
  process was pointed at. Confirm port 3000 is free (`lsof -i :3000`) before
  running, and kill any stray `next dev`.
- **`scripts/enable-flags.ts` refuses a non-loopback Supabase URL.** It only
  force-enables flags against `localhost`/`127.0.0.1` by default, and throws
  otherwise. Set `E2E_ALLOW_REMOTE_FLAGS=1` only when deliberately targeting a
  remote project outside the local hermetic flow described here.

## Adding a journey

Add a spec file under `e2e/journeys/`, reusing the step modules. Reuse across
journeys is the point: the deferred multi-identity onboarding journey reuses
`uploadToDataRoom` verbatim under a different storage state. No change to
`playwright.config.ts` and no change to either workflow: both already glob
`e2e/journeys/**/*.spec.ts` by `testDir` + `testMatch`.
