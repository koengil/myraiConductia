# Phase 1 API (`/api/v1`) — the auth, deals & audit spine

> Shipped 2026-06-05 (ADR-0008). This is the first **product-shaped** backend slice.
> It lives **beside** the `ConductiaAPI` product seam (D8), not inside it: the seam
> is the M&A *content* contract (sellers, acquirers, skills, scoring); this REST
> surface is the *platform* contract (identity, deals, memberships, documents, audit).

For the why, see [`../07-decisions/ADR-0008-phase1-auth-deals-audit-spine.md`](../07-decisions/ADR-0008-phase1-auth-deals-audit-spine.md).
For the full data model, see [`./permissions_schema_v3-full.md`](./permissions_schema_v3-full.md).

---

## Authentication

Every protected `/api/v1` handler self-authenticates via `requireApiUser()`
(`src/lib/api/v1/http.ts`):

1. Reads the Supabase **server** client session (`getUser()`). No session → JSON `401`.
2. Requires Supabase authenticator assurance level 2 by default. A password-only
   session receives JSON `403 mfa_required` and completes TOTP verification at
   `/two-factor`.
3. On success, returns the **admin** (secret-key) client for DB access. If the
   service key is unconfigured → `503`.

`/api/v1` is intentionally **excluded from the middleware auth matcher** — the
browser is redirected to `/sign-in` for app routes, but API routes answer with
JSON `401` so programmatic callers get a status, not a redirect.

Identity comes from Supabase Auth. `public.users` mirrors `auth.users` via the
`handle_new_auth_user` `security definer` trigger (Option A: `users.id =
auth.users.id`), so a `users` row exists for every signed-in user and RLS can key
on `auth.uid()`.

Invite context, recipient verification, and invite acceptance are the only user
API paths that allow an AAL1 session, because a contained invitee must complete
those steps before platform access. The OpenAPI document (dev-only, see [Visibility](#visibility)) and the
independently secret-authenticated inbound webhook need no user session; the role
catalogue does (`requireApiUser()`). MFA enforcement is platform-wide and is not controlled by the
`platform_onboarding` feature flag.

## Authorization (app-layer, RLS to follow)

Row authorization is enforced by explicit predicates in
`src/lib/api/v1/access.ts` — the **belt** — with deal-scoped RLS policies as the
**suspenders** (ADR-0016, `20260928120000_rls_deal_scoped_policies.sql`, #78, #79):

| Helper | Rule |
|---|---|
| `userCanAccessDeal` | `cco`/`admin` firm-roles → any deal in tenant; otherwise must have a `deal_memberships` row. |
| `userIsDealMd` | `admin` → always; otherwise the membership `deal_role` must be `md`. |
| `listDealsForUser` | `cco`/`admin` → all tenant deals; otherwise only the caller's member deals. |
| `userCanViewCompany` | `cco`/`admin`, or a user who belongs to the company → may read its roster. |
| `canManageCompanyMembers` | Same-tenant firm admin, or a director of that company → may manage members and mutate `preferredDealRole`; external and research/trading targets cannot receive that preference. |
| `userCanSearchCompanies` | `cco`/`admin`, or internal non-walled staff → may search the company directory. Blocks external users and `research`/`trading` (Chinese wall). |

RLS is **enabled** on these tables with read policies (`20260612150000_rls_read_policies.sql`), deal-scoped for overseers since `20260928120000_rls_deal_scoped_policies.sql` (ADR-0016); service_role bypasses them for seeds and the server admin client. Discovery handlers rely on RLS directly through `requireApiUserScoped()`.

**A deal the caller cannot see does not exist (D65).** When `userCanAccessDeal`
fails, every `/deals/{dealId}/**` handler (and `GET /ai-spend?dealId=`) answers
with `dealNotVisible()` from `src/lib/api/v1/dealNotVisible.ts`: the same `404
{"error":"Deal not found"}` as a code that resolves to nothing, with the same
headers. Deal codes are guessable, so a `403` there would confirm that the deal
exists. Handlers whose first gate is an authority check (MD, member manager,
relationship manager) use `forbiddenOrNotVisible()`, so their `403` reaches only
callers who can already see the deal. Seated callers keep their role `403`s.
The skill-authoring routes answer their own `404 {"error":"Deal not found."}`
and still audit the refusal. Only response time differs between the two cases.

**The same holds where the deal comes in the body or query string (D95,
Proposed).** The invite routes (`POST`/`GET /invites`, `preflight`,
`perimeter-preview`, `lookup`) run one gate, `inviteDealHidden()`, right after
the deal resolves and before anything else: a caller who can see the deal, or
whom `userCanInviteChecked` admits on it (a party company's external director, a
director of the deal's bank, neither of whom needs a seat), goes on; anyone else
gets `dealNotVisible()`, and a failed authority read is `503`. `POST
/rail-templates` answers a source deal the caller cannot see with the family's
own missing answer, `404` with `code: not_found`. The template-change routes check
access before the internal wall, so an unseated caller, internal or external,
gets `Deal not found`, not a `403` or the wall's `Not found`.

**Mail resolves deal-shaped references strictly, and slugs stay untagged
(D95).** `POST`/`GET /outbox` and `GET /inbox` take the project segment, which is
a deal code or a sandbox slug. `resolveDealRefLenient` looks up every reference
(a UUID by id, anything else by its upper-cased code). A deal the caller can see
is tagged and filtered as before. A deal the caller cannot see answers exactly
like a miss of the same shape. A UUID or `PREFIX-YYYY-NNN` reference that matches
nothing or names a hidden deal: `POST /outbox` answers
`404 {"error":"Deal not found"}`, `GET /outbox` returns an empty list and
`GET /inbox` shows untagged mail only. Any other reference that matches nothing
or names a hidden deal (`project-summit`, a legacy code) is a sandbox slug: the
send goes out untagged and the reads apply no deal filter. A lookup error
answers `500`, never an unfiltered read.

**Amendment to D95 (D95-A1, Proposed).** `POST /rail-templates` checks access
before it reads anything else about the source deal: an unseated caller gets
the `not_found` answer even when the deal's `bank_id` read would fail, and the
`forbidden` for a failed or malformed read reaches seated callers only. The
visibility census (`tests/api-v1-deal-not-visible.test.ts`) now also finds routes
outside `deals/[dealId]` by the deal parameter they take (`dealId`, `dealCode`,
`sourceDealId`, `get('deal')`), so `POST /people/search`, the four discovery deal
routes and `POST /screen` have oracle rows; a deal read from `deal_id` or
`body.deal` still escapes it.

**A skip approver is checked twice (D112, Proposed).** `PATCH
/deals/{dealId}/steps/{stepId}` with `skip` and `POST
/deals/{dealId}/rail/steps/{stepId}/skip` verify the approver in the route
(`resolveSkipApprover`), then the database verifies it again
(`rail_skip_approver`) under row locks, and also requires the approver's user
row to be in the deal's tenant. A seat or user lost between the two
answers the same `400 The approver must hold an active, eligible seat on this
deal`; any other `42501` is a `500`. A skip Postgres aborts to break a deadlock
(`40P01`) answers a retryable `409` with `code: "skip_retry"` and `Retry-After: 1`.
Both paths record the same skip.

---

## Endpoints

Base URL: `/api/v1`. All bodies are JSON.

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| GET | `/me` | session | Signed-in profile + memberships + primary mandate. Provisions a `users` row from the auth email when the mirror is missing. | #30 |
| PATCH | `/me` | session | Update the caller's `fullName` and/or `displayName` | — |
| GET | `/roles` | session | Role catalogue (slugs + permission lists) | — |
| GET | `/companies` | internal non-walled / CCO / admin | In-tenant company list (Gate 0 target typeahead); `?type=` (any free-text key, such as `?query=` or `?name=`, is refused with 400; see below) | #73 |
| POST | `/companies` | internal non-walled / CCO / admin | Register a lead by name (default type `client`); same Chinese-wall gate as GET so a walled/external caller can't probe existence via 201/409 | #73 |
| POST | `/companies/onboard` | firm admin | Bootstrap a company and send its first director invite (see Onboarding below). **Onboarding a `bank` mints a new tenant for it** (D54, #158); every other type stays in the caller's tenant. | #156 |
| GET | `/companies/{companyId}/members` | company member / CCO / admin | Internal roster with `preferred_deal_role` and `is_walled`; `?includeWalled=true` includes research/trading only for protected roots or actors with `company:directory:view_all`, while external users are always excluded | #73 #160 |
| POST | `/companies/{companyId}/members` | company director / admin | Add/re-role a company member; rejects director promotion of a research/trading user | #160 |
| PATCH | `/companies/{companyId}/members/{userId}` | company director / admin | Change exactly one of deprecated `canInvite` or flag-on `preferredDealRole`; with company access enabled, `canInvite` changes only the direct invite grant in the member-access transaction | #160 |
| GET | `/companies/{companyId}/roles` | company role/access manager | Permission catalogue, active custom roles, assignment counts, versions, and viewer permissions | #160 |
| POST | `/companies/{companyId}/roles` | company role manager | Create a custom role within the actor's grant envelope | #160 |
| PATCH | `/companies/{companyId}/roles/{roleId}` | company role manager | Replace role metadata and permissions with optimistic concurrency | #160 |
| DELETE | `/companies/{companyId}/roles/{roleId}` | company role manager | Archive an unassigned role with optimistic concurrency | #160 |
| GET | `/companies/{companyId}/members/{userId}/access` | self / company access manager | Source-aware assigned roles, direct grants, effective permissions, and access version | #160 |
| PATCH | `/companies/{companyId}/members/{userId}/access` | company access manager | Atomically replace exact role and direct-grant sets within the actor's grant envelope | #160 |
| GET | `/companies/{companyId}/relationships` | internal non-walled / CCO / admin | List a lead's CRM relationships, newest first | — |
| POST | `/companies/{companyId}/relationships` | internal non-walled / CCO / admin | Add a lead CRM relationship; enum fields default to their first option when omitted | — |
| DELETE | `/companies/{companyId}/relationships/{entryId}` | internal non-walled / CCO / admin | Remove a lead CRM relationship | — |
| GET | `/companies/{companyId}/stakeholders` | internal non-walled / CCO / admin | List a lead's CRM stakeholders, newest first | — |
| POST | `/companies/{companyId}/stakeholders` | internal non-walled / CCO / admin | Add a lead CRM stakeholder; enum fields default to their first option when omitted | — |
| DELETE | `/companies/{companyId}/stakeholders/{entryId}` | internal non-walled / CCO / admin | Remove a lead CRM stakeholder | — |
| GET | `/notifications` | session | The caller's notifications, newest first; `?unread=1` | #74 |
| PATCH | `/notifications/{notificationId}` | recipient | Mark read/unread (`read_at`) | #74 |
| GET | `/deals` | session | Deals the caller can access | #23 |
| POST | `/deals` | session | **Gate 0 create** via `create_deal_gate0` RPC: target dedupe, deal (retry-minted code), MD + member seats, conflicts attestation, CCO notify, audit. Server-side mask check + MNPI screen. With `railTemplate` and a UUID `requestId` (flag `rail_templates`), creates an independent deal from a saved rail instead. | #23 #71 #72 |
| GET | `/deals/template-creations/{requestId}` | `rail_templates`, `project_rail_model`, `gate0_api_create`; the creating actor | Read a mandate being created from a saved rail, so the wizard can offer to resume it | #231 |
| POST | `/deals/template-creations/{requestId}` | `rail_templates`, `project_rail_model`, `gate0_api_create`; the creating actor | Resume that creation with no body; replays the stored receipt once it has committed | #231 |
| GET | `/deals/{dealId}` | member/CCO/admin | Deal + parties + members (`targetCloseDate`, `feeUsd`, `scheduleStatus`, `lifecycleCategory` included) | — |
| PATCH | `/deals/{dealId}` | deal MD / admin | Set or withdraw (`null`) any subset of the Book fields `targetCloseDate`, `feeUsd`, `scheduleStatus`, `lifecycleCategory` (graduation 1-4; the category is never null); one audit `update` `{ field, from, to }` per field | #191 |
| GET | `/deals/{dealId}/audit` | member/CCO/admin | The deal's `audit_log` rows, newest first (≤500), actor names embedded | — |
| PATCH | `/deals/{dealId}/progress` | deal member (regress: deal MD) | Persist the rail cursor (`deals.current_step_seq`) so an advance survives reload; moving it earlier is MD-gated; audited as `advance` with from/to seq; segment is the deal code or UUID | — |
| GET | `/rail-templates` | `rail_templates`, `project_rail_model`, `gate0_api_create`; `company:deals:create` (`?purpose=save`: `company:rails:templates:manage`) | The caller's company saved rails: name, description, step and skill counts; with `?purpose=save`, only the catalog templates a save can replace | #231 |
| GET | `/rail-templates/{templateId}` | `rail_templates`, `project_rail_model`, `gate0_api_create`; `company:deals:create` | Preview a saved rail's current revision: step titles in phase order | #231 |
| GET | `/ai-spend` | internal (research/trading walled) | AI spend from the `ai_usage` ledger by deal, person, task and model; `?dealId=` scopes to a deal, without it answers tenant-wide to CCO, admin and bank directors only (other internal users get 403, matching the AI Costs page); `window.truncated` past the newest 2,000 rows. Writers: the compliance screen, code-name suggestions, lead presearch, Ignatious agent runs and, since #155, every skill-bench chat turn that finishes (`source: bench_chat`; cost and model are read server-side off the bench stream, so a turn is recorded even if the browser disconnects; a turn the bench could not price is kept as an unpriced call) | #109 #155 |
| POST | `/deals/{dealId}/members` | deal MD / admin | Grant membership by email + role; audit `grant` | #24 |
| PATCH | `/deals/{dealId}/members/{userId}` | deal MD / admin | Delegate member management (`canManageMembers`) and, flag-on, raise a member's disclosure `phase` (monotonic, idempotent; audit `grant`) | — |
| GET | `/deals/{dealId}/documents` | member/CCO/admin | List deal documents. Flag-on: room-aware, wall-filtered to what the viewer may see | #33 |
| POST | `/deals/{dealId}/documents` | flag-on; uploader per room rules | Multipart upload through the storage seam (`file`, `room`, `classification`, `minPhase`, `name`); audit `upload`; `502` when storage is down | — |
| GET | `/deals/{dealId}/documents/{documentId}/download` | flag-on; wall-checked | Stream the file; audit `download`; walled rows `404` identically to missing ones | — |
| POST | `/deals/{dealId}/documents/{documentId}/view` | member/CCO/admin | Record an `audit_log(view)` event. Flag-on: wall-checked first (walled rows `404`) | #25 |
| POST | `/invites/preflight` | inviter per `userCanInvite` | Classify the exact recipient and company context; return a bound confirmation identifier when the trusted domain does not match. A company with no verified domain classifies every address `unverified` (#157) | — |
| POST | `/invites/perimeter-preview` | inviter | What the invitee will see: destinations (titled from `DESTINATION_TITLES`, #154), rooms, phase | — |
| POST | `/invites/lookup` | inviter per `userCanInvite` | Propose a least-privilege seat; for a disclosable colleague in the matched bank company, use their preferred deal role with reason `employee_default` | #160 |
| POST | `/invites` | inviter per `userCanInvite` | Recheck the company-domain decision, create an invitation, and send the recipient a contextual invitation email identifying the inviter from server-resolved account data, plus a separate verification-code email | — |
| GET | `/invites` | invite manager | List invites for `?dealId=` or `?companyId=` | — |
| POST | `/invites/{inviteId}/resend` | invite manager | Rotate the link and recipient-code version, clear unaccepted verification, and resend both recipient emails | — |
| DELETE | `/invites/{inviteId}` | invite manager | Revoke a pending invite; audit `invite_revoked` | — |
| GET | `/invites/context` | invited AAL1 session | Return generic state before recipient verification and scoped inviter/company/deal/role context only afterward | — |
| POST | `/invites/verify` | invited AAL1 session | Verify the current six-digit out-of-band code without granting membership; five failed attempts lock the challenge | — |
| POST | `/invites/accept` | verified invited AAL1 session | Explicitly accept through the session-bound RPC; activate the user and atomically grant company membership and optional phase-0 deal seat | — |
| POST | `/auth/mfa/complete` | AAL2 session | Audit a completed Supabase TOTP enrollment or challenge without recording factor identifiers or secrets | — |
| POST | `/screen` | session | Pre-send compliance screen: `mode` `fast` (deterministic, as-you-type, not audited) or `full` (deterministic + LLM escalation behind the model gate, audited as `screen` with a sha256 of the text and the gate's `modelDecision`; see "Model gate for the screen and code-name calls") | — |
| POST | `/outbox` | session | Send an email through the screened channel: `full` screen first; compliant → provider send + audit `send`; hold → supervisory queue; blocked → refused with rewrite. Full message stored in `outbound_messages` (17a-4 record) | — |
| GET | `/outbox` | session (CCO/admin: tenant-wide) | The caller's outbox; `?status=held` is the supervisory review queue | — |
| PATCH | `/outbox/{messageId}` | CCO/admin — never the message's own sender (four-eyes, #165) | Review a held message: `release` (reviewer sends it; audit `release`+`send`) or `reject` (status `rejected` + note; audit `reject`) | — |
| POST | `/inbound/webhook` | shared secret (`x-inbound-secret`) + `?tenant=` | Provider inbound delivery → `inbound_messages` (attachment bytes dropped, metadata kept) | — |
| GET | `/inbox` | bank-side (no external, walls apply) | Received mail, newest first | — |
| PATCH | `/inbox/{messageId}` | bank-side | Mark read/unread | — |
| GET | `/mailbox` | session | Mailbox connection status (`configured`/`connected`/email) | — |
| GET | `/mailbox/connect` | session | 302 to the Microsoft consent page (OAuth; CSRF state cookie) | — |
| GET | `/mailbox/callback` | session | OAuth return: tokens stored encrypted (AES-256-GCM), redirect back | — |
| DELETE | `/mailbox` | session | Disconnect the mailbox | — |
| GET | `/setup` | session / `setup_walkthroughs` | Connection readiness plus the caller's role-aware, versioned walkthroughs | #125 |
| PATCH | `/setup/walkthroughs/{track}` | session / eligible track / `setup_walkthroughs` | Replace the caller's exact completed-step set with optimistic concurrency; final completion is immutable and audited | #125 |
| GET | `/openapi.json` | none; dev-only (`devApiEnabled()`, else 404) | The OpenAPI 3.1 spec, non-normative (served from `openapi/phase1.json`; see [Visibility](#visibility)) | — |
| POST | `/mail-warning-outcomes` | session, `mail_channel` | Anonymous count of emails sent after a send-time email warning (the Risk Patcher or the recipient review, not the advisory shown while typing; a discarded draft is never recorded, D80): body `{outcomes: [{kind, outcome}]}` with `kind` `risk_issues` \| `recipient_review` and `outcome` `sent_after_warning` (anything else, `abandoned` included, is refused with 400; the table's CHECK allows only `sent_after_warning` since `20261008200000`), at most 2 entries. Adds one to `mail_warning_outcomes` per tenant, UTC day, kind and outcome; no person, deal or content is recorded. Sent by the composer when the email goes out; answers 204 | — |
| GET | `/deals/{dealId}/rail/template-changes` | `template_change_review`; internal deal member / CCO / admin (external: `404`) | The deal's changes against its template's current published version: added and removed steps, each with its decision: `accepted` when decided at that version, `discarded` for a discard from any version whose change still applies, otherwise `null` (pending); `{ changeSet: null }` when there is nothing to compare | — |
| POST | `/deals/{dealId}/rail/template-changes/{changeId}/decision` | `template_change_review`; structure authority (external: `404`) | Body `{ decision: 'accepted' \| 'discarded', revisionId }`, where `revisionId` is the template version the banker reviewed (`400` without it); an accepted change restores, inserts or removes the step through the rail functions; audited `update` `{ rail: 'template_change', ... }`; returns `{ changeSet }`; `409` when the change is no longer offered or `revisionId` is no longer the current version | — |
| DELETE | `/deals/{dealId}/rail/template-changes/{changeId}/decision` | `template_change_review`; structure authority (external: `404`) | Reopens a discarded or kept change; `409` for any other; returns `{ changeSet }` | — |
| POST | `/rail-catalog/{templateId}/publish` | `company:rails:templates:manage`; `skill_authoring` when the draft holds skills | Publishes the catalog draft as the next numbered version. With skills it first retains each one in Ignatious under the new revision id, then commits in one transaction that refuses a receipt that does not match the draft; `409` for nothing to publish, a taken name, a missing protected step, a draft that changed meanwhile, skills not enabled, or a skill that is no longer available; `503` when the skill service does not answer; `502` when it answers with something Conductia cannot use | ADR-0024 |
| POST | `/rail-templates` | `rail_templates`, `project_rail_model`, `gate0_api_create`; internal deal member with `company:rails:templates:manage`; `skill_authoring` when the rail holds skills | Saves a deal's rail to the catalog: `{ requestId, sourceDealId, description, target }` with `target` `{ kind: 'new', name }` or `{ kind: 'replace', templateId, expectedRevisionId }`. Creates the template or applies the rail through the catalog's logged changes, publishes the next version, and leaves the deal following it. The same `requestId` returns the first result. `409` for a taken name, a template that moved, unpublished changes, steps in another order, a template that already matches, or a rail that changed meanwhile | — |
| PATCH | `/rail-catalog/{templateId}` | `company:rails:templates:manage` | Body `{ description }`, at most 500 characters; logged and undoable; a change to publish | — |
| GET, POST | `/deals/{dealId}/dataroom` | internal deal member (external: `403`) | Data room setup state, `{ status: 'ready' \| 'pending' }`. `pending` means the Box folders failed at deal creation (`deals.dataroom_pending_since`, set by `provisionDealDataroomOnCreate`, which no longer throws); deal creation still answers `201`. `POST` retries the setup: `200 { status: 'ready' }` clears the state, `502 { status: 'pending' }` keeps it. The rail shows the state with a retry | #224 (PL-27) |
| GET | `/mailbox/google/connect` | session, `mail_channel` | Start Connect for sending with Gmail: 307 to Google's consent screen for `openid email gmail.send` (PKCE S256, `access_type=offline`, `prompt=consent`, `login_hint` the caller's address, `hd` the firm's Google Workspace domain as a hint), setting the `gmail_send_state`, `gmail_send_verifier` and `gmail_send_next` cookies (httpOnly, SameSite=Lax, Secure outside development, 600 s); `?next=` is an app-internal path. `503` when the sending client is not configured, `403 { error, reason: 'not_eligible' }` for an external user (bankers only, owner decision 2026-10-19), `409 { error, reason: 'no_firm_domain' }` when the firm has no Google Workspace domain on record, `500` when the domains cannot be read | #490 |
| GET | `/mailbox/google/callback` | session, `mail_channel`; the cookies set by `/mailbox/google/connect` | Google's return leg, and the only writer of Gmail connections: checks the state (constant time) and the verifier cookie, the granted scopes (`gmail.send`, nothing beyond `openid`, `email` or `userinfo.email`), and the `id_token` (`aud`, `iss`, `exp`, an `hd` on a firm domain, a verified email equal to the caller's, a `sub` equal to a bound Google identity); stores the refresh token encrypted with the granted scopes and `account_sub` as a new row and audits `mailbox.connected` (`detail {provider}`) in one transaction (`mailbox_sending_connect_google`), and always answers 307 back to `next` with `?mailbox=connected` or `?mailbox=error&reason=` `wrong_account` \| `not_workspace` \| `scope_missing` \| `scope_unexpected` \| `no_firm_domain` \| `cancelled` \| `failed` \| `not_recorded`, plus `&granted=1` when Google had already returned a code. A refusal stores nothing, is audited as `mailbox.connect_refused` (`detail {provider, reason}`), and never revokes at Google; if that audit write fails the reason is `not_recorded` | #490 |

Accepting an added template step that holds a skill (ADR-0024): `POST /deals/{dealId}/rail/template-changes/{changeId}/decision` needs `skill_authoring` as well, imports that one skill into the deal through Ignatious, and only then records the decision, so the step lands as a skill step bound to the deal's own copy. It answers `409` when skills are not enabled or the skill is no longer available, `503` when the skill service does not answer, `502` when it answers with something Conductia cannot use and `500` when it refuses for another reason, and the change stays undecided in each case. Each of those answers carries `code: 'skill_step_not_added'`, and the review dialog shows its sentence as it is.

`POST /deals` accepts the full Gate 0 payload — `{ codename, codenameTheme?,
targetName | targetCompanyId, entryStepSeq?, members?: [{ userId, dealRole }],
conflictsAttestation: { approvedBy, approvedOn } }`
— and returns `{ deal, memberships, notified, screening }`. Required:
`codename` + a target + `conflictsAttestation` (the Seq 6 gate — the
senior-partner conflicts approval, recorded on the deal as
`conflicts_approved_by/on` and audited as `attest`; the check itself runs
off-platform, the platform records the attestation and refuses to create a
deal without it; no expiry, but the date is recorded for a future staleness
policy). All writes are transactional inside the RPC. **COMPLIANCE:** the code
name is mask-validated server-side and no notification/audit payload ever
carries the target company name.

Notable status codes: `400` (bad body / invalid member role / invalid company
type / missing conflicts attestation), `401` (no session), `403` (not permitted
/ non-MD grant / cannot search companies), `404` (deal/doc/invitee/notification
not found, or the caller cannot see the deal), `409` (code name or company name already in use), `422` (code name
does not mask the target, or a wall breach), `503` (server/tenant misconfigured).

Content stays out of URLs and error bodies (#331, ADR-0017 O3). `GET /companies` and `GET /crm-people` refuse any free-text query key, in any case, with `400 {"error":"Search terms are not accepted in the URL"}`: `query`, `q`, `person`, `search`, `prompt`, `text`, `message`, `name`, `path`, `file`, `filename`, `title`, `subject`, `email`, `term`, `keyword` (the list in `src/lib/url/freeTextKeys.ts`). Person search is `POST /people/search`, with the text in the body. A database failure on `POST`/`GET /outbox`, `PATCH /outbox/{messageId}`, `POST`/`GET /invites`, `DELETE /invites/{inviteId}`, `POST /invites/{inviteId}/resend` and `GET`/`PATCH /me` answers `500` with fixed copy and a code, never the database's own message, which can quote the submitted value: for example `{"error":"Outbox write failed (22001)"}` or `{"error":"Message sent but audit write failed (<code>)"}`. Status codes are unchanged.

Rail templates saved before the catalog are retired (`20261008100000_retire_old_saved_rails.sql`): `GET /rail-templates` and `GET /rail-templates/{templateId}` no longer return them, and `POST /deals` naming one answers `409 stale_template`. A save's `requestId` is matched together with its deal, so the same id sent for another deal is a new save. A deal's decisions on template changes count only for the template it follows now: `GET /deals/{dealId}/rail/template-changes` shows a discard made under another template as undecided, and reopening one answers `409`.

AI spend from skill runs (#155, plan v5 W3): `POST /deals/{dealId}/steps/{stepId}/skill-runs/stream` writes one `ai_usage` row per run that finishes (`source: skill_run`, `task` the rail step key, `external_id` a server-generated id that the run's audit row keeps as `detail.ledgerId`, so a reused or colliding client `runId` cannot suppress the row), with cost and model read server-side off the bench's `done` frame, as for bench chat. The source is allowed by migration `20261009150000_ai_usage_skill_run_source.sql`. Only finished work is on the ledger: a skill run that errors or is cancelled, and a twin chat reply that fails (`POST /companies/{companyId}/twins/{personaId}/chat`, one `twin_chat` row per reply), report no cost and write no row, though they may have spent tokens.

AI spend from the skill builder (#155): since agents-backend PR #147 the bench prices every authoring and enhancement turn on its closing `done` line (`costUsd`, `model`, `modelId`). The turn runner now writes one `ai_usage` row per finished turn (`source: skill_authoring`; `task` is `skill_authoring`, `skill_enhancement` for a turn seeded from an existing skill, or `catalog_skill_authoring` for a firm catalog draft, which has no deal), keyed by the attempt id and attributed to the user who sent the message. A failed turn writes nothing: the bench prices a turn only on its `done` line, so a turn that errors, times out or streams nothing reports no cost, and any tokens it spent are not on the ledger. An unpriced finished turn is recorded with a null cost. Agent runs (MD Briefing, lead presearch) now record the models they called, from the control plane's `run.modelIds`, instead of a null model; rows written before this change keep their null model. A run that called more than one model records them joined (`claude-sonnet-4-5 + claude-haiku-4-5`); the AI Costs page shows that as its own line under spend by model, and the cost is still the backend's figure for the whole run. Migration `20261009190000_ai_usage_skill_authoring_source.sql` widens the source CHECK and must run before the code is deployed (applied by hand, before hosted migrations moved to the Migrate database Action; Issue #400).

Sending mailbox, Gmail included (#490, ADR-0025; D102, number to confirm at merge). The `GET /mailbox` and `DELETE /mailbox` rows above predate Gmail; this paragraph is their current contract. `GET /mailbox` answers `{ configured, connected, email?, provider?, connectedAt?, status?, providers: { microsoft, google } }`. `providers` says which sending clients this deployment has: the Azure app, and the Google sending client (`GOOGLE_SEND_CLIENT_ID`, `GOOGLE_SEND_CLIENT_SECRET`, `GOOGLE_SEND_REDIRECT_URI`, with `MAILBOX_TOKEN_KEY`). `configured` is true when either is; until `[490 8/10]` it meant the Azure app only. `provider` is `microsoft` or `google`. `status` is `connected` or `revoked`, where `revoked` means Google ended the approval (any `invalid_grant`), and `connected` is true only for `status: 'connected'`. A Microsoft row on a deployment without the Azure app reads as not connected, as before; a Google row is always reported, so Mail settings can say Gmail sending is switched off when `providers.google` is false. A read error answers `500 {"error":"Mailbox connection unavailable"}`, where it used to read as not connected. `DELETE /mailbox` still answers `204` and deletes the row and its stored tokens whatever the provider or status. It never revokes at the provider (#490 T3). Deleting a Google row is audited as `mailbox.disconnected` (`detail {provider}`) in the same transaction (`mailbox_sending_disconnect`); a failure answers `500 {"error":"Disconnect failed; the mailbox is still connected"}` and changed nothing. Microsoft connect and disconnect write no audit rows yet. The `/setup` card `microsoft_365` reads only a Microsoft row. Migration `20261017120000_mailbox_connections_google.sql` (provider `google`, nullable `tokens_encrypted`, `account_sub`, `status`, `revoked_at`, the four `mailbox.*` audit actions, the three service-role state-change functions; rollback in `supabase/rollback/`) must run before the code is deployed.

---

## Onboarding & data room (`platform_onboarding`)

Everything above marked *flag-on* ships behind the `platform_onboarding`
feature flag: new routes `404` when it is off, changed routes keep their
pre-onboarding behavior exactly. The moving parts:

- **Invites** (`invites`, trusted-domain, and confirmation data plus the
  versioned `security definer` RPC set): state machine `pending → accepted |
  revoked | expired`, global one-live-invite-per-email, `delivery_status`
  split from lifecycle so a created-but-unemailed invite is recoverable via
  resend. A nonmatching, personal, or unconfigured domain requires a one-time
  inviter confirmation bound to the exact actor, email, company, and deal.
  Acceptance requires a **delivered** credential and successful current
  out-of-band recipient verification, then runs on the session-bound client so
  `auth.uid()` is the invitee. The email and pre-verification screen reveal no
  company, deal, inviter, mandate, or role context.
- **Pre-accept containment:** the invite link creates an auth identity whose
  profile is set to `users.status = 'invited'` by the server (the
  `handle_new_auth_user` trigger is untouched). `requireApiUser` returns
  `403 onboarding_incomplete` for invited accounts on every endpoint except
  invite context, verification, and acceptance; the `(authed)` layout redirects them to
  `/accept-invite`.
- **Company bootstrap** (`POST /companies/onboard`): firm-admin only. A `bank` gets its own tenant (D54). Creates
  (or reuses, by case-insensitive tenant+name match; a conflicting type answers
  409) the company and sends its first `director` invite. A non-matching owner
  email answers 409 `domain_confirmation_required` with a `confirmationId`;
  re-submitting the body plus that id confirms the address. The accepted owner
  lands with member management rights; a memberless company row is legal until
  that acceptance. Director invites always require company-management rights:
  delegated `can_invite` mints member seats only.
  The owner manages the roster at `/companies/{id}/members` in the shell
  (promote/demote, remove, pending invites, invite form) and can delegate
  inviting to a member via `company:invites:send`. During the compatibility
  release, the deprecated `{ canInvite }` member PATCH writes that direct grant
  through the member-access transaction. Resend/revoke, invite listing,
  director invitations, and deal seats stay with directors and admins.
  Phase A of #160 adds a proposal-only `preferred_deal_role` for internal
  colleagues. It never grants a seat. Directors and admins confirm it when a
  colleague is later added to a deal. The members page can also request walled
  rows for directory administration; the bare roster remains wall-filtered for
  Gate 0 and non-managing viewers.
- **Canonical Team surface:** `/projects/{projectId}/team` owns the live roster,
  invitations, resend/revoke, and member access controls. The historical
  `/projects/{projectId}/working-group` URL redirects to Team and is not a
  separate destination; there is no top-level `/working-group` route.
  Flag-off behavior retains the ConductiaAPI-backed conversation demo.
- **Platform 2FA:** Supabase TOTP AAL2 is required for every protected browser
  route and user API. Password sign-in and accepted invitations continue to
  `/two-factor`; users enroll or challenge there before entering the shell.
  Existing AAL1 sessions are gated on their next protected request. This
  boundary remains active when `platform_onboarding` is off.
- **Document wall** (`src/lib/api/v1/documentAccess.ts`): checks in order —
  `room = 'internal'` is never visible to an external user; classification 4
  (MNPI) is MD/CCO/admin only; external viewers must satisfy `min_phase ≤`
  their seat's `phase`. Applied on list, view, and download; walled rows are
  indistinguishable from missing ones.
- **Storage seam** (`src/lib/storage/`): `DataRoomStorage` moves bytes only
  (`local` = Supabase Storage bucket `dataroom`, `box` = Box via
  client-credentials; `STORAGE_PROVIDER` selects, local is the default so
  dev/CI need no Box credentials). Paths derive server-side from
  `dealCode + room`; access decisions never live in the provider.
- **Content tags at upload** (`src/lib/compliance/documentTags.ts`, migration
  `20261015110000`): both upload routes read the uploaded file's text once
  (`attachmentText`, same 3MB cap) and run the deterministic rules, no model
  call, storing `documents.content_tags = { contentDigest, textStatus,
  rulesVersion, taggedAt, tags? }`. Tags are `mnpi`, `promissory`, or
  `lexicon-<category>` (lexicon tiers 1 and 2), never text or matched phrases.
  `tags` is present only when all of the text was read. Tags are written
  shortly after the upload answers (in `after()`), so a fresh upload may
  briefly have no tags. Tagging fails open: it never blocks or rolls back an
  upload. `GET /deals/{dealId}/documents?tag=<tag>`
  (flag-on) lists only tagged matches the viewer may open; an unknown tag is
  `400`.
- **Document names on the audit trail and the flag-off list (#229):**
  `GET /deals/{dealId}/audit` applies the document wall's name tests to every
  event that references a document, loading those documents in one read.
  An external viewer gets an internal-room event with no `document_id` and no
  `detail.name` or `detail.fileName`; a viewer who is neither the deal MD nor
  oversight gets a class-4 event with the name removed. A referenced document
  that no longer exists is judged as internal-room class 4. The flag-off
  branch of `GET /deals/{dealId}/documents` keeps its pre-onboarding response
  shape but drops the same rows the flag-on list drops (internal room for
  externals, class 4 below MD and oversight), the one exception to flag-off
  parity.

## Company access management (`company_access_management`)

The fail-closed `company_access_management` flag defaults off. While it is off,
the role and member-access routes return `404`, the Phase B UI is hidden, and
existing company behavior remains available. The schema and legacy invite
backfill can be deployed before the flag is enabled.

### Permission catalogue and protected roots

The migration owns this fixed catalogue:

| Key | Meaning and boundary |
|---|---|
| `company:directory:view_all` | Include research and trading identity rows in the company roster. It does not reveal their deals, documents, inbox, or invitation activity. |
| `company:invites:send` | Send member invitations to the actor's own company. It does not permit director invitations, deal seats, resend, or revoke. |
| `company:roles:manage` | Create, replace, and archive custom company roles. |
| `company:access:assign` | Replace an eligible employee's custom role and direct-grant sets. |

Company directors and same-tenant firm admins are protected roots. Roots hold
the full company catalogue implicitly, remain the only actors that may
add/remove/promote/demote company members, and cannot have their root authority
removed through custom access. Custom company grants never imply company search,
deal membership, deal invitations, document access, or mail access.

### Additive access, source attribution, and grant envelope

For an active internal bank employee, effective company permissions are the
union of every active assigned role and every direct grant. There are no deny
rows. Every effective permission is returned once for each granting source:

```json
{
  "permissionKey": "company:invites:send",
  "source": { "type": "role", "id": "role-uuid", "name": "HR Manager" }
}
```

`source.type` is `root`, `role`, or `direct`; `id` and `name` are nullable.
Removing one source does not remove permission inherited from another source.

An actor may put into a role or member assignment only permissions already in
the actor's effective set. A role assignment is checked using the role's full
bundle. This grant envelope is rechecked inside every transactional write after
locking the actor and mutated record. Role and member-access writes update the
version and audit rows atomically. A stale version returns `409`.

### Role and employee-access contracts

`GET /companies/{companyId}/roles` requires `company:roles:manage` or
`company:access:assign`. It returns `permissions`, active `roles` with
`permissionKeys` and `assignmentCount`, plus source-aware
`viewerPermissions`. Role creation accepts `{ name, description,
permissionKeys }`; replacement additionally requires `expectedVersion`.
Deletion requires `?expectedVersion=` and archives the role. An assigned role
returns `409` with `assignmentCount` instead of being archived.

`GET /companies/{companyId}/members/{userId}/access` is available to the target
employee or an actor with `company:access:assign`. It returns `assigned_roles`,
`direct_permissions`, `effective_permissions`, and `version`. PATCH requires
exactly:

```json
{
  "expectedVersion": 4,
  "roleIds": ["role-uuid"],
  "directPermissions": ["company:invites:send"]
}
```

PATCH replaces both sets in one transaction and returns the new access
snapshot. Common errors are `400` for invalid permissions, roles, or bodies;
`403` for missing authority or a grant outside the envelope; `404` for an
ineligible member, missing role, or disabled flag; `409` for a stale version,
duplicate active role name, an assigned role archive, or a protected-root
assignment attempt; and `503` when the authoritative access resolver is
unavailable.

`GET /me` exposes source-aware `company_permissions` for the current company
when the flag is enabled. The company roster honors `includeWalled=true` only
for protected roots or actors with `company:directory:view_all`.

### Invite delegation migration

`users.can_invite` is no longer an authorization source when Phase B is
enabled. Existing true values are backfilled as direct
`company:invites:send` grants, and company invitation checks use the
authoritative company permission resolver. Deal-attached invitation authority
is unchanged.

For one compatibility release, the deprecated
`PATCH /companies/{companyId}/members/{userId}` body `{ "canInvite": true }`
runs through the same versioned member-access transaction and changes only the
direct invitation grant. Its response reports both the direct compatibility
projection and all effective invitation sources. Clearing the direct grant can
therefore leave invite permission effective when a role still grants it.

`users.can_invite` remains temporarily synchronized as output for old clients.
A later contract migration must remove the column, the deprecated PATCH branch,
and old response fields after all clients consume source-aware member access.

## Setup and walkthroughs (#125)

`GET /setup` is the account-readiness contract behind `/setup`. The API routes,
page, and navigation are fail-closed behind `setup_walkthroughs`; flag-off API
requests return `404`. When enabled, it returns only configuration status, never
credentials:

- Microsoft 365 availability and the caller's connected identity, when the
  `mail_channel` flag and Graph configuration are both present.
- Box credential readiness and whether Box is the active data-room provider.
- A `user` walkthrough for every active account.
- An `administrator` walkthrough for firm administrators, company directors,
  and members with effective `company:access:assign` permission.

Integration readiness is an internal setup concern. External accounts receive
`eligible: false` with false readiness values for Microsoft 365 and Box, while
retaining their user walkthrough.

The current content version is `1`. Each track contains three stable step IDs.
The server returns a revision for optimistic concurrency. Mutation bodies are
strict camelCase objects:

```json
{
  "contentVersion": 1,
  "expectedRevision": 2,
  "completedStepIds": ["data_security", "data_room_boundaries"]
}
```

`PATCH /setup/walkthroughs/{track}` replaces the exact completed-step set. The
transaction validates actor eligibility and step IDs again, increments the
revision, and writes an `audit_log` row. Completing the last step changes the
audit action to `attest`, records `completed_at`, and makes that version's
attestation immutable. Identical retries do not change the revision or add an
audit row. A stale revision or attempted completed-attestation change returns
`409`.

These walkthroughs are product guidance about Conductia controls. They are not
formal employer, legal, FINRA, or regulatory training. A future content change
must ship as a new content version so earlier evidence is retained.

## Durable skill authoring (`skill_authoring`)

Skill authoring gives an eligible internal project member one private,
durable authoring draft per project. Conductia owns the draft, its immutable
messages, generation attempts, and candidate metadata, and calls Ignatious
directly for generation. It stops at a validated candidate preview: it never
publishes a skill or creates a rail step. The design of record is
`docs/superpowers/specs/2026-09-11-durable-skill-authoring-slimdown.md`.

### Architecture

`POST .../messages` (or `.../retry`) admits the message and a `running`
attempt in one transaction, returns the receipt, and, only when the attempt
was newly created, schedules `runAuthoringTurn(attemptId)` with Next's
`after()`. The turn runner loads the turn context, calls Ignatious's
`POST /v1/bench/authoring/turns`, streams the NDJSON response, writes the
accumulated reply text to the attempt about every 500 ms, and finishes the
attempt as succeeded (with the last candidate) or failed. The browser polls
`GET .../skill-drafts/:draftId` to see the streaming reply and the outcome.
The browser never calls Ignatious directly and never receives an Ignatious
URL, key, provider identifier, or candidate artifact reference.

`after()` is not durable: a deploy, crash, or timeout ends the turn. The send
and retry routes set `maxDuration = 300` (Vercel Pro) and the turn deadline is
280 seconds. The stale-attempt rule below turns an interrupted turn into a
retryable failure without a sweep job.

### Browser routes

Paths are relative to `/api/v1`. Every route checks the `skill_authoring` flag
first and returns `404` when it is off.

| Method | Path                                                                | Body                                                        | Behavior                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/deals/{dealId}/skill-drafts`                                      | none                                                        | Returns the caller's active draft or creates one. Concurrent opens converge on one draft; archived drafts are ignored, so the next open after a discard starts fresh.                                            |
| GET    | `/deals/{dealId}/skill-drafts/{draftId}`                            | none                                                        | Restores the authoritative draft: name, placement, acknowledged composer text, `editRevision`, messages with their attempt history (each carrying `responseText`), the active attempt, the candidate preview, and `publication: { available: false }`. |
| PATCH  | `/deals/{dealId}/skill-drafts/{draftId}`                            | `expectedEditRevision`, `name`, `placement`, `composerText` | Autosaves editable state. An exact revision updates the draft and increments the revision.                                                                                                                        |
| POST   | `/deals/{dealId}/skill-drafts/{draftId}/messages`                   | `clientMessageId`, `expectedEditRevision`, `text`           | Admits one immutable message and its first attempt in a single transaction, then schedules the turn. Replaying the same `clientMessageId` and text returns the original receipt without scheduling again.       |
| POST   | `/deals/{dealId}/skill-drafts/{draftId}/messages/{messageId}/retry` | `retryRequestId`                                            | Admits a new attempt for a message whose latest attempt failed, then schedules the turn. Earlier attempts and their partial responses stay in the history. Replaying the same `retryRequestId` returns the same attempt without scheduling again. |
| POST   | `/deals/{dealId}/skill-drafts/{draftId}/discard`                    | `expectedEditRevision`                                      | Archives the draft. Edits, messages, retries, and a second discard are rejected afterwards. An attempt admitted before the discard is not cancelled.                                                             |

Responses use these statuses: `401` without a session, `403` when the caller
can see the deal but lacks internal classification or the structural permission
(the denial is audited), `404` when the flag is off, the deal is unknown, the
caller has no project access (audited too, answered like an unknown deal, D65),
or the draft is not the caller's, `400` or `422` for an invalid request, and
`409` when the draft changed. A `409` body carries the latest authoritative
`draft` and the `activeAttempt`, so a stale tab can adopt the server revision
and re-apply unsent local field edits.

### Private-author rule

A draft belongs to one author and one project. Starting, reading, editing,
sending, retrying, and discarding it require an authenticated user with
current project access, internal member classification,
`company:deals:steps:structure` on the project's bank company, and authorship
of the draft. Every database function filters by the session user as author,
so another internal member who holds the structural permission receives `404`
for the draft ID, exactly as for a draft that does not exist. External members
receive `403` even when a permission row exists. Losing project access or the
permission blocks reads and mutations without deleting or transferring the
draft. When access returns, the original author resumes the same draft with
its composer text intact.

### Attempt states and stale attempts

A draft has at most one `running` attempt. An attempt is live when
`status = 'running' and last_progress_at > now() - interval '60 seconds'`. The
draft projection reports a non-live running attempt as `failed` with
`error_code = 'generation_interrupted'`, and `submit_message` and
`retry_message` mark a stale running attempt `failed` in the same transaction
before admitting a new one, so an interrupted turn always becomes a retryable
failure. `succeeded` and `failed` are terminal; Retry is offered only for
`failed`.

### Save boundary

The dialog's Save skill and add step action stays unavailable here. Draft
responses always carry `publication: { available: false }`, and no route here
publishes a candidate or creates a rail step. A candidate becomes the draft's
current candidate only after its attempt succeeds while the draft is still
active. A candidate delivered after a discard is kept as history and never
becomes current. Publication belongs to Part C.

### Ignatious authoring turn API

`POST /v1/bench/authoring/turns`, mounted inside the skill-bench app,
authenticated by the same `x-api-key` Conductia already sends to the bench
(`IGNATIOUS_API_KEY`). There is no separate authoring service token. The
response is `application/x-ndjson`: zero or more `{"type":"text","text":"..."}`
lines, zero or more `{"type":"candidate",...}` lines (the last one wins), and
exactly one terminal line, `{"type":"done"}` or
`{"type":"error","code":"generation_failed","message":"..."}`.

The database invariants are proven by `supabase/tests/skill_authoring.sql`
through `tests/db/skill-authoring.test.ts` and
`tests/db/skill-authoring-draft-contract.test.ts`. The probes are skipped
unless `RUN_DB_TESTS=1`, refuse any `DATABASE_URL` host other than
`localhost`, `127.0.0.1`, `::1`, or the Compose host `postgres` when
`ALLOW_LOCAL_DB_HOST=postgres`, and run inside an isolated schema in a
transaction that rolls back.

### Opening a draft to teach a skill

`POST /deals/{dealId}/skill-drafts` accepts `teach: true` beside `basisStepId` and `seedRunId`. The server then takes the output's applied, ticked comments that are neither sent nor already waiting on this draft, builds the prompt (the instruction to keep the lessons in a section titled "Learned from reviews", then each comment, the passage it was written on and what it became), appends it to the draft's composer text and records those comments as waiting on the draft, by id only. The prompt carries as many comments as fit in the 20,000-character composer, oldest first, and the rest stay counted. A second open with no new comments adds nothing. The next message sent on the draft marks its waiting comments as sent, in the transaction that admits the message, and `skill_authoring.message_admitted` carries `taughtComments`, a count. With `teach: true`: `404` when `skill_output_revisions` is off; `404` `Unknown step` for an unknown step and `409` for a step without a skill, as without `teach`; `422` `Teaching the skill needs the step and the run it reviewed.` only when `basisStepId` or `seedRunId` is missing, or the seed run is not a run of that step; `500` `The comments could not be read.` when the output's revisions cannot be read.

## Exercising it (dev explorer)

`/dev-api` is a dev-only Swagger UI that renders `/api/v1/openapi.json` and sends
the Supabase session cookie with "Try it out":

1. `npm run dev`
2. Seed accounts + sample deals: `npm run seed` (runs `seed:flags` then
   `seed:users`). Requires `SEED_PASSWORD` (min 8 chars) in `.env.local`.
3. Open `http://localhost:3000/dev-api` and sign in. The account is typed, not
   picked from a list: which accounts exist is a property of the database you
   are pointed at (the dev seed roster below, the Conductia team roster from
   `scripts/seed-team.ts`, or anything created through onboarding), so the page
   does not pretend to know. The last e-mail used is remembered.
4. Try the endpoints. Sample deals: `ATLAS-2026-001` (*Project Atlas*, day one)
   and `SUMMIT-2026-003` (*Project Summit*, Gate 0-complete, entered at step 12,
   with a seeded CCO `deal_created` notification).

### Visibility

Both the page and the `/api/v1/openapi.json` route it renders share one gate,
`devApiEnabled()` in `src/lib/api/v1/devApi.ts`: open under `next dev`, `404` in
any production build unless that deployment sets `ENABLE_DEV_API=true`. The
document maps the v1 surface — routes, auth rules, feature flag and permission
names — so leave `ENABLE_DEV_API` unset to keep it local.

The document is non-normative. It is a developer aid for this explorer, not a
contract for integrators, and it can lag the route handlers under
`src/app/api/v1`, which are the source of truth. No external integrator
consumes it (PL-21, #225).

### Seed accounts (`scripts/seed-data.ts`)

`<slug>.intelibank@dev.com`, password = `SEED_PASSWORD`:

| Slug | Name | firm_role | deal_role |
|---|---|---|---|
| `md` | Storm Duncan | — | `md` |
| `deal-team` | Alex Chen | — | `deal_team` |
| `legal` | Jordan Blake | — | `legal` |
| `cco` | Pat Rivera | `cco` | — |
| `admin` | Platform Admin | `admin` | — |
| `ib-director` | Morgan Vale | — | `deal_team` (bank director) |
| `seller` | Mike Cannon-Brookes | — | `seller` (external) |
| `buyer` | Buyer Contact | — | `buyer` (external) |
| `read-only` | Observer One | — | `read_only` |

`npm run check:db` verifies the schema + role seed are present.

---

## Constants are the typed mirror of the SQL

`src/lib/constants/*` (`roles`, `companies`, `deals`, `documents`, `audit`,
`tables`) mirror the migration's `CHECK` enums so routes, seeds, and `check:db`
never stringly-type a role/status/action. **The migration
(`supabase/migrations/20260604100000_permissions_schema.sql`) is the source of
truth**; the constants carry a header pointing back to it. Keep them in sync when
the schema changes.

## Smart onboarding (platform_onboarding)

Three surfaces, one decision path. The perimeter preview and the invitee's
welcome brief both run the same predicates that gate real document reads
(`userCanSeeDocument`, `userCanUploadDocument`), so a document counted as
available in a preview is exactly one the seat can open. There is deliberately
no second access implementation to drift.

### `POST /api/v1/invites/lookup`

Identifies the company behind a work email and proposes a least-privilege seat.
Creates nothing, sends nothing, confers nothing.

For a selected or disclosed company, `companyRolePolicy` reports whether
`member` and `director` are currently assignable. A company with no active
director returns `memberAllowed: false` and `requiresDirector: true`, so the
composer removes Member before an invitation can be sent. `directorAllowed`
reflects the current actor's company-management authority. If neither role is
available, the UI explains that a firm admin must bootstrap the first Company
Director. The send route repeats the active-director check and returns
`409 company_requires_director`; invite acceptance maps the database invariant
to the same actionable recovery instead of exposing a PostgreSQL error.

Authority to *compose* an invitation is not authority to *interrogate the user
base*. Candidate companies are scoped to the actor before any domain is matched:

| Actor | Candidates |
|---|---|
| Firm admin | every company in their own tenant, never another |
| External director, deal in context | their own company, and only if it is a party |
| External director, no deal | none — `userCanInvite` requires a deal for them |
| Internal staff who can manage this deal's members | the bank plus the deal's parties |
| Internal director or admin, no deal | companies they can manage |
| Internal member with `company:invites:send` | their own company (#145, #160) |

Warnings about an existing platform user, an existing deal seat or a pending
invitation are disclosed only to an actor already entitled to that fact
(`A17`/`A18`/`userCanManageInvite`). For anyone else the response is
**byte-identical** to one for an address nobody has ever seen: `warnings` is a
flat fixed-order array, and a suppressed condition contributes no element, no
placeholder and no reordering. A per-check status map such as
`checks: { existingUser: 'not_permitted' }` would satisfy the letter of the rule
and defeat it entirely.

Reason and warning values are stable ids, not prose. Copy lives in the
component, so no wording (and nothing smuggled inside wording) ships from the API.
For a disclosable existing user who belongs to the matched bank company,
`recommendation.dealRole` uses a valid `preferred_deal_role` and the stable
reason `employee_default`. Otherwise the bank recommendation remains
`deal_team` with `bank_internal_seat`; the disclosure boundary and query
schedule do not change.

### `POST /api/v1/invites/perimeter-preview`

Answers "what will they actually see" for a proposed seat, or for an existing
member at a proposed phase.

Not nested under `/deals/{dealId}`: Gate 0 composes invitations before the deal
exists, and a third invitation flow was out of scope. The deal is optional
context, so a pre-deal preview reports the seat and its destinations with an
empty document set.

- Proposal mode is authorised by `assessProposal` — the same feasibility check
  the send route makes.
- Member mode is authorised by `userIsDealMd`, and refuses a downgrade with 409:
  disclosure is monotonic.
- Counts are per reachable room. A room the seat cannot reach is **absent**, not
  present with a zero; a zero is still a disclosure.
- Failure returns 503 with no `perimeter` key at all, so "could not compute"
  can never arrive dressed as "they can see nothing".
- A proposed Member at a company with no active director returns
  `409 company_requires_director`; it is a recoverable role-selection conflict,
  not an authorization denial.

### `phase` on `POST /api/v1/invites`

The disclosure phase the inviter confirms now travels with the invitation and is
granted verbatim at acceptance. Before this, `accept_invite` inserted a literal
`0`: an inviter could confirm phase 2, watch a phase-2 preview, and the accepted
user would land on phase 0.

`create_invite` re-derives the actor's authority and the seat's shape **inside**
the write transaction, under the advisory lock it already held, because a
director can be demoted or a party removed between the route's check and the
insert. That makes the SQL a second implementation of `proposalFeasibility.ts`,
so the two are pinned to one shared case table:

    RUN_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/db

Omitting `phase` means 0, so callers that predate the field are unaffected.


## AI spend read model

`GET /api/v1/ai-spend?dealId=<UUID or code>` returns recorded AI usage for an
accessible deal. Omitting `dealId` returns the caller's tenant-wide summary;
the server applies `firmMailAccess` (external users denied, research/trading
walls enforced with existing overseer rules). The client does not grant access.

The tenant-wide answer goes only to firm overseers (`firm_role` CCO or admin)
and bank directors (`company_role` director). A banker sees only the deals they
sit on, so the firm-wide read must not give every internal user the code name
of every deal and the spend of every colleague; any other internal user gets
403 and reads each deal's spend with `?dealId=`. Before PR #295 those users got
a `reduced` answer (total, by task, by model); it had no screen left once the
panel moved off the Book, so it was removed. `detail` is always `full`. A
deal-scoped read is unchanged for whoever can open the deal.

The firm summary lives on its own global page, `/ai-costs` ("AI Costs" in the
TopNav, Sidebar and mobile nav, on and off a deal), through the shared
`AiSpendPanel`, opened expanded. The page and its nav entry use the same rule
as the endpoint (`showAiCostsNav`, including the research/trading wall for
directors); anyone else who opens the URL is sent home. It includes costs
outside a deal and groups recorded usage by deal, person, task and model. The deal Audit
Trail retains its existing per-deal panel. Denied responses render no spend;
firm service errors show an unavailable state rather than a zero balance.

The endpoint still aggregates the newest 2,000 ledger records. When
`window.truncated` is true, the panel explicitly identifies the latest-record
window. Tables show up to eight groups and disclose when additional groups
exist. Unpriced calls are counted separately from the recorded USD total.
Agent runs without a reported model are labeled `Ignatious agent run (model
not reported)`; this names the source without inventing a model or provider.

This is the first UI slice of #155, not completion of that issue. Twin chat
costs are captured in the ledger since PR #427 (skill-bench chat since #193,
see the `/ai-spend` row above); SQL aggregation
and the orchestration token-meter replacement remain separate follow-ups.
No migration is introduced. The one access change is the two-level detail above.

**Monthly AI budget per banker (D83, plan v5 W4).** `GET /api/v1/ai-budget` answers `{ monthlyLimitUsd, updatedAt, canEdit }` to the AI Costs page's readers (CCO, admin, bank director; research and trading walled); `monthlyLimitUsd` is null when no budget is set. `PUT /api/v1/ai-budget` with `{ monthlyLimitUsd: number | null }` sets the limit in cents (above 0, at most 1,000,000) or removes it, for a CCO or admin only, audited as `update` with `kind: 'ai_budget'` (if that audit row fails after the limit is saved, the answer is still `200` and the failure is logged). Every newly inserted priced ledger row then calls `ai_budget_check()`: when a banker's recorded spend this calendar month (UTC) reaches 80% and then 100% of the limit, the banker and the firm's own active CCOs and admins each get one `ai_budget_threshold` bell notification, once per threshold per month (the `ai_budget_alerts` primary key). Alerts only: no AI call is refused. A limit raised mid-month does not re-arm an alert already sent. Migration `20261009180000_ai_budget_alerts.sql` (applied by hand, before hosted migrations moved to the Migrate database Action; Issue #400).

**Discovery proposal rows are billed gateway attempts (#645).** One `discovery_extract` row with task `deal_proposal` is one gateway attempt the provider answered 2xx, including an attempt whose reply could not be read and the one a retry replaced; it is keyed by the response id, or `local:<uuid>` when the reply carries none. A reply without usage, or whose usage carries no token counts, is an unpriced row. "API calls" and "unpriced" therefore rise by the attempts the ledger used to miss; the deal, person, task and model cuts are unchanged. A client timeout before any reply is not on the ledger, as its billing is unknown. A ledger write that fails stops the propose step (`Stopped: an AI usage row could not be written`) and `classify-once` exits 1; the cost that run prints is recorded spend only, without the billed attempt whose row was refused. Check the `ai_usage` write (database reachable, grants intact) before rerunning `--propose`. A write that reported an error but was committed leaves one row the rerun can count a second time, bounded to one message per run. Extraction's rows follow once #440 merges.

## Model gate for the screen and code-name calls (#339 phase 1)

`src/` makes two Anthropic calls of its own, and both send a tenant's content to
the AI Gateway through `postGatewayMessages`
(`src/lib/modelGateway/gatewayClient.ts`, zero data retention, Anthropic only,
#505): the pre-send screen's model pass (`src/lib/compliance/llm.ts`) and the
Gate 0 code-name suggester (`src/lib/gate0/codenameLlm.ts`). Each of these two now needs a
tenant decision from `modelCallsAllowed(tenantId, purpose)` in
`src/lib/ai/modelPolicy.ts`. The decision is a required positional argument
of every entry point: `fullScreen(text, model, opts?)`,
`fullScreenFields(fields, model, opts?)` and
`suggestCodenames(company, offset, model, onUsage?)`. The raw calls
(`runLlmScreen`, `llmSuggestCodenames`) are module-private, and each asserts
the minted decision again right before it calls `postGatewayMessages`. No
feature flag applies to these two.

Jev's second opinion (`src/lib/ai/jev.ts`, D87) is the third model call in
`src/`, on its own processor (`JEV_PROCESSOR`). Its entry point `jevRiskRead`
also takes a required `ModelCallDecision`, minted for the purpose
`mail_send_second_opinion`, and the send path runs it only behind the
`mail_jev_second_opinion` feature flag (`src/lib/compliance/secondOpinion.ts`).

The rules run in order and follow #325's `processorGate`:

1. A null or empty tenant is withheld (`tenant_unresolved`). No allow rule
   can rescue it.
2. A verified processor is allowed (`verified_processor`): the purpose's
   processor (`processorFor`) is listed in `VERIFIED_MODEL_PROCESSORS`. The
   screen and code-name purposes reach `GATEWAY_PROCESSOR`
   (`'vercel-ai-gateway:anthropic'`); Jev's second opinion keeps its own
   `JEV_PROCESSOR` (D87). **`VERIFIED_MODEL_PROCESSORS` ships empty**, because
   listing `GATEWAY_PROCESSOR` would open these calls for every tenant.
3. A **pair-scoped grant** is allowed (`verified_tenant`): an entry in
   `VERIFIED_MODEL_GRANTS` (`src/lib/ai/processorRules.ts`) whose `tenantId`,
   Supabase REST `host`, `appEnv` and `surfaces` (`extract`, `propose`,
   `screen`, `codename`) all match the request. The URL must be exactly
   `https://<host>` (default port, no userinfo). Jev's processor is never
   granted. Extraction and proposals read grants through `processorGate` and
   the proposal step's lock 3; the screen and code-name gate checks `screen`
   and `codename` surfaces. **`DISCOVERY_OUTPUT_PLACEMENT_APPROVED` stays
   false** globally; placement for extraction is implied per grant (D-TBD).
4. A `NEXT_PUBLIC_SUPABASE_URL` whose host is not `127.0.0.1` or `localhost`
   is withheld (`not_local`).
5. `NEXT_PUBLIC_APP_ENV`, trimmed and lowercased, of `prod` or `production`
   is withheld (`prod`). Any value other than `dev` or `local` (unset, empty,
   `staging`, an unrecognized spelling) is withheld (`not_dev`): the synthetic
   path fails closed.
6. A tenant in `SYNTHETIC_MODEL_TENANT_IDS` is allowed (`synthetic_tenant`).
7. Anything else is withheld (`tenant_not_synthetic`).

The lists and grants are TS constants, so a deploy cannot widen them.
`VERIFIED_MODEL_PROCESSORS` ships empty: adding `GATEWAY_PROCESSOR` is a
reviewed PR, and that PR is how ADR-0017's R4 (ZDR, no training) is recorded
(the processor row's Verified flag, after `npm run ai:zdr-probe` passes with
the production key, D90).
`SYNTHETIC_MODEL_TENANT_IDS` is `[DEV_TENANT_ID]`, honored only on a local
stack whose `NEXT_PUBLIC_APP_ENV` is `dev` or `local`. Both lists are frozen.
On develop, **`VERIFIED_MODEL_GRANTS` holds one entry**: the sandbox tenant on
the staging Supabase project with all four surfaces (`sandbox-staging`). Every
other tenant and host pair stays closed; prod is never named in a grant. Until
a grant matches, every other hosted environment withholds both calls. The
screen then runs its deterministic layer only, and code names come from the
deterministic Birds / Football / Movies sets.

Decisions are minted only by `modelCallsAllowed`, which takes the tenant and
the purpose and nothing else: it reads `process.env` and the shipped lists,
so no caller can mint an allowed decision by passing a wider list or a local
URL. Each decision is recorded in a module-private `WeakMap` (the
`ActingUser` pattern), bound to the purpose and tenant it was minted for, and
checked on entry by `assertModelDecision` against the entry point's own
purposes: the screens accept `mail_send_screen`, `mail_screen` and
`screening_eval`, the suggester only `codename_suggest`. A hand-built
`{ allowed: true }`, a spread copy, a JSON round trip or a decision minted for
another purpose is refused with a throw. The rules themselves are the pure
`evaluateModelPolicy(tenantId, env, policy)`, which tests drive with injected
envs and lists; it returns a plain verdict no entry point accepts, and
`tests/model-call-fence.test.ts` keeps production code off it and holds every
`modelCallsAllowed` call to exactly two arguments.

**Callers.** Each route resolves the caller's tenant before it screens or
suggests. A failed lookup, or a user with no tenant, passes `null`, and the
request proceeds deterministically.

| Caller | Purpose | Audit |
|---|---|---|
| `POST /outbox` | `mail_send_screen` | `screen` row: `modelDecision: { allowed, basis? \| reason?, purpose, tenantId }`, plus `llmWithheld: <reason>` when withheld. The send-as-is token carries the first screen's `modelDecision`, signed; a token without one, or for another purpose, is not honored and the content is screened afresh. A replay runs no model: its row is marked `replayed: true`, its `modelDecision` and `llmWithheld` are the first screen's, and `replayGate` records the replaying request's own decision, so a gate that withholds now is recorded as such without relabelling the read it replays |
| `POST /screen` (mode `full`) | `mail_screen` | the same keys. Mode `fast` is unchanged and never reaches a model |
| `POST /codenames/suggest` | `codename_suggest` | no audit row; a withheld call returns `source: 'fallback'` |
| `scripts/screening-eval.ts --llm` | `screening_eval` | asks as `DEV_TENANT_ID`, so it runs only against a local stack with `NEXT_PUBLIC_APP_ENV=dev` |

`recordAiUsage` still runs only when a model call happened, so a withheld
call writes no cost line.

**Three model paths, one gated here.**

1. The screen and code-name calls in `src/`: gated by this module.
2. #325's discovery extractor (`worker/extract.ts`, through the same gateway
   client): its own `processorGate`, the same processor id
   `'vercel-ai-gateway:anthropic'`.
3. The external control plane: **not gated here** (owner decision O20). The
   routes are `deals/[dealId]/bench/chat`, `companies/[companyId]/bench/chat`,
   `companies/[companyId]/twins/[personaId]/chat`,
   `deals/[dealId]/steps/[stepId]/skill-runs` and `skill-runs/stream`,
   `deals/[dealId]/steps/[stepId]/ignatious` (and `/input`, `/artifacts`),
   `companies/[companyId]/runs` (and `/input`),
   `companies/[companyId]/presearch` (and `/input`, `/artifacts`),
   `companies/[companyId]/debrief`, `rail-catalog/[templateId]/skill-drafts`
   (and its subroutes), and `bench/skills`, `deals/[dealId]/bench/skills`,
   `companies/[companyId]/bench/skills`.

**Fence.** `tests/model-call-fence.test.ts` scans `src/`, `worker/` and
`scripts/`. Only `llm.ts`, `codenameLlm.ts`, the gateway client
`gatewayClient.ts`, #325's `src/lib/modelGateway/transports.ts`, Jev's client
`src/lib/ai/jev.ts`, the owner-run ZDR probe `scripts/ai/zdr-probe.ts` (a
dummy prompt) and the recorder fallback
`scripts/discovery/lib/anthropicDirect.ts` may name `postGatewayMessages` or
`GATEWAY_MESSAGES_URL`, or contain `api.anthropic.com`,
`ai-gateway.vercel.sh` or `anthropic-version`. Every exported function of
the two gated modules and of Jev's client that can reach `fetch` or
`postGatewayMessages` must take a `ModelCallDecision` parameter.
`postGatewayMessages` itself takes none: the allow-list is what keeps every
caller of it gated. `tests/model-egress-fence.test.ts` (#505) keeps the
request itself, and the ZDR body, inside the client.

Both gates read one module, `src/lib/ai/processorRules.ts`: `GATEWAY_PROCESSOR`,
the verified list (`VERIFIED_MODEL_PROCESSORS`, empty), the synthetic list,
`isLocalUrl` and the environment rule above. `JEV_PROCESSOR` lives in
`src/lib/ai/modelPolicy.ts` and only the screen gate uses it.

**The tenant list on one processor (Proposed (agent), owner to confirm).**
Since #505 the extractor and these calls reach the same processor, but only
the extractor's verified path also requires `VERIFIED_MODEL_TENANT_IDS`
(`src/lib/modelGateway/processorGate.ts`), so the two gates allow different
tenants on it. That list is a frozen TS constant that ships empty; ADR-0017
Amendment 1 is a single-tenant pilot exception, so its flip PR lists the
Ignatious tenant alone, together with `DISCOVERY_OUTPUT_PLACEMENT_APPROVED`.
The proposal keeps this gate without the tenant list:

- With it, the hosted sandbox and Conductia tenants could never get the AI
  screen pass or AI code names, since the list is single-tenant by design;
  they would run rules only and the fallback sets for good, and the Oct 30
  demo's sandbox and Conductia flows with them.
- Without it, verifying `GATEWAY_PROCESSOR` opens these two calls for every
  tenant on every hosted deployment at once, Ignatious included. The screen
  sends the banker's outgoing draft and the code-name call sends a target's
  name and sector, never inbox mail; the gateway's ZDR is what Ignatious has
  approved for the demo, and AI on Ignatious inbox mail stays behind the
  extractor's own gate and its tenant list until their CCO approves.
- Either way, nothing hosted calls a model from these two paths until the
  processor is verified: the screen runs rules only and code names come from
  the fallback sets, which is a change from `develop` before #339, where both
  calls ran on any deployment with `AI_GATEWAY_API_KEY`.

If the owner wants one rule, the change is one line in `evaluateModelPolicy`
plus a tenant list per purpose; a per-tenant AI switch for Ignatious can then
be the list itself.

## Automatic Confidential email marking (Q2, September 21)

`POST /outbox` reads the authorized deal’s `lifecycle_category`. Live and pitch
messages receive an idempotent `[Confidential]` subject prefix before screening,
token hashing, record insertion and transport. Client-provided confidentiality
or lifecycle claims cannot disable it. Other categories do not acquire an
automatic prefix; a manually entered prefix is preserved. No migration is needed.
The label is kept single and leading across a thread: a reply that comes back
as `Re: [Confidential] …` is sent as `[Confidential] Re: …`, never with a second
label. On the server, a failed lifecycle lookup or invalid category prevents
sending; the final subject must still fit the 1,000-character limit. In the
composer, a failed preview lookup does not hold the send, because the server
applies the label regardless. Existing untagged sandbox
resolution remains compatible. The composer previews the subject using the
existing authenticated deal-detail endpoint and keeps draft input separate.
This implements Q2 only; retention and other send-policy answers are separate.

### Recipient boundary policy (Storm Q3, #171)

`GET /api/v1/mail-domain-policy` requires the mail flag and an authenticated user.
It returns `{ verifiedDomains: string[] }` for the user's own company, scoped to
both company and tenant, with `Cache-Control: private, no-store`. It accepts no
company selection. No company or no verified domains returns an empty list;
a company or domain lookup failure records the message as `unverified` and still sends (a missing sender profile is still a 404/500, as before).

`POST /api/v1/outbox` independently classifies all To, CC and BCC addresses against
that policy. Exact verified domains and their subdomains are internal; any proven
outside domain makes the message external. Missing configuration is unverified.
The normal committed-send record stores `recipient_boundary`; returned risk
findings do not create a new boundary record. External status adds an advisory
warning, never an extra send confirmation by itself. Existing authorization and
risk review behavior is preserved.

Outbox responses expose `recipientBoundary: 'internal' | 'external' | 'unverified'
| null`. Historical NULL means not recorded, never internal. The sent reading pane
uses the saved value, not today's domain configuration. Migration:
`20260921160000_outbound_recipient_boundary.sql`; apply before deploying this code.

### Send idempotency (`clientRequestId`)

`POST /api/v1/outbox` accepts an optional `clientRequestId` (8 to 128 of `A-Za-z0-9_.:-`, else 400): one key per logical send, reused on retry. The composer derives it from a digest of the exact content plus a per-composer nonce, so a retry or double click of the same message carries the same key, any edit a new one, and the nonce rotates after a send. The record-first `pending` insert is the claim (unique per sender). A repeat whose message was sent answers the original `201` with `Idempotent-Replayed: true` and runs no screen and no send; a repeat while that send is still `pending` answers `409`. Without a key the behaviour is unchanged. A provider failure still deletes the pending row, which frees the key for a retry, so a provider timeout that in fact delivered can still double send (unconfirmed-send handling is a follow-up). A crash between the `pending` insert and the provider call (a function killed mid-request) leaves the row `pending`: the same key then answers `409` until the banker edits the message, which gives it a new key. Clearing stale `pending` rows is part of the same follow-up. The CCO release (`PATCH /outbox/{messageId}`) was already guarded: its conditional `held -> pending` claim lets one of two concurrent releases send. Migration `20261014110000_outbox_idempotency_key.sql` (column `client_request_id`, partial unique index); apply before deploying this code, since the composer always sends a key.

### Sending as the banker's Gmail (#490)

`POST /api/v1/outbox` reads the caller's sending mailbox after the recipient review and before the screen. A read error answers `500 {"error":"Mailbox connection unavailable"}` before any screen, audit row or pending row, whatever the provider. A Gmail connection that cannot send answers `502` at once, with no screen, no AI spend, no `screen` audit row and no `outbound_messages` row: `Email provider send failed: Gmail approval ended; connect for sending again in Mail settings` when its approval ended, and `Email provider send failed: Gmail sending is switched off on this environment; disconnect in Mail settings to send from the platform address` when the sending client is not configured. For a Gmail sender the screen token also binds the envelope (the recipients, trimmed and lowercased in order, plus the sending connection's row id, provider and address), so a send as is replays the first screen only for the same recipients and connection, and not after the same address is disconnected and connected again; Graph and platform tokens are unchanged. At the send, the mailbox must still be the one read before the screen: a connect, reconnect or disconnect in between answers `502` with `Email provider send failed: Your sending mailbox changed. Send again.`, for Microsoft connections too. A Gmail send refreshes the token, builds the message with `From` pinned to the connected address (a `from` in the body is ignored, as before), and records `provider: 'gmail'` with Gmail's message id as `provider_message_id`. An `invalid_grant` on the refresh marks the connection revoked and audits `mailbox.approval_ended` in one transaction (`mailbox_sending_mark_revoked`). Other Gmail failures are `502` with fixed copy or a code (`gmail-token_<status>`, `gmail-send_<status>`, `mailbox_unavailable`, `rfc822_header_break`, `rfc822_from_not_pinned`), never Google's own text. The platform `From` (`EMAIL_FROM`) is now resolved only when the platform transport sends, so a missing `EMAIL_FROM` no longer fails a Graph or Gmail sender. The only migration is `20261017120000_mailbox_connections_google.sql`. Failure states and operator actions are in [gmail-send-runbook.md](./gmail-send-runbook.md).


### Firm compliance settings (Issue #94, Issue #95; D105)

`GET /api/v1/compliance-settings` answers `{ settings: { queuedFrom, sampledFrom, uncheckedFloor, sendFriction }, isDefault, updatedAt, canEdit }` to the firm's CCO or admin (inside the research / trading wall; `canEdit` is true for the CCO only); everyone else gets `403`. With no saved row the values are the shipped defaults, `70 / 40 / 'routine' / 'one_click'`, which are the behaviour before the settings existed. `PUT` with all four fields replaces them, **CCO only** (an admin gets `403`): `queuedFrom` a whole number from 1 to 90, `sampledFrom` from 1 to 80 and `<= queuedFrom` (the ceilings keep sampling and queueing of compliant mail from being switched off), `uncheckedFloor` a band, `sendFriction` `one_click` or `confirm_external`. The save and its audit row (`update`, `kind: 'compliance_settings'`, the before and after values) are one transaction in `firm_compliance_settings_save()`, so either both are written or neither is (`500`). The firm's other active internal CCOs are then notified (`compliance_settings_changed`, with the before and after values). The defaults and the allowed range are provisional until counsel signs them off (Issue #225, PL-13). `POST /outbox` reads them on every send and refuses with `503` when it cannot, rather than band with looser defaults. The thresholds band a compliant send's heat score, which is then dropped as before (#192); `uncheckedFloor` is the lowest band for a send the AI pass did not check (`llmChecked: false`). A send banded `queued` that goes out notifies each active internal CCO and admin other than the sender (`mail_queued_for_review`, content-free, linking to `/projects/{dealId}/mail?folder=held` when the send has a deal). With `confirm_external`, a send whose recipient boundary is not `internal` (including `unverified`) answers `409 { externalConfirmationRequired: { recipients } }` before any screen, AI call or record; the composer asks once and resubmits with `externalConfirmed: true`, which the send audit row records. The confirmation is asserted by the client, so it is a UX nudge, not a supervisory control: the audit's `externalConfirmed` is not evidence that a person confirmed. Migrations `20261020110000_firm_compliance_settings.sql` and `20261021140000_firm_compliance_settings_save.sql`.

## Deal recipient relationships (D60 / #172)

`POST /deals/:dealId/recipient-check` takes `{to,cc,bcc}` arrays (at most 20
addresses per field). Requires the mail flag and an active sender with deal
access; a sender with no access to the deal (including another tenant) gets the
unknown-deal 404 (D65), and an inactive account is denied (403). An external
sender, or one in research/trading, is not reviewed: the answer is 200
`{recipients: [], reviewed: false}` and the send goes on with the #171 boundary
warning only. Otherwise returns only submitted recipients as
`{field,email,relationship,boundary,requiresConfirmation,reason}` plus
`policyFingerprint` and `reviewed: true`, private/no-store. Lookup failure returns 503, never a
trusted empty result. An external recipient not on the deal comes back with
`reason: not_on_deal` and `requiresConfirmation: true` in `to`, `cc` and `bcc` alike
(D81, which reverses D67's exemption for `to`). This endpoint neither persists records nor screens with AI.

`GET /deals/:dealId/recipient-affiliations` and `PUT` require the onboarding flag
and a bank-side deal member manager. PUT accepts normalized email, companyId,
affiliation, representedCompanyId, exactly one userId/inviteId and expectedRevision
(null on first write). The four affiliations are client, client_advisor,
counterparty, counterparty_advisor. Advisors require a represented current party.
The transactional RPC validates tenant/deal/company/identity, increments revision
and audits atomically. Stale revisions return 409.

`POST /outbox` can return HTTP 200 `{recipientReviewRequired:{recipients,token}}`
before screening, transport or outbound insert. Explicit approval resubmits
`recipientApprovalToken`. The purpose-separated token expires after ten minutes
and binds actor/tenant/deal, message digest (including attachments) and policy.
Recipients are re-evaluated after screening. Content-risk approval remains separate.
Projectless sends preserve their existing behavior.

`POST /invites` optionally accepts `recipientAffiliation` and
`representedCompanyId` for supported external deal parties. Relationship and
invitation/existing-account grant commit atomically. Duplicate invites/grants do
not silently overwrite relationships; valid replacement invitations/regrants
update their prior relationship revision. Delivery must succeed before a pending
invitation can establish a recipient relationship. Current party, first-director,
domain confirmation and permission rules still apply. Unsupported new advisor
firms require separate company/party setup; this slice does not close #172.

Each recipient also carries `knownToDeal: boolean` (D85, Issue #378): true for a verified outsider already on mail sent on this deal (`outbound_messages`, status `sent`, newest 1,000). A known recipient needs no second approval; history clears only an address with no affiliation on the deal (never a counterparty, an unverified or lapsed relationship, a colleague off the deal or an address the firm's domains cannot place). Known status is part of `policyFingerprint`. The send audit detail gains the optional `recipientOverride: true` (a recipient needed approval and the sender approved) and `knownRecipientsAdded` (Issue #429).

## Deal discovery (`deal_discovery`)

The first routes in `/api/v1` that read under RLS as the primary gate
([ADR-0018](../07-decisions/ADR-0018-deal-discovery.md)). Every
discovery route checks the `deal_discovery` flag first and returns `404` when
it is off (the exceptions are the two withdrawals, below), then authenticates with `requireApiUserScoped()`
(`src/lib/api/v1/httpScoped.ts`): the same session, MFA and onboarding checks
as `requireApiUser`, but it hands back the caller's own session client and no
service-role client. ESLint forbids `createSupabaseAdminClient` and
`requireApiUser` under `src/app/api/v1/discovery/**`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/discovery/candidates` | session (RLS) | The proposed deals the caller can see: `{ candidates: [{ id, name, codename, parties: [{ name, domain }], firstSeenAt, lastSeenAt, evidenceCount, ownEvidenceCount }] }`, most recent evidence first |
| GET | `/discovery/google-mailbox` | session (`deal_discovery` on) | A Gmail member's own mailbox source, after the one-click opt-in: `{ connected: false }` or `{ connected: true, address, group, domain, paused, waitingForGroup }`. There is no Gmail connect step: `POST /discovery/mailbox-consent` creates the Google source for a Google-domain member (and notifies the firm's admins with `mailbox_connected`), and this reports what the card still needs. `group` and `domain` come from the Google reader registration (the bank-owned ingest group the member must be in), `paused` is a firm admin's pause, and `waitingForGroup` is the guard's own last refusal (`not_in_provider_group`, from `mailbox_guard_state`), which clears with the first pass that reads. The group is not a database fact, so `reading` on the consent status can be `true` while `waitingForGroup` is `true`: the card never says it is reading while the group refuses. `discovery_google_mailbox_status()` acts on `auth.uid()` only and returns no mail |
| GET | `/discovery/health` | session (RPC) | Ingestion health of the caller's tenant, for an active, internal firm `admin` or the control room (`cco`) seated in the firm the tenant's reader registration names, and nobody else (another bank's admin, or a suspended, external or unseated admin, gets `404`). While the registration names no firm (none yet, or one written before the firm was set) an active, internal `admin` or `cco` of the tenant gets the no-registration shape instead, `registration: null`, no sources and zero totals, so the panel never disappears for the admin who has to finish registering. `{ health: { registration, registrations: [{ provider, status, consentedAt, delegationStatus, delegationCheckedAt }], allowlist: [{ provider, status, missingCount, extraCount, checkedAt }], sources: [{ id, kind, provider, address, status, archived, ownerAssigned, checkpointState, backfillCompletedAt, checkpointUpdatedAt, checkpointAgeSeconds, lastSyncedAt, lastError, lastErrorAt, waitingFor, itemsLedgered, itemsRouted, itemsSkipped }], viewerCanManageSources, reconciliation: 'not_built', totals } }`: counts and sync state, never content. The no-registration shape carries the new keys empty (`registrations: []`, `allowlist: []`, `viewerCanManageSources: false`) |
| GET | `/discovery/mailbox-consent` | session (not flag-gated) | The caller's own mailbox opt-in status: `{ eligible, reason?, consented, staleConsent, since?, address?, reading, readingReason }`. `reason` is `no_invite` (no accepted own-firm invite and live seat) or `domain` (the invite address is outside the registered mail domains of every reader provider, or of the firm those registrations name). `consented` is the open consent on the caller's **current seated invite**, the one the guard reads. `staleConsent` is `true` only when the caller holds an open consent and none is on the current seated invite (an older invite after a re-invite, or no seat at all); the card then offers Connect and still offers "Stop reading", so a consent is never out of the member's sight. `reading` is database eligibility: `true` exactly when the guard allows the seated address for the caller as its owner (the consent is on the seated invite, and a source exists for the address, is owned by the caller and is active), and it does not promise that a pass has run. Otherwise `readingReason` is the guard's reason (see below); consent alone is not reading |
| POST | `/discovery/mailbox-consent` | session (`deal_discovery` on) | "Connect my mailbox": calls `mailbox_consent_grant()` under the caller's session, then returns the status. `403 not_eligible` when the caller has no live seat from an accepted invite or is off the registered domain. The opt-in also **creates the caller's mailbox source** when none exists, or **adopts** one that has no owner and no stored items (an ownerless one that holds items is archived instead; see below) |
| DELETE | `/discovery/mailbox-consent` | session (not flag-gated) | "Stop reading my mailbox": calls `mailbox_consent_withdraw()` (needs no eligibility, always reachable), which also deletes the mail stored from the caller's mailbox (#461, below), then returns the status plus `purged`: the purge's counts, or `null` when the caller had no mailbox source to purge |
| GET | `/discovery/sites` | session (firm admin or CCO) | The open SharePoint site registrations of the caller's firm: `{ sites: [{ address, registeredAt, registeredBy, stale }] }`. `stale` is `true` when the registrant no longer stands (see below), and the site is not read until a firm admin registers it again. `403 not_authorized` for anyone else |
| POST | `/discovery/sites` | session (firm admin) | Register a site for deal discovery: body `{ address }` (a Graph site id `host,guid,guid` or `host:/sites\|teams/path` on a `sharepoint.com` host, at most 400 characters), calls `site_register()` (which replaces a stale registration), then returns the list. `400` for a missing, oversized or malformed address, `403 not_authorized`, `409 registered_by_other_firm` |
| DELETE | `/discovery/sites` | session (firm admin, not flag-gated) | Stop reading a site: body `{ address }`, calls `site_unregister()` (only the caller's own firm's registration), then returns the list. Always reachable, like mailbox withdrawal, so an admin can stop a site while `deal_discovery` is off |
| PATCH | `/discovery/sources/{sourceId}/status` | session (firm admin, not flag-gated) | A firm admin pauses or resumes a Google mailbox source of their own tenant: body `{ status: 'active' \| 'paused' }`, calls `discovery_set_mailbox_source_status()` and returns `{ id, status, changed }`. A paused source is refused by the guard (`source_paused`) and never read, but a pause never deletes it: items and provenance stay, and resuming reads on (its owner's consent ending still deletes it, #461). Only a real change is audited (`discovery.mailbox_access_changed`, `change` `paused` or `resumed`, no mail). Google sources only. Every refusal is one `404` (no such source, another tenant's, an archived source, a Microsoft source, or a caller who is not the firm's admin), so the caller learns nothing about which. Not gated by `deal_discovery`, like withdrawal: a control that stops reading is always reachable. An archived source is never reopened by a resume |
| POST | `/discovery/sources/{sourceId}/restart` | session (firm admin, not flag-gated) | A firm admin restarts a halted mailbox source of their own tenant (reader liveness): calls `discovery_restart_mailbox_source()` and returns `{ id, restarted: true }`. A source halts with `last_error` `history_window_exceeded` and is then neither queued nor read; the restart clears the halt and the stored cursor, so the next tick reads the mailbox again from the start (dedupe drops what is already stored). Halted sources only, any provider, never an archived one; `status` is untouched, so a paused source stays paused. Audited as `discovery.mailbox_access_changed`, `change` `restarted` (no mail). Every refusal is one `404` (no such source, another tenant's, an archived or not-halted source, a source restarted in the last 24 hours, or a caller who is not the firm's admin). Not gated by `deal_discovery`: a recovery control is always reachable |
| POST | `/discovery/mailbox-sources/unify` | session (firm admin, `deal_discovery` on) | Merge an archived mailbox source into the live source of its address: body `{ archivedSourceId, targetSourceId }` (both UUIDs), calls `discovery_unify_mailbox_sources()` under the caller's session and returns `{ archivedSourceId, targetSourceId, moved, alreadyLinked, candidatesRefreshed }`. Only an active, internal firm `admin` seated in the bank's own firm may call it (`403 not_authorized`); both sources must be the caller's tenant's (`404 unify_source_not_found`). `409` with `unify_not_archived`, `unify_already_unified` (the archived source has no stored items left to move), `unify_address_mismatch` (it was archived from another address), `unify_target_not_active` (the target is paused), `unify_provider_mismatch` (the target is on another provider than the archived source) or `unify_target_not_allowlisted` (the target's owner is not seated and opted in). The RPC checks `deal_discovery` itself too and answers `404` when it is off. `400` for a missing or malformed id. Audited as `discovery.mailbox_sources_unified` |
| GET | `/discovery/team-mailboxes` | session (firm admin, `deal_discovery` on) | The firm's open team inboxes (#581), oldest first: `{ teamMailboxes: [{ id, address, provider, connectedAt, checkStatus, checkReason, checkedAt, lastCheckError, sourceId, sourceStatus, backfillSince, removable, members, eligible }] }`, from `discovery_team_mailboxes()`. `checkStatus` is `pending`, `verified` or `refused` (with a `checkReason`); `lastCheckError` is a transient failure that never changes the status; `removable` is `true` while its source holds no mail, verified or not. `readRefusal` is the worker's last refused read of the inbox (a fixed refusal code) or `null`; `not_in_provider_group` means the address is not a direct member of the ingest group, so a Ready inbox is not read. Anyone but the firm's admin gets the same `404` as when the flag is off. No mail |
| POST | `/discovery/team-mailboxes` | session (firm admin, `deal_discovery` on) | Connect a Gmail team inbox: body `{ address, attestationVersion, backfillSince? }` (`attestationVersion` is the version of the firm-mailbox text the admin ticked, currently `1`; `backfillSince` is `YYYY-MM-DD` within the last 730 days), calls `discovery_connect_team_mailbox()` under the caller's session and returns `201 { teamMailbox }`, or `200 { teamMailbox }` for an inbox that is already connected (no write, no audit). `400` for a malformed body, `403 not_eligible`, `409 person_address` (a user, an invite or a personal source holds the address), `422` with `provider_unresolved`, `provider_unsupported` (Microsoft), `out_of_range`, `invalid_address` or `attestation_required`. Audited as `discovery.team_mailbox_connected` with ids only; the admins and the CCO of the inbox's own firm company are notified (#173). Nothing is read until the worker has verified the address |
| DELETE | `/discovery/team-mailboxes/{teamMailboxId}` | session (firm admin, not flag-gated) | Remove a team inbox whose source holds no mail, verified or not (for example a deals@ that is a group, or a typo): calls `discovery_remove_team_mailbox()` and answers `204`. The registration is closed and its source archived; the address can be connected again. `409 not_removable` for a registration that holds mail. One `404` for every other refusal (no such registration, another firm's, one already closed, or a caller who is not the firm's admin). Audited as `discovery.team_mailbox_disconnected` with ids and the reason |
| POST | `/discovery/team-mailboxes/{teamMailboxId}/members` | session (firm admin, `deal_discovery` on) | Let a colleague read a team inbox (#581): body `{ userId }`, calls `discovery_add_team_mailbox_member()` under the caller's session and returns `201 { member }`, or `200 { member }` for a person who already is a member (no write, no audit). `member` is `{ userId, name, email, addedAt }`. The person must be an active, internal colleague seated in the inbox's firm who is not a firm admin (`eligible` in the list); anyone else, the caller included, is `422 not_eligible_member`. `400` for a malformed body or id. One `404` for every other refusal (no such inbox, another firm's, one already removed, a caller who is not the firm's admin, or the flag off). The tenant's discovery lock is taken before anything is written, so adding a person while the inbox is being read cannot deadlock. Audited as `discovery.team_mailbox_member_added` with ids only. A membership grants nothing by itself: what a member sees follows from the visibility rules |
| DELETE | `/discovery/team-mailboxes/{teamMailboxId}/members/{userId}` | session (firm admin, not flag-gated) | Take a person off a team inbox: calls `discovery_remove_team_mailbox_member()` and answers `204`, whether or not the person was a member. The membership row is closed (`removed`), never deleted, and the person's deals and deal memberships are untouched. A person who loses their seat in the firm is closed by a trigger with `seat_lost`, and removing the whole inbox closes its members with `disconnected`. One `404` for every refusal (no such inbox, another firm's, one already removed, or a caller who is not the firm's admin). Audited as `discovery.team_mailbox_member_removed` with ids and the reason |
| PUT | `/discovery/sources/{sourceId}/window` | session (firm admin, `deal_discovery` on) | A firm admin sets how far back a Gmail mailbox source's first read goes (#353): body `{ since: 'YYYY-MM-DD' }`, a UTC date no later than today and no earlier than 730 days before it, calls `discovery_set_mailbox_source_window()` and returns `{ id, backfillSince, changed }`. Only before the first read: once a delta checkpoint, a started backfill or a completed backfill is recorded the window is fixed (`409 window_locked`, the health payload's `windowLocked`); a restart opens it again. `400` for a malformed date and `out_of_range` for one outside the bounds. Only a real change is audited (`discovery.mailbox_access_changed`, `change` `window_set`, with `from` and `to`, no mail). Google mailboxes only. Every other refusal is one `404` (no such source, another tenant's, an archived or Microsoft source, or a caller who is not the firm's admin; the control room sees the window and cannot change it). Gated by `deal_discovery`, unlike pause and restart: it widens reading rather than stopping it |
| GET | `/discovery/deal-email/thread` | session (RLS, `deal_discovery` on) | The thread pane of the Deal email view (#339): `?deal=<code>&item=<sourceItemId>` answers `{ conversationId, messages: [{ sourceItemId, sentAt, from, to, cc, subject, body, internetMessageId, fromSelf }], replyToken }`, oldest first, at most the newest 50. The thread is the deal-linked messages sharing the item's `conversationId` (the RFC 5322 References root) that the caller's **own** connected mailbox holds (`discovery_own_mailbox_items()`); a colleague's message in the conversation is left out, and so is an item from a team inbox the caller reads as a member (PR #614), until there is a decision on replying from a personal address into a team conversation. Subject and participants come from `discovery_item_metadata()`, the body from `source_item_texts` (owner-only RLS): the top of each message, quoted history dropped. An unknown or unseen deal, an item not linked to the deal and an item the caller does not own all answer the same `404`. `fromSelf` marks a message sent from the caller's sign-in address or their connected mailbox's address. `replyToken` is the server-signed threading of a reply to the newest message (`src/lib/email/replyToken.ts`, bound to the caller and the deal, 12 hours, carrying the thread's participants); the pane's composer echoes it to `POST /outbox` with the deal code, so the outbox takes `In-Reply-To` and `References` from it and reads no mailbox data. A reply that adds anyone outside those participants goes out unthreaded, and its `screen` and `send` audit rows record `replyRecipientsOutsideThread: true`; both rows carry `replyToSourceItemId` |
| GET | `/discovery/team-mailboxes/audit` | session (firm admin or CCO, `deal_discovery` on) | The audit trail of the caller's own firm company's team inboxes (#173 G-03), newest first: `?view=access\|reads\|reads_notable&before=<ts>,<id>&limit=` answers `{ inboxes: [{ id, address, open }], rows: [{ id, ts, action, actorType, actorName, serviceIdentity, subjectName, inboxId, detail }], next }`, from `discovery_team_mailbox_audit()`, a security definer read bound to `auth.uid()` (the rows are service rows that `audit_log_select` hides by design). `access` (the default) is connected, checked, access given or removed, pause, resume, restart, first-read window, removed, refused reads, Google ingest-group drift (a firm event, `inboxId` null, only for the company holding the Google registration), the deals firm rules proposed from the inbox's mail, the AI proposal passes over the inbox, the rule detector passes over it (#173 G-07; `items` and `events`, never the run id), and the owner's capability switches for the caller's firm company (a firm event, `inboxId` null); `reads` is every reader pass of its sources; `reads_notable` the passes that stored or excluded mail or did not complete, and starts with no finish after an hour. `detail` is ids, fixed codes and counts only, never an address or the drift lists; the address is in `inboxes`, and `null` once a registration is closed. `next` goes back as `before` (URL-encoded, timestamp exactly as returned); `limit` is clamped to 1..200. `400` for an unknown view, a malformed or half cursor or a non-integer limit. Anyone but an active, internal admin or CCO seated in a firm company that holds a team inbox, open or closed, gets the same `404` as when the flag is off. No mail |
| GET | `/discovery/candidates/{candidateId}` | session (RLS, `deal_discovery` on) | One proposed deal in full, as the caller may see it: `{ candidate: { id, name, codename, parties, firstSeenAt, lastSeenAt, evidenceCount, ownEvidenceCount, state, station, milestones, evidence, items, decisions, override, canAct, canResolve, mergedInto, origin, modelProposal } }`; a candidate the caller cannot see is `404`. `origin` is `'model_proposal'` when the model found the deal (an accepted model proposal, or the survivor of a merge that took one in) and `'rules'` otherwise; the cluster key behind it never leaves the server. `modelProposal` is `{ requestId, stepId, phase, placed, of }` (the station the model proposed when the owner accepted, and how many of its emails it placed in that phase) for the mailbox's owner only, else `null`; it holds ids, a step id and counts, no name or message. An accepted proposal also adds an `accept_proposal` entry to `decisions`, with `after: { requestId, found, requested }` | #173 G-02b |
| GET | `/discovery/suggestions` | session (RLS, `deal_discovery` on) | What the evidence says about a promoted deal's station, for the rail's marker: `?deal=<code>` answers `{ suggestion, origin }`. `suggestion` is null when the deal has no assessment or the caller cannot read it. `origin` is `'model_proposal'` when the deal was promoted from a candidate the model found (or the survivor of a merge that took one in), else `'rules'`, and is `'rules'` for a deal the caller cannot read, so the answer is the same as for a missing deal. The marker offers no one-click Move on a model-origin deal | #173 G-02b |
| GET | `/discovery/model-proposals` | session (RLS, `deal_discovery` and `discovery_model_proposals_demo` on, `404` before authenticating) | The demo-only model-proposed deals the caller can see, grouped by deal key: `{ proposals: [{ dealKey, name, candidateId, phase, emails, firstSentAt, lastSentAt, parties, promoted, actionable, proposed, accept }], dismissedCount }`. `actionable` is true only when every row of the group is on a personal mailbox the caller owns. For an actionable `m:` group, `proposed` is `{ stepId, phase, placed, of }` (G-02b #173): the station the model proposes (the first station of the group's highest phase), and how many of the group's `of` distinct emails the model placed in that phase; `accept` is `{ state: 'pending', requested }` while a request is being read (`requested` is the emails to read again), `{ state: 'failed', code }` once the newest request ended without a candidate (`code` is `none_readable`, `source_unavailable`, `candidate_closed` or `error`), else null. A `c:` group and a group with team-inbox rows get null for both. A `c:` group also carries `origin` (G-02b #173): `model_proposal` when its candidate was made by an accepted model proposal or one was merged into it (read through `discovery_candidate_origins`), `rules` otherwise, and null when the origin read cannot say (an `m:` group also gets null). The cluster key never leaves the server. |
| POST | `/discovery/model-proposals/accept` | session (`deal_discovery` and `discovery_model_proposals_demo` on, `404` before authenticating) | Accept an `m:` model proposal as a proposed deal with no station (G-02b #173): body `{ dealKey: 'm:<slug>', proposedStepId }`, the group's key and the station `proposed` showed for it. Calls `discovery_accept_model_proposal()` under the caller's own session, which only records one request per source the caller owns; each source's next SYNC job reads the emails again through the mailbox guard and keeps the ones still admitted. Answers `202 { operationId, requestCount }`: `requestCount` is the requests recorded now, `0` with the same `operationId` for a repeat or a second tab. `400` only for a malformed body, a `c:` key, a step id that is not well formed, or more than 500 rows (`22023`); `401` with no session; `403` "Needs deal-create authority" (`42501`) when the caller may not create deals on the firm's bank, checked before any row is read, so it says nothing about the key; `404` (`P0002`) unless the caller owns a personal source holding a live, undismissed row of the key; `409` for a lock timeout (`55P03`) and, with `code: 'candidate_closed'`, when the proposal's candidate was rejected or merged into a survivor that is no longer open (`55000`), or, with `code: 'proposal_changed'`, for a well-formed station other than the group's proposed one, the canonical first station of its highest phase (`22023 invalid_proposed_step`; usually the proposal moved phase since the list was read); `500` otherwise, logged by SQLSTATE only. Every refusal is a fixed text: neither a response nor a log line carries the key, which is a slug of a mail-derived name. Audited as `discovery.model_proposal_accept_requested` (ids, the step id and counts only). |

`origin` on both reads comes from two session definers, not from the candidate rows the caller's RLS shows (`20261023140400_discovery_origin_read.sql`: `discovery_candidate_origins(uuid[])`, at most 200 ids, and `discovery_deal_origin(uuid)`). They answer for a candidate the caller can see or whose deal they sit on or oversee, and for a deal they sit on or oversee, and follow merges past RLS, so a deal member or overseer who is not the finder, and a viewer who cannot see a merged-away model candidate, are told `'model_proposal'` too. A failed or missing origin read is never `'rules'`: the candidate detail and the suggestions read answer `500` (the suggestions route's `'rules'` for a deal the caller cannot read carries no suggestion, so the marker has nothing to move).

`/discovery/mailbox-consent` is gated by `deal_discovery` for `POST` only (connect
is `404` while the flag is off). `GET` and `DELETE` are never gated: withdrawal is
always reachable, so a member who consented can see it and stop it while the flag
is off, and `/profile` keeps its card for that member (it offers "Stop" only, never
connect, while the flag is off). The classification worker reads the flag too and
reads nothing for the tenant while it is off (`runOnce` returns
`status: 'skipped', reason: 'flag_disabled'`). Its three verbs run only under the caller's session: the RPCs act on
`auth.uid()`, audit every change (`discovery.mailbox_consented`,
`discovery.mailbox_consent_withdrawn`) and never expose the allowlist views.
Reading starts on the pass after connecting and stops on the pass after
withdrawing (`20261001130000_mailbox_allowlist.sql`, `20261001140000_mailbox_consent_status.sql`).
An opt-in is the owner's own act: no role can insert a consent except through
`mailbox_consent_grant()` inside the owner's session (the service role has no
`INSERT` privilege and a trigger refuses any writer whose `auth.uid()` is not
the consent's owner). Ending a consent has three causes: the owner withdraws,
the owner loses the seat (`reason: seat_lost` in the audit row), or the invite
is deleted (`reason: invite_deleted`; a `before delete` trigger withdraws the
open consent first, so the audit log never shows an opt-in with no end).
Pausing the registration (disabling it, narrowing its domains, naming another
firm) does not end a consent: restoring it admits the mailbox again with no new
opt-in, by design. A voluntary withdrawal is always audited as
`reason: withdrawn`, including while the registration is paused (it states the
reason itself instead of reading the seat).

The opt-in creates the mailbox source (`mailbox_consent_grant()`, the only place a
source comes from a member's act). When the tenant has no `content_sources` row of
kind `mailbox` for the invite address, the grant inserts one: active, owned by the
caller, on the provider whose registration lists the address's domain and names the
caller's company (today `microsoft`). It is created once: a second grant finds the
row and creates nothing. A withdrawal deletes the source (#461, below, under the
pilot retention policy), so a re-consent after one creates a fresh source. A row with **no
owner and no stored items** is **adopted** (one that still holds items is archived, see
below): the grant sets its owner to the caller, because the address
is the caller's own (proven by the invitation they accepted) and the guard refuses
an ownerless source `owner_mismatch`, so an opt-in that left it alone would report
a read that never happens. Adoption sets the owner only; the row's status and
provider are left as they are. A row owned by someone else is never touched,
whatever its status or provider, and is refused `owner_mismatch` by the guard until
an operator fixes it. When more than one provider could read the address, no
source is created and the operator picks the provider. Withdrawal deletes the
caller's own source and the mail stored from it, unless the tenant's retention
policy keeps content on disconnect (#461, below). The RPC's result is
`{ consented, since, address, sourceId, sourceCreated, sourceAdopted, archivedSourceId, reading, readingReason }`
(`sourceId` is `null` when no source exists or none could be chosen), and the
`discovery.mailbox_consented` audit detail carries `sourceId`, `sourceCreated` and
`sourceAdopted` next to `consentId`, `inviteId` and `address`; there is no separate
audit action for the source. The HTTP route returns the status, not the RPC result.

`readingReason` (`mailbox_reading_reason()`, the same verdict for the grant and the
status) is `null` when `reading` is `true`, else the guard's own reason (see the A3 paragraph
below): `no_source`, `no_consent`, `owner_mismatch`, `source_paused`, `registration_inactive`,
`external`, `seat_inactive` or `domain`, plus `no_invite` (no seat) and `not_on_a_deal`, which
describe the member and not the address. The profile card says "You're connected. Conductia
reads your mailbox when your firm's reader runs." only when `reading` is `true`; for any other
reason it names the step the firm admin takes. The guard also binds the source's
**current owner** on every call, for every purpose: a source whose
`owner_user_id` is not the allowlisted user (changed mid-backfill, cleared, or never
set) is refused `owner_mismatch`, so the reader's page-by-page check stops the old
owner's pass.

`/discovery/sites` is the SharePoint counterpart (`20261001180000_site_allowlist.sql`,
design R23): a `sharepoint_site` source is read only while an active, internal
firm admin of the bank's own firm holds an open registration for its address
and the tenant's reader is active. There is no per-user consent. Listing and
registering sit behind the `deal_discovery` flag; unregistering never does
(withdrawal is always reachable). It runs only under the caller's session, and every
registration and unregistration is audited (`discovery.site_registered`,
`discovery.site_unregistered`). A registration is the admin's own act too: a
trigger requires `registered_by` (and `unregistered_by`) to be the session's
user, and the service role has no `INSERT` privilege on the registry. The
registration page is follow-up work; until then the route and the RPCs are the
interface. A registration is open only while its **registrant** still stands where
the validator required them to stand when they wrote it: an active, internal admin
seated in the registered firm. `allowed_sites` joins the registrant on every read,
so a registrant who is suspended, removed from the firm, made external or stripped
of the admin role closes the site at once (the guard refuses it, RLS drops its
items from members, the CCO keeps the metadata). The registration row stays open,
so restoring the registrant reopens the site, and the listing flags it `stale`. A
stale registration is also treated as absent by `site_register()`: the next firm
admin of the same firm to register the site closes the stale row in their own name
(`unregistered_by` is the caller, which the registry's validator requires, so the
close is bound to the caller) and inserts a registration of their own. Both are
audited: `discovery.site_unregistered` carries `reason: registrant_lost_standing`
and the lapsed registrant as `registeredBy`, then `discovery.site_registered`.
A registration by another firm still answers `409 registered_by_other_firm`.

An address that changes hands never hands over the earlier holder's stored items
(`20261001130000_mailbox_allowlist.sql`, audit round 3, H1). The visibility rule treats
the items attached to a source as its owner's, so when a member opts in and the address's
source has no owner but still holds provenance rows, `mailbox_consent_grant()` **archives**
that source instead of adopting it: it is renamed `<address>~xyz` (three random
`[a-z0-9]`, retried on the unique index), paused, stamped with `archived_at` and
`archived_from_address`, and left ownerless, so no worker pass and no guard check reads it
and no one owns its items. The member gets a **fresh** active source, owned by them, with
no checkpoint, and the grant result and the `discovery.mailbox_consented` audit detail carry
`archivedSourceId`; the archive is audited as `discovery.mailbox_source_archived` in the
member's name. A source with no stored items is still adopted as before. The only way the
history reaches anyone is `POST /discovery/mailbox-sources/unify`: a firm admin merges the
archived source into the live source of the address it was archived from. The target's
owner must be seated and opted in. Links the target already holds are not duplicated, the
affected candidates' visibility is rebuilt, and the archived row stays paused and ownerless
under its `~xyz` key with nothing left on it, which is also why a second merge of it is
refused (`unify_already_unified`). The merge is a decision that the member now holding the
address may read what the earlier holder's mailbox stored; it is audited with the admin as
actor.

**One click needs a deal (`20261001130000_mailbox_allowlist.sql`, round 3, A2).**
`mailbox_consent_grant()` is the single back-end step for every provider. On top of the seat
and the registered domain it requires the caller to be `md` or `deal_team` on at least one
deal of their own tenant (`deal_memberships`, which holds a row only while the membership
stands; a membership on another tenant's deal does not count). Otherwise it answers
`403 not_eligible` with nothing written or audited, and the status reports `eligible: false`
with `reason` and `readingReason` both `not_on_a_deal` (the status `reason` is now `no_invite`,
`domain` or `not_on_a_deal`). The check is a **grant-time precondition only** (D68, a choice the
owner can flip): it is not part of `mailbox_guard_check`, so a member who has consented and
later leaves every deal is still read until they withdraw or lose the seat. For that member the
status keeps `eligible: false` and the reading fields follow the ordinary ladder, and
`readingReason: not_on_a_deal` appears only while there is no open consent. Each time the grant
binds a source for the member (created, taken over, or fresh after an archive) every active,
internal firm `admin` of the tenant, and the CCO seated in the firm, gets one `mailbox_connected`
notification (`payload`: `address`, `outcome` of `created`, `taken_over` or `archived_previous`, `sourceId`,
`provider`, and `archivedSourceId` after an archive; no mail content). A repeat grant, or a re-consent over the member's own source, sends
none. Taking over an ownerless source with no stored items also clears its `delta_checkpoint` and
sync state (`backfill_completed_at`, `checkpoint_updated_at`, `last_synced_at`, `last_error`,
`last_error_at`), so the new holder backfills afresh and inherits no resume point.

**`reading` is database eligibility, from one decision (`20261001130000_mailbox_allowlist.sql`,
round 3, A3).** `mailbox_guard_verdict()` decides why an address may not be read, in one order:
`no_source` (no mailbox source for the address, before any other test), `provider_mismatch` (only
when a caller names its provider; a member's status names none), then, for an allowlisted mailbox,
`owner_mismatch` (the source has no owner or another owner, or the caller is not the allowlisted
owner) and `source_paused` (the source is not active), and, for one that is not allowlisted,
`registration_inactive`, `no_invite`, `external`, `seat_inactive`, `domain` and `no_consent`.
`mailbox_guard_check` returns it (and adds the worker's provider-group reason, which is not a database
fact, only when the database allows the read), and `mailbox_reading_reason()` reports it to the member
with the member bound as the owner, so `reading` is `true` exactly when the guard allows and the two
cannot disagree: with no consent and no source the status says `no_source`, as the guard does. The field
keeps its name, but it says a read is permitted, not that one has happened: the worker's group mirror and
flags are outside the database, so the card says "You're connected. Conductia reads your mailbox when your
firm's reader runs." Three reasons are about the member and stay outside the verdict: `domain` (seated on
a domain no provider lists; the guard says `no_source` when no source exists), `not_on_a_deal` (no open
consent and no MD or deal team role on a deal; a grant-time precondition the guard never tests) and
`no_invite` (the caller has no seat, whatever the guard's cause). `multi_provider`, `no_owner`,
`other_owner`, `paused` and `provider` are retired as readingReason values: `no_source`,
`owner_mismatch`, `source_paused` and the source's own provider's `registration_inactive` replace them.
A paused source is now refused `source_paused` by the guard for every purpose (the worker used to skip
it alone), a narrowing that admits nothing new. A SharePoint site whose open registration has a registrant
who no longer stands (suspended, removed from the firm, external or not an admin) is refused
`site_registrant_lost` by `site_guard_check`, before `site_wrong_firm`, and audited with that reason.

**Round 4: the archive and the merge, tightened (`20261001130000_mailbox_allowlist.sql`, audit 4).**
Notifications: `mailbox_connected` goes to the firm's active, internal admins and to the CCO seated in a
firm company (the drift notification's seat predicate), never to a CCO of a second bank or a counterparty,
nor to a suspended or external one; after an archive its payload also names `archivedSourceId`, so an
admin can find the history to merge, and an archive that leaves the member with no fresh source (below)
notifies too. The fresh source after an archive takes the archived row's provider only while a registration
of that provider may still read the address (it is in `mailbox_reader_providers`); otherwise the one
provider that may; and when several may and the old one is none of them, no source is created and the
operator picks, as when no row existed (the archive and the consent still stand, the guard says `no_source`).
An archive also forgets the guard's last refusal for the address (`mailbox_guard_state`), so the new
holder's first refusal is audited rather than deduplicated against the earlier holder's. The merge now
refuses a target that is not `active` (`unify_target_not_active`: its owner would see the items through RLS
while the guard says `source_paused`) or not on the archived source's provider (`unify_provider_mismatch`),
both `409`, and the RPC repeats the route's `deal_discovery` test (`unify_discovery_disabled`, answered `404`
like the flag-off route; it fails closed when the flag has no row, and a caller who is not a firm admin is
still told `not_authorized`, never the flag). The archived source keeps its `routing_ledger` rows: they hold
a hash and a decision per item, never content, record what the earlier holder's mailbox read, and are not
moved by the merge, so the fresh source's own ledger starts empty and its first pass re-reads and re-ledgers
the mailbox; the ingestion health lists each source's own counts. The role check of the opt-in (MD or deal
team on a deal of the tenant) counts a deal in any status, `closed` included: `deal_memberships` holds a row for as long
as the membership stands, whatever the deal's status (`intake`, `active`, `paused` or `closed`), so a member
whose only deals have closed may still connect (a choice, kept by the owner; D68). The `last_reason` check of `mailbox_guard_state` is restated
after the table is created, so a database that ran an earlier version of the migration takes `source_paused`
and `site_registrant_lost`.

An archived source is closed to a worker that was already reading it: the database refuses, with `source_archived`
(`P0001`), a provenance link inserted for it and a write of its `delta_checkpoint`, `backfill_completed_at`,
`checkpoint_updated_at`, `last_synced_at`, `last_error` or `last_error_at`, so a page read before the archive or
the merge cannot refill the archive or restart its backfill. The archive step and the merge are not affected (the
archive stamps `archived_at` and writes none of those columns; the merge deletes links from the archived row and
inserts them on the live one). The worker reports such a source as skipped (`source_archived`) for the pass and
reads the rest. `scripts/m365/write-registration.ts` likewise never writes an archived source: its update is
conditional on the address it saw and on the row not being archived, and a write that matches nothing is applied
to the live source of the address, or creates it.

**Registering a reader (runbook).** The guard joins a mailbox to the tenant's
reader registration on two columns, `firm_company_id` (the bank's own company, of
type `bank`, in the same tenant) and `mailbox_domains`. A registration that has
neither reads nothing, and the control room shows no firm admin or CCO for it.
`scripts/m365/write-registration.ts` requires both (`firmCompany`, by id or name,
and `mailboxDomains` in its config) and `replay-discovery.ts` takes
`--firm-company` and `--mailbox-domains`. It also refuses a mailbox source with
`"ownerEmail": null`, because the guard never reads an ownerless mailbox; the
operator can pass `--allow-ownerless` (a warning is printed, and the member's
opt-in adopts the source), and a re-run that lists a mailbox with no owner keeps
the owner the source already has. There is no backfill migration: the
firm is the operator's statement and is never inferred. For a tenant registered
before #262, run the script again with the two fields, or set them once:

```sql
update graph_reader_registrations
   set firm_company_id = '<the bank company id>', mailbox_domains = array['bank.example']
 where tenant_id = '<tenant id>';
```

Allowlist drift (`discovery_record_allowlist_drift`) records each change in the
provider group's mirror, writes its audit row, and notifies the firm's seated
active, internal admins and CCOs. With none seated there is nobody to notify: the
audit row is the record, and no fallback recipient is chosen.

Who sees what (`supabase/migrations/20260925120000_discovery_core.sql`):

- A candidate is visible to the users whose own mailboxes or sites hold its
  firm or confirmed evidence (`candidate_visibility`), and to the control room
  (`firm_role = 'cco'`) of its tenant. A firm `admin` sees none.
- An item's metadata (`source_items`) is visible to its owners, to the control
  room, and through a firm or confirmed route to anyone who can see the
  candidate: a colleague's item is metadata only.
- An item's text (`source_item_texts`) is readable by its owners only.
- A tentative route, and the item behind it, is visible to the item's owners
  and the control room only, and never counts toward `candidate_visibility`.

Provenance and evidence rows are tenant-checked when written
(`source_item_sources_tenant_match`, `evidence_links_tenant_match`), and the
candidate policy re-checks item, source and candidate tenant on read, so a
foreign-tenant item never backs a candidate.

The classification worker (`worker/classify.ts`) writes every discovery row with
the service role and never serves a user request. `npm run seed:discovery`
registers the fixture reader for the dev tenant and runs it once; each fixture
owner opts in under their own session (it signs in with `SEED_PASSWORD`).

Ingestion (phase 4). `worker/classify.ts --serve` is a pg-boss consumer over
the `pgboss` schema (created by migration `20260925140000_pgboss_schema.sql`,
generated from the pinned pg-boss; the worker never migrates it). A scheduled
tick queues one sync job per active content source; a sync reads Graph pages
from the source's `delta_checkpoint` and writes the checkpoint after every
page, so a restart resumes without re-reading; a discover job per tenant then
clusters. `discovery_worker_enabled` pauses it without a deploy (as does
`deal_discovery`). Every page is read through the guarded reader
(`guardedContentSource`, #262): the mailbox or site guard is asked before each
page, so a withdrawal stops a backfill at the next page (it also deletes the
source and its checkpoint, #461, so a re-consent backfills afresh), and a refused source is reported, not retried or
recorded as a sync error. The live reader (`GRAPH_READER_PROVIDER=graph`) is
app-only with a certificate credential per bank tenant
(`graph_reader_registrations`), built only inside `src/lib/mailboxAccess/`
behind the reader capability; setup is `scripts/m365/README.md`. Its provider
group mirror (#275) lists the Exchange scope group the registration records
(`scope_group_id`) on every pass; with no group recorded, or an unreadable
one, no Microsoft mailbox is read (`mirror_unavailable`).

`GET /discovery/health` reads through `discovery_ingestion_health()`, a
`security definer` RPC that answers only an active, internal firm `admin` or
`cco` of the caller's own tenant, seated in the firm the registration names (42501,
answered as `404`, for everyone else). While the registration names no firm, such
an admin or `cco` gets the no-registration shape (`registration: null`, no sources,
zero totals) rather than `404`. It returns
each source's sync state (`not_started`, `backfilling`, `incremental`), last
sync, last error (a provider status and code, never a body), and ledger counts,
plus tenant totals. Per provider it also returns the reader registration (for
Google, `delegationStatus`: `ok`, `missing` for Google's `unauthorized_client`,
`error`, or null before a first token), the allowlist group drift as counts
(`missingCount`, `extraCount`; the member addresses stay in
`discovery_allowlist_health()`), and for each source its `provider`,
`checkpointAgeSeconds` and `waitingFor`: why the mailbox guard would refuse an
active, unarchived source now, which is `mailbox_guard_verdict()`'s live answer
and, only when that admits the read, the worker's provider-group refusal from
`mailbox_guard_state` (`not_in_provider_group`, `mirror_unavailable`); a paused or
archived source reports null. `archived` marks an orphaned source #262 closed for
good, which cannot be resumed. `viewerCanManageSources` is true for the firm's
admin and false for the control room, and `reconciliation` is `not_built`: it is
deferred and is never reported as clean. No subject, text, participant, party,
codename, group member address or raw checkpoint. The firm admin's `/discovery` page shows this panel only; the
control room sees it above the candidate list.

The health payload also reports the exclusion policy (#263, `20261003120000_discovery_exclusion_health.sql`):
`itemsExcluded` per source and in `totals`, and a top-level `policyVersion`. `itemsExcluded` counts ledger rows
skipped by the policy under every version it has had, all four `policy_*` reasons included (`policy_excluded_after_fetch`
too, which the ledger records as fetched and discarded), so it is a subset of `itemsSkipped`, never added to it.
`policyVersion` is the tenant's current version, or `null` when none was ever written. They are separate facts: the
panel shows "N excluded by policy" and, on its own line, "Exclusion policy vN", never "N excluded by policy vN". The
no-registration shape carries `policyVersion: null` and `itemsExcluded: 0`. Only these two numbers leave the function:
no rule id, domain, address, label, thread id or hash. `npm run discovery:export` writes `provider_thread_id`,
`policy_version` and `exclusion_rule` on each ledger row (format `conductia.discovery-export/v2`).

**Message ids are not trusted as identity.** A message's Internet message id
is written by its sender, so two different messages can arrive under one id.
The worker merges sightings only when the id and the content hash both match.
Otherwise the first message stored keeps the id, and the other is ledgered as
`skipped` with `skip_reason = 'id_collision'`: its text is not stored and its
mailbox never becomes an owner of the stored text. The collision row keeps two
numbers, never text: `collision_similarity` (cosine of the word counts of
subject and text) and `collision_length_ratio` (shorter over longer). Health
counts collisions as skipped. To see whether collisions are near-duplicates
(an external banner, a rewritten link) that could safely merge, read their
distribution with the service role:

```sql
select c.tenant_id,
       count(*)                                                              as collisions,
       percentile_cont(array[0.1, 0.5, 0.9]) within group (order by l.collision_similarity)   as similarity_p10_p50_p90,
       percentile_cont(array[0.1, 0.5, 0.9]) within group (order by l.collision_length_ratio) as length_ratio_p10_p50_p90,
       count(*) filter (where l.collision_similarity >= 0.9)                 as near_duplicates
from routing_ledger l
join content_sources c on c.id = l.source_id
where l.skip_reason = 'id_collision'
group by c.tenant_id;
```

**Ingestion window (#353).** A Gmail mailbox source's first read takes mail from `content_sources.backfill_since`
(a UTC date; null reads the whole mailbox). A new source gets 90 days before it was registered, and a source that
read before the window existed keeps the whole mailbox. Owner decision 2026-10-16: before the first read the firm
admin may move it with `PUT /discovery/sources/{sourceId}/window`, to any date from today back to 730 days before
today (UTC, `BACKFILL_WINDOW_MAX_DAYS`), and every change is audited with its `from` and `to`. After that the window
is fixed for the pass (`409 window_locked`). The reader pins the window it used into its checkpoint, so the
checkpoint is what was read and the column is what was asked for. Restart clears the lock, so a halted long read
can be paused, restarted, given a shorter window and resumed, once per 24 hours per source (the restart cooldown).
Ingestion health reports `backfillSince` (null for a Microsoft source, whose reader does not honour it yet) and
`windowLocked` per source; the control room sees both and changes neither.

**Ending a consent deletes stored mail (#461; `20261014120500_discovery_purge.sql`,
`20261014130000_discovery_purge_wiring.sql`, `20261014140000_discovery_purge_tenant.sql`,
`20261014150000_discovery_message_index.sql`, `20261014151000_discovery_message_index_export.sql`,
`20261014160000_tenant_retention_policy.sql`).**
The decision is Proposed (decision log D93); the content/index split, the retention policy
and the decommission path are owner decisions (owner, 2026-10-14). The procedure is the
runbook's [Deleting stored mail](../04-operations/discovery-worker-aws-runbook.md#deleting-stored-mail).
Every way a consent ends sets `mailbox_consents.withdrawn_at`, and a trigger on that update
detaches the owner's own mailbox source through `discovery_purge_identifiers` (provenance,
ledger and thread taints cascade, and under the pilot policy the mailbox's message-index
rows go), then collects:
each stored message no mailbox holds any more goes, with its text, evidence, milestones and
model calls, and so does each candidate left with no evidence, with its visibility,
assessments, recompute requests and corrections. A message a colleague's mailbox also holds
stays. A promoted deal stays; its mail-derived candidate goes. SharePoint documents are never
deleted, and a candidate a document still evidences is rebased on the remaining evidence.
Anything evidencing a deal under legal hold is skipped and counted (`heldSkipped`). The
causes are withdrawal (`reason: withdrawn`), seat loss, invite deletion and, new, group
removal (`reason: group_removed`: the worker withdraws a consent whose address successful
group checks first saw in its source's provider group and then saw missing for 72 hours, the
last check within the hour; an address never seen in the group is never withdrawn). `DELETE /discovery/mailbox-consent` returns `{ ...status, purged }`, where
`purged` is
`{ provenance, ledger, taints, indexRows, items, texts, evidence, milestones, modelCalls, candidates, corrections, heldSkipped }`
summed over the consents the call closed, or `null` when none had a source of the caller's
to purge or the tenant's policy keeps content on disconnect. Six audit actions carry ids,
counts and policy values only, never an address or a Message-ID: `discovery.mailbox_purged`
(per consent: `sourceId`, `consentId`, `reason`, `runId` and the counts),
`discovery.content_collected` (the worker's backstop, per tenant where something went),
`discovery.group_removal_held` (the group-removal breaker held a tenant: `due`, `open`, `maxShare`, `minDue`, once a day; for the pilot every group removal is held until an operator releases it, owner 2026-10-17),
`discovery.tenant_purged` (the operator's `scripts/discovery/purge-tenant.ts`),
`discovery.retention_policy_set` (each write of a tenant's policy: operator, reason, `{ old, new }`) and
`discovery.mailbox_retained` (a consent that ended under a policy that keeps content: `sourceId`,
`consentId`, `reason` and the policy values; the source is archived and nothing is deleted;
the banker's visibility rows stay, but the banker no longer sees those candidates).

The **message index** (`discovery_message_index`) is written when the worker stores a page,
one row per message per mailbox read and screened, routed or not, through
`discovery_message_index_record`, keyed by mailbox source and `message_key`: every provider id
the message was read under, the SHA-256 `message_key` of the Internet Message-ID (never the raw id,
owner 2026-10-17: the bank matches its archive by hashing its own Message-IDs),
the sent date, the content digest (`hmac-sha256:<64 hex>`, an HMAC of the content hash under a
key derived per tenant from `DISCOVERY_INDEX_DIGEST_KEY`, `src/lib/discovery/indexDigest.ts`;
owner, 2026-10-17), the candidate and deal link
(`discovery_message_index_link`, refreshed after each discover run and before any purge),
category tags (`mnpi`, `promissory`; never the matched term), the rules version
(`DISCOVERY_RULES_VERSION`, `src/lib/discovery/rulesVersion.ts`) and `processed_at`. No
subject, body, participant or address. It serves a per-deal regulator export (not built yet)
and the worker's skip rule: a message this mailbox already indexed and linked to a candidate
or deal, with the same digest and rules version, is not routed or stored again and is counted
as `unchanged`, outside `itemsRead`; it runs only on delta passes after a completed backfill,
unrouted mail is always routed again, and a re-read (`SyncOptions.reread`) never skips.

The **retention policy** is one row per tenant in `tenant_retention_policies`
(`lifecycle`, `content_on_disconnect`, `index_on_disconnect`, `index_at_tenant_end`),
read through `tenant_retention_policy()`; a tenant with no row has the pilot values (delete
content and the index at disconnect; at tenant end, export the index into the purge report,
then delete it). It is written only through `tenant_retention_policy_set()`, which requires an operator identity and a reason, by operator SQL with no route and no UI; `service_role` reads the table and cannot write it directly. The tenant
purge returns the policy and the index (`messageIndex`, minus rows legal hold keeps) for
its report. The service-role functions are `discovery_collect_orphans`,
`discovery_collect_orphans_all`, `discovery_withdraw_group_removed`,
`discovery_message_index_record`, `discovery_message_index_link`,
`tenant_retention_policy` and `tenant_retention_policy_set`; none is reachable from a browser
session. `discovery_purge_tenant` is not among them: only the database owner executes it, as
the operator's `purge-tenant.ts` connection. D68's Q1 carve-out (the
CCO keeps a mailbox's metadata after it leaves the allowlist) no longer applies once a
consent ends under the pilot policy, because nothing of the mailbox is left; it still applies
to a paused source, an inactive registration and the group-removal grace.

**Team inboxes (#581; [ADR-0026](../07-decisions/ADR-0026-team-inbox.md), [guide](./team-inbox-guide.md)).** The five `/discovery/team-mailboxes` rows above are the whole admin contract; the worker and the database do the rest, with no further route. Reads and visibility follow these rules. A team source (`content_sources.team_mailbox_id` set) has no owner and is read only by the worker's `provider_read`, and only while the registration's last successful Directory check (`verified_at`) is under 65 minutes old; the check is renewed at 15 minutes before a pass and once mid-pass, retried every tick while pending or refused, and a transient `directory_error` is recorded in `lastCheckError` without changing `checkStatus`. The guard refuses with `team_mailbox_unverified`, `team_mailbox_disconnected` or `team_mailbox_person` (an address a user or invitation now holds); freshness is judged in the guard alone, so RLS, candidate visibility and the allowlist mirror never depend on a clock. A tool, search, retrieval or export read of a team source must name a current reader as the acting user, or the guard answers `owner_mismatch`. A reader is an open member who is an active, internal colleague seated in the registration's firm and not a firm admin (`team_mailbox_readers`). Readers see the inbox's candidates, excerpts, links, milestones and `listDealEmail` rows through the `app_owns_item` team branch; `app_item_has_allowed_source` stays team-blind, so no one else reaches a team item, even on a candidate they see through their own mail, and model extraction (`discovery_extract_batch`) does not select team items. The CCO keeps team metadata through `app_item_cco_allowed_source`, never text. Candidate-level fields (`parties`, `firstSeenAt`, `lastSeenAt`, the stage assessment) can come partly from team evidence and are visible to anyone who sees the candidate. Every audit row about a team source carries ids and fixed codes only (`discovery.team_mailbox_connected`, `_checked`, `_member_added`, `_member_removed`, `_disconnected`, and `teamMailboxId` in place of the address in the pause, restart, guard-refusal and drift rows); the firm's admins and the CCO get a `mailbox_connected` notification on connect. The member RPCs take `discovery_lock_tenant` before they write audit or visibility, the order the worker's candidate upsert keeps. A removed member's candidates and items disappear on the next read; their deals and deal memberships are untouched. `POST /discovery/team-mailboxes` is Gmail-only: a Microsoft address answers `422 provider_unsupported`.

**Team inbox oversight (#173; [D116](../07-decisions/decision-log.md), number to confirm at merge).** Three additions to the paragraph above. (1) **A sixth route.** `GET /discovery/team-mailboxes/audit` (`[173 G-03 2/4]`, its row in the discovery table) is a read for the firm's admin **and** its CCO, so "the whole admin contract ... with no further route" above no longer holds once it lands: the five admin rows are still the whole admin contract, and the audit trail is that one read beside them. It calls `discovery_team_mailbox_audit()`, a security definer bound to `auth.uid()` and scoped to the caller's own firm company, because these rows are service rows that `audit_log_select` hides by design; the policy is not widened. (2) **Firm-only notices.** The team connect notice (`mailbox_connected`) and the refusal notice below go to the active, internal admins and CCOs whose `company_id` is the inbox's `team_mailboxes.firm_company_id`, never to every company `firm_company_ids()` names (`[173 G-04 2/2]` narrows the connect notice; before it, a second bank company of the same tenant was told too). The drift notice keeps its tenant-wide recipients, counts only. (3) **A new notification kind.** `GET /notifications` can return `team_mailbox_refused` ("Team inbox failed the address check"; `payload` `{ teamMailboxId, address, reason, href: '/discovery' }`, `reason` one of the seven `checkReason` codes, no mail), written by `discovery_record_team_mailbox_check` when an inbox enters `refused` or a refused reason changes (`[173 G-04 1/2]`), and never on a same-reason recheck, a recovery, a first verify or a `directory_error`. The `discovery.team_mailbox_checked` row in the same transaction stays the audit record.
**Team inbox audit trail: AI passes and capability switches (#173 G-01, `20261023110400`).** `GET /discovery/team-mailboxes/audit`'s `access` view also returns `discovery.team_mailbox_proposal_started` and `discovery.team_mailbox_proposal_finished` for the caller's firm's inboxes, and `discovery.tenant_approval_changed` for the caller's own firm company (any capability; a firm event, `inboxId` null; another firm company's switch is never shown). New `detail` keys, each only when well formed: `path` and `outcome` of a pass, the five integer counts of a finished pass (`asked`, `deal`, `notDeal`, `invalid`, `failed`), and `capability` and `on` of a switch. A switch's `decisionRef` (free text) and a pass's `runId`, `passId` and `lastRenewedAt` are never returned. Same route, same gate, same `404`.

## Work identity onboarding (#316, flag `work_identity_onboarding`, OFF)

A banker can join and return with the firm's Google Workspace or Microsoft
account. With the flag ON and the firm mapped in `firm_identity_providers`,
`POST /api/v1/invites` creates a `work_identity` invitation whose single email
links to `/join`; the banker signs in at `/auth/work/start`, enrols TOTP, and
accepts through `POST /api/v1/work-identity/accept`, which binds the provider
subject to the user. `GET /api/v1/work-identity/context` reads the pending
invitation. Returning bankers use `/auth/work/signin`; active users link a work
account through `/auth/work/connect`. Every token passes the custom access
token hook, which refuses suspended users and any OAuth identity that is not
bound. With the flag OFF the routes answer 404 and work invitations are
refused with 409 `work_identity_disabled`. The contract, the pending hosted
checks and rollback are in [work-identity-contract.md](./work-identity-contract.md).

## Skill output revisions (flag `skill_output_revisions`, OFF)

A recorded, succeeded skill run's output can be revised by passage. Both revision routes below need `skill_authoring` and `skill_output_revisions`, an internal user with access to the deal, and, to write, `canEditWork` on a step that is not removed. With `skill_output_revisions` off they answer 404. The run list needs only `skill_authoring`, and carries each run's head with the flag on or off.

A passage is one or more whole Markdown blocks (a heading, a paragraph, a list item, a table row, a block quote, a code block), addressed by `start` and `end` offsets into the text of the version being edited. Offsets are UTF-16 code units, which is what a JavaScript string index is.

### `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions`

`runId` is the run whose output is revised. `parentId` is the version the caller was looking at, and must be the head.

- Edits: `{ parentId, edits: [{ kind: 'comment', start, end, comment } | { kind: 'hand', start, end, text }] }`. At most 20 edits, 2,000 characters per comment, and a result of at most 200,000 characters. An empty `text` removes the passage, when removing it leaves the blocks around it as they were.
- Restore: `{ parentId, restoreOf }`, where `restoreOf` is an earlier version of the same run.

| Status | Meaning |
|---|---|
| 201 `{ revisionId }` | Hand edits only, or a restore. The revision is written. |
| 202 `{ revisionId }` | At least one comment. The work continues after the response. A row with this id, succeeded or failed, appears in the run list when it ends. |
| 400 | The body is not JSON. |
| 403 | The caller is not an internal user, or cannot edit this step's work. |
| 404 | The deal or the step is unknown, the caller cannot see the deal (the same `Deal not found` answer, D65), the run is not a run of this step, or `restoreOf` is not a version of it. |
| 409 | `parentId` is no longer the head, the run failed, or the step was removed. |
| 422 | The body is malformed; an edit is out of bounds, cuts into a block or overlaps another; the result would be empty or too long, or could not be stored as written; an edit would change the blocks around it; or `restoreOf` is already the head. |
| 500 | A lookup failed (the caller's profile, the deal's tenant, the run's versions), or the revision could not be recorded. The message says which. A revision that could not be recorded was not saved. |
| 503 | A batch with a comment, and the skill service is not configured. Nothing was recorded. Hand edits and restores do not need the skill service. |

A comment batch is applied by one model turn that cannot write to the deal. Its reply becomes a revision only when the turn ended cleanly: a turn that reported an error, timed out, or ended early is recorded as a failed attempt, even if it had returned replacements, and nothing is changed. When every comment comes back unresolved and there is no hand edit, the attempt is recorded as failed with each comment's reason.

### `GET /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions/{revisionId}`

Returns `{ id, text }` for one version: the run itself, or a successful revision of it. A failed attempt is not a version and answers 404. If the run's versions cannot be read it answers 500.

### The run list

`GET /api/v1/deals/{dealId}/steps/{stepId}/skill-runs` never lists a revision as a run. Each run carries `headId`, `headText` and `revisions`: every revision and failed attempt, oldest first, with its `version` number (null for a failed attempt), who made it, and its edits. Each edit carries its status, its reason when it was not applied, and `before`, the passage as it was. `resultText` is still the run's first output. If the revisions cannot be read the list answers 500; it never answers with a run's first output standing in for its head.

### What is recorded

A revision is a row in `deal_step_skill_runs` with `source = 'revision'`, `parent_run_id` and `root_run_id`. Rows are never updated or deleted. At most one successful revision can stand on a parent, so two people applying to the same head cannot both win; the loser's attempt is recorded as failed. A comment's engine call is on the AI spend ledger as `source: skill_revision`, with `external_id` the revision id, when the turn finished. A turn that timed out or was cut off has no ledger row, because its cost never reached Conductia. The audit log gets one `create` row with `detail.kind: 'skill_run_revision'` when a comment batch starts (`phase: 'started'`) and one when any revision or failed attempt is written (`phase: 'recorded'`), in the same transaction as the row. Both carry ids, counts, SHA-256 digests and the step's title, and never a comment or output text. In the audit trail these rows read `Started revising a skill output`, `Revised a skill output` and `Restored a version of a skill output`.

### Teaching the skill from a comment

A comment edit may carry `teach: true` (`{ kind: 'comment', start, end, comment, teach: true }`). It is recorded on the edit in the revision's `inputs.edits` and changes nothing about how the batch is applied. In the run list, each edit summary carries `teach` (the edit was ticked) and `sent` (it has been sent to the skill builder). Only an applied comment that is ticked and not yet sent is offered for teaching; a restore does not remove an applied comment from the offer.

## Deal list progress fields (Conductor Center)

`GET /api/v1/deals` carries three additive, read-only fields so the Conductor Center can show progress and live runs across every deal from one read (walkthrough 2026-10-22). They come from the same deal-list query and the same membership scoping; no route, permission or schema changed.

- `currentStep.assignee`: `{ id, name }` for the person the current step is assigned to (`deal_steps.assigned_to`), else `null`. `name` is the display name, then the full name, then the email.
- `currentStep.benchRunStatus`: the current step's draft run (`deal_steps.bench_run_status`: `running`, `complete`, `failed`), else `null`. The Conductor Center lists a deal under Running only while this is `running`.
- `phaseProgress`: `[{ phaseIndex, done, total }]` per phase from the deal's own steps, custom steps included. `done` counts `complete` and `skipped`; `total` counts every active step except `skipped_entry` (before the deal's entry point). Removed steps count in neither. `null` on a database without the project rail model.

Outside parties (`users.is_external`, or a profile that cannot be read) receive `currentStep.benchRunStatus: null` and `phaseProgress: null`, matching the rail and steps routes that answer them 403 and the step GET that nulls `benchSession` for them. They still receive `currentStep.assignee`, which every deal accessor already reads from the step GET. `phaseProgress` counts by the rail's own rule (`src/lib/rail/progressCount.ts`): the Gate 0 intake steps (`p1-s7`, `p1-s6`, `g0-notify`) count as done and in the total for every listed deal, as the rail shows them, so the per-phase sums equal the rail's "N of M steps done".

## Route inventory: routes without an entry above (2026-10-24)

Routes not listed in the tables above, taken from the route handlers on 2026-10-24 (`src/app/api/v1/**/route.ts`, following each delegated handler for its access rule and flag). Issue numbers written `intelibank#N` predate the repo move.

### Companies: paths, presearch, runs, twins, bench

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| GET | `/companies/{companyId}/paths` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | List the lead's approved and draft relationship paths (`lead_relationship_paths`), newest first | intelibank#150 |
| POST | `/companies/{companyId}/paths` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Upsert one path per stakeholder (`stakeholder_id`, `path_type` warm with `relationship_id` or cold without it); `approve: true` records the banker's sign-off; audited `update` `{ kind: 'lead_path' }`; answers `201` | intelibank#150 |
| DELETE | `/companies/{companyId}/paths/{pathId}` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Delete a lead's relationship path; `204`, `404` when it is not on this lead | intelibank#150 |
| POST | `/companies/{companyId}/presearch` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Start a lead presearch run in Ignatious (`meetingType` `first_call` \| `closing` \| `working_session`, optional `attendees`); audited `create` `{ kind: 'agent_run' }`; `202` with the execution; `503` when Ignatious is not configured | #7 |
| GET | `/companies/{companyId}/presearch` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Without `?executionId=`, the latest applied memo plus a completed-but-unapplied run to resume; with it, the run status, applying a completed memo and its people to the lead and recording the run's cost on the AI spend ledger once | #7 |
| DELETE | `/companies/{companyId}/presearch` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Cancel a presearch run (`?executionId=`, bound to this lead's `agent_run` audit row, else `404`) | #7 |
| GET | `/companies/{companyId}/presearch/artifacts` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Proxy one artifact of a lead run, named by `?executionId=&artifact=<index>`; a `path` parameter is refused with `400` | #7 |
| POST | `/companies/{companyId}/presearch/input` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Answer a paused presearch run's questions (`executionId`, `answers: [{ questionId, answer }]`, `timedOut`); `202` | #7 |
| GET | `/companies/{companyId}/runs` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Status of any lead-scoped agent run (presearch, debrief, twins) by `?executionId=`, bound to this lead | #7 |
| DELETE | `/companies/{companyId}/runs` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Cancel a lead-scoped agent run by `?executionId=` | #7 |
| POST | `/companies/{companyId}/runs/input` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Answer a paused lead-scoped agent run's questions; `202` | #7 |
| POST | `/companies/{companyId}/debrief` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | File a source debrief (`text` of 40+ characters, optional `title`) as a lead document and start source-intelligence and, unless `runTwins: false`, digital-twin-builder; audited `upload` plus one `create` per run; `202` | #7 |
| GET | `/companies/{companyId}/twins` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Digital-twin personas linked to this lead, scoped to the lead's own tenant | #7 |
| GET | `/companies/{companyId}/bench/skills` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | Skill-bench catalog for a lead: skills with status `ok` and the default model | #7 |
| POST | `/companies/{companyId}/bench/chat` | `userCanViewCompanyLeadMaps`: CCO / admin / internal non-walled staff, or a company-scoped user on a lead their company registered (also through deal work on it); research and trading blocked | One lead-scoped skill-bench chat turn, streamed from Ignatious; each finished turn is recorded on the AI spend ledger (`source: bench_chat`) | #7 |
| POST | `/companies/{companyId}/members/{userId}/revoke-grants` | company director / admin | Remove every deal seat `userId` granted (`added_by`) on this company's deals; each removed seat audited `revoke` `{ reason: 'bulk_revoke_by_adder' }`; returns `{ revoked }` | intelibank#39 |
| GET | `/companies/{companyId}/notify-recipients` | company member / CCO / admin | The people `create_deal_gate0` will notify when a mandate opens; bank companies only (`400` otherwise) | #68 |

### Deals: rail and steps

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| GET | `/deals/{dealId}/rail` | internal deal member / CCO / admin (external: `403`) | The project rail: phases, every step row (removed and skipped ones included, with who removed or skipped it, approver and whether the database verified the approver), the current step, and `canEditStructure` / `canSaveTemplate` | #147 |
| DELETE | `/deals/{dealId}/rail/steps/{stepId}` | `resolveDealStepStructureCapability`: `company:deals:steps:structure` on the actor's own company, for a caller who can access the deal | Remove a step from the project rail (`rail_remove_step`); `409` for a completed or protected step | #147 |
| POST | `/deals/{dealId}/rail/steps/{stepId}/restore` | `resolveDealStepStructureCapability`: `company:deals:steps:structure` on the actor's own company, for a caller who can access the deal | Restore a removed rail step (`rail_restore_step`) | #147 |
| POST | `/deals/{dealId}/rail/steps/{stepId}/skip` | `requireStepWorkAuthority`: a caller who can access the deal (`userCanAccessDeal`, so same-tenant CCO / admin overseers too) and may complete the step (`resolveDealStepCapabilities`); `approverId` must be an eligible seated approver | Skip a step with `reason` and an `approverId` the server verifies (`rail_skip_step`); `400` for an ineligible approver, `409` for a completed or skipped step, retryable `409` `skip_retry` on deadlock | #147 #312 |
| GET | `/deals/{dealId}/steps` | internal deal member / CCO / admin (external: `403`) | Rail steps with their Box data room folders (seeding the folders on first read): label, seq, status, upload requirement, min phase, folder link | intelibank#123 |
| GET | `/deals/{dealId}/steps/{stepId}` | member/CCO/admin | One step's assignment, work (internal users or those who may edit it), completion, the deal roster, and the caller's `isMd` / `canAssign` / `canComplete` / `canEditWork` | intelibank#150 |
| PATCH | `/deals/{dealId}/steps/{stepId}` | `resolveDealStepCapabilities` (overseers included through `userCanAccessDeal`): `assignTo` needs `canAssign` (deal MD or `company:deals:steps:assign`); `work` / `benchSession` the MD, the assignee, or on an unassigned step `company:deals:steps:update_unassigned`; `complete` / `skip` need `canComplete` | Assign, save work or a bench session, complete (manual-step validation and required upload checked) or log a verified skip, in one `deal_step_save` with optimistic `expectedUpdatedAt` (`409` when the step changed); audited and notified | #312 |
| GET | `/deals/{dealId}/step-records` | member/CCO/admin | Every station's record on the deal: status, assignee and completer by name, completion note and the logged skip | #148 |
| GET | `/deals/{dealId}/steps/{stepId}/dataroom` | internal deal member / CCO / admin (external: `403`) | Provision (if needed) and read a rail step's Box folder: folder link, files, and `boxMode` `live` \| `mock` | intelibank#123 |
| POST | `/deals/{dealId}/steps/{stepId}/dataroom/upload` | internal deal member with an MD, deal-team or legal seat / CCO / admin | Multipart upload of a file to the step's Box folder (`file`, `classification` 1-4, Deal Folder `folder` and `folderSubpath`), filed as an internal-room document; audited `upload`; `201` | intelibank#123 |
| POST | `/deals/{dealId}/steps/{stepId}/ignatious` | member/CCO/admin; MD briefing step (`p1-s9`) only, other steps `404` | Start the MD briefing agent run (`meetingType`, `depth` `one_pager` \| `full_memo`, optional `attendees`); audited `create` `{ kind: 'agent_run' }`; `503` when Ignatious is not configured | #7 |
| GET | `/deals/{dealId}/steps/{stepId}/ignatious` | member/CCO/admin; MD briefing step only | Run status by `?executionId=` (bound to this deal) or the caller's newest run on the step with `?latest=1`; records the finished run's cost on the AI spend ledger once | #7 |
| DELETE | `/deals/{dealId}/steps/{stepId}/ignatious` | member/CCO/admin; MD briefing step only | Cancel an MD briefing run by `?executionId=` | #7 |
| GET | `/deals/{dealId}/steps/{stepId}/ignatious/artifacts` | member/CCO/admin; MD briefing step only | Proxy one run artifact by `?executionId=&artifact=<index>`; a `path` parameter is refused with `400` | #7 |
| POST | `/deals/{dealId}/steps/{stepId}/ignatious/input` | member/CCO/admin; MD briefing step only | Answer a paused MD briefing run's questions; `202` | #7 |
| GET | `/deals/{dealId}/bench/skills` | member/CCO/admin | Skill-bench catalog for a deal: skills with status `ok` and the default model | #7 |
| POST | `/deals/{dealId}/bench/chat` | member/CCO/admin | One deal-scoped skill-bench chat turn, streamed from Ignatious; each finished turn is recorded on the AI spend ledger with the station (`stepId`) as its task when one is supplied, else `bench_chat` | #7 |
| PATCH | `/deals/{dealId}/documents/{documentId}` | `canManageDealMembers`: deal MD, a director of the deal's owning company, or a member delegated `can_manage_members` | Set a document's `minPhase` and/or `classification` (1-4); audited `grant` `{ reason: 'document_permissions', before, after }` (flag `platform_onboarding`) | intelibank#150 |
| GET | `/deals/{dealId}/recipient-affiliations` | bank-side, active deal MD / admin / delegated member manager | The deal's recipient relationships, private/no-store (flag `platform_onboarding`) | #172 |
| PUT | `/deals/{dealId}/recipient-affiliations` | bank-side, active deal MD / admin / delegated member manager | Set one recipient's relationship (`client`, `client_advisor`, `counterparty`, `counterparty_advisor`) through `set_recipient_affiliation` with `expectedRevision`; `409` on a stale revision (flag `platform_onboarding`) | #172 |
| POST | `/deals/{dealId}/recipient-check` | member/CCO/admin, active, same tenant | Review `{to, cc, bcc}` against the deal's relationships before a send: per-recipient boundary and `requiresConfirmation`, plus `policyFingerprint`; persists nothing (flag `mail_channel`); external and research / trading callers get an empty review (`reviewed: false`) | #172 |

### Skill authoring and publication

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| PUT | `/deals/{dealId}/steps/{stepId}/skill-binding` | internal deal member who may edit the step's work (MD, assignee or unassigned) (or a same-tenant overseer through `userCanAccessDeal`) | Bind the step to an available skill version (`reference`) through `rail_rebind_step`; `422` for an unavailable version (flag `skill_authoring`) | #184 |
| GET | `/deals/{dealId}/steps/{stepId}/skill-versions` | internal deal member who may edit the step's work (or a same-tenant overseer through `userCanAccessDeal`) | The skill versions available to the step and its current binding (flag `skill_authoring`) | #184 |
| POST | `/deals/{dealId}/skill-drafts/{draftId}/publish` | `requireSkillAuthoringAccess`: `company:deals:steps:structure` on the deal's bank, not the actor's company (denials audited) | Admit the draft's candidate for publication (`skill_publication_admit`, idempotent on `requestId`, with `expectedEditRevision`, `candidateId`, `candidateDigest`), then advance it and return the publication view (flag `skill_authoring`) | #180 |
| POST | `/deals/{dealId}/skill-publications/{publicationId}/duplicate-decision` | `requireSkillAuthoringAccess` (`company:deals:steps:structure` on the deal's bank) | Confirm or decline a publication flagged as a possible duplicate (`expectedRevision`, `assessmentDigest`, `decision`); a confirm advances it (flag `skill_authoring`) | #180 |
| POST | `/deals/{dealId}/skill-publications/{publicationId}/placement` | `requireSkillAuthoringAccess` (`company:deals:steps:structure` on the deal's bank) | Replace where the published skill step lands on the rail (`phaseIndex`, `kind`, `afterStepId`) and advance the publication (flag `skill_authoring`) | #180 |
| GET | `/internal/skill-publications/process` | service token (Bearer, rate-limited on failures) | Vercel cron recovery sweep: process up to 25 due skill publications, answering counts by state; each publication is refused as `feature_disabled` while `skill_authoring` is off | #180 #238 |
| POST | `/internal/skill-publications/process` | service token | The same sweep for a worker; a non-empty body is `422` | #180 #238 |
| POST | `/rail-catalog/{templateId}/skill-drafts` | `company:rails:templates:manage` (internal) | Open, or return, the caller's skill draft on a saved template, optionally setting its `placement` (flag `skill_authoring`) | #321 |
| GET | `/rail-catalog/{templateId}/skill-drafts/{draftId}` | `company:rails:templates:manage` | Read a template skill draft (flag `skill_authoring`) | #321 |
| PATCH | `/rail-catalog/{templateId}/skill-drafts/{draftId}` | `company:rails:templates:manage` | Autosave the draft's `name`, `placement` and `composerText` at `expectedEditRevision` (flag `skill_authoring`) | #321 |
| POST | `/rail-catalog/{templateId}/skill-drafts/{draftId}/discard` | `company:rails:templates:manage` | Archive the draft at `expectedEditRevision` (flag `skill_authoring`) | #321 |
| POST | `/rail-catalog/{templateId}/skill-drafts/{draftId}/messages` | `company:rails:templates:manage` | Admit an authoring message (`text`, `expectedEditRevision`) and schedule the Ignatious authoring turn after the response; the turn's cost is metered (flag `skill_authoring`) | #321 |
| POST | `/rail-catalog/{templateId}/skill-drafts/{draftId}/messages/{messageId}/retry` | `company:rails:templates:manage` | Admit a new attempt for a failed message and schedule the turn (flag `skill_authoring`) | #321 |
| POST | `/rail-catalog/{templateId}/skill-drafts/{draftId}/publish` | `company:rails:templates:manage` | Save the draft's validated candidate (`candidateId`, `candidateDigest`, `expectedEditRevision`) as a custom skill step at its placement on the template, a change for the template's next publish (flag `skill_authoring`) | #321 |

### Rail catalog

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| GET | `/rail-catalog` | `company:rails:templates:manage` (internal) | The caller's company rail templates with step counts, the house default, and the names of removed fork sources | #321 |
| POST | `/rail-catalog` | `company:rails:templates:manage` | Create a template (`name`) from the house default or a saved template (`sourceTemplateId`) via `create_rail_template`; `409` for a taken name; `201` | #321 |
| GET | `/rail-catalog/{templateId}/changes` | `company:rails:templates:manage` | The template's last 50 logged changes (add or remove step, descriptions, step skill), newest first | #321 |
| POST | `/rail-catalog/{templateId}/changes/{changeId}` | `company:rails:templates:manage` | Undo one logged change (`undo_rail_template_change`); `409` when already reversed or it would leave no steps | #321 |
| POST | `/rail-catalog/{templateId}/steps` | `company:rails:templates:manage` | Add a house-rail step (`kind: 'catalog'`, `stepId`) or a custom step (`kind: 'custom'`, `title`, `description`, `phaseIndex`, `at`); the house default is `409`; `201` | #321 |
| DELETE | `/rail-catalog/{templateId}/steps/{stepRowId}` | `company:rails:templates:manage` | Remove a step from the template; `409` for the last step | #321 |
| PATCH | `/rail-catalog/{templateId}/steps/{stepRowId}` | `company:rails:templates:manage` | Set a template step's `description` (at most 4000 characters; a skill step needs 1 to 2,000) | #321 |

### Discovery

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| POST | `/deals/from-discovery` | session; the RPC checks the actor sees the candidate and may create deals | Promote a proposed deal (`candidateId`) into a mandate with the Gate 0 contract (typed code name and target, `entryStepSeq`, members, conflicts attestation) through `discovery_promote_candidate`; `409` when already promoted; `201` (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/merge` | session (RLS); deal-create authority, checked by the RPC | Merge this proposed deal into `survivorId` with a `reason` (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/reassign` | session (RLS); deal-create authority | Move one email's link (`linkId`) to `targetCandidateId` with a `reason` (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/reject` | session (RLS); deal-create authority | Take a proposed deal off the list with a `reason`; its evidence stays (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/rename` | session (RLS); deal-create authority | Rename a proposed deal (`name`, optional `reason`) and pin the name against re-runs (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/split` | session (RLS); deal-create authority | Move up to 500 emails (`itemIds`) onto a new proposed deal (`name`, `reason`) (flag `deal_discovery`) | #261 |
| POST | `/discovery/candidates/{candidateId}/station` | session (RLS); deal-create authority | Set the station (`stepId` of the MVP rail, `reason`) the MD says the deal is at (flag `deal_discovery`) | #261 |
| GET | `/discovery/deal-email` | session (RLS) | The redacted email discovery linked to a promoted deal (`?deal=<code>`), for the Deal Folder's Deal email view; no bodies; `{ items: [], truncated: false }` for a deal the caller cannot read (flag `deal_discovery`) | #340 |
| POST | `/discovery/model-proposals/dismiss` | session (RLS); owner of a personal source holding a live row of the key | Demo only: dismiss one deal key's model-proposal rows (`dealKey`), archive-not-delete; returns `{ dismissed, operationId }` (flags `deal_discovery`, `discovery_model_proposals_demo`) | #173 |
| POST | `/discovery/suggestions/dismiss` | session (RLS); deal MD, checked by the RPC | Hide the rail's station marker for one assessment (`dealCode`, `assessmentId`, `reason`); a newer assessment shows it again (flag `deal_discovery`) | #261 |

### Other

| Method | Path | Auth | Purpose | Issue |
|---|---|---|---|---|
| GET | `/access-requests` | session | The caller's own access requests, plus their company's pending inbox for a firm admin, company director or holder of `company:access:assign` | #38 |
| POST | `/access-requests` | session (company member) | Ask the organization's admins for access to a destination (`destination`); approvers are notified; `201` on create, `200` returning an existing pending request | #38 |
| PATCH | `/access-requests/{requestId}` | firm admin / company director / `company:access:assign`, never the requester | Decide a pending request (`decision` `approved` \| `denied`); approval grants the mapped company permission within the grant envelope; the requester is notified; `409` once decided | #38 |
| GET | `/bench/skills` | session | The skills library catalog from Ignatious (no lead required); `503` when Ignatious is not configured | #7 |
| GET | `/bench/skills/{name}/versions` | session | Version history of one skill in the skills library | #7 |
| GET | `/crm-network` | `userCanViewLeads`: CCO / admin, internal non-walled staff, an external director, or `company:leads:view` | The CRM relationship graph for the Leads Network tab, tenant-wide for internal non-walled users, CCO and admin, otherwise the caller's company | intelibank#188 |
| GET | `/work-identity/provider` | session | The work-account provider the caller can still connect (`work_identity_connectable_provider`), or `null` (flag `work_identity_onboarding`) | #406 |
