# ADR-0008 — Phase 1 auth, deals, audit spine (and the project-as-URL routing reframe)

- **Status:** Proposed (Lance + Martín acknowledgement pending). Implemented. *Later:* the single `DEV_TENANT_ID` tenant gave way to one tenant per firm (D54), and deal-scoped RLS landed as the backstop (ADR-0016), which answers open question 1.
- **Date:** 2026-06-05
- **Deciders:** Roberto Di Lillo (proposal + implementation); Lance Marks / Martín Casado (acknowledgement pending)
- **Source:** legacy issue [intelibank#29](https://github.com/FutureProofingDev/intelibank/issues/29) (ADR — Phase 1 auth, deals, audit spine); the Phase 1 "done-when" in legacy issue [intelibank#5](https://github.com/FutureProofingDev/intelibank/issues/5) ("someone can sign in, create a deal, invite teammates with the right access, and every document open is logged"); the permissions model in `docs/03-engineering/permissions_schema_v3-full.md`; extends D8 (the seam) and ADR-0007 (Supabase backend) without reversing either.
- **How-to:** for the endpoints, the seed accounts, and the in-app explorer, see [`../03-engineering/api-v1.md`](../03-engineering/api-v1.md).

## Context

ADR-0007 adopted Supabase (Postgres + RLS) as the backend and shipped feature flags as the first slice, deliberately *beside* the `ConductiaAPI` product seam (D8). It left the permissions schema unmigrated and the app identity-less: the UI ran on mock fixtures, the "MD" was a hardcoded persona, and the mandate was client-only session state (`state.mandateCompany`).

Phase 1 (issue #5) is the foundation slice: a real person signs in, creates a deal with a unique code, invites teammates with the right access, and every document open is logged. That requires four things the repo did not have — an identity, a deal record, a membership/access model, and an audit spine — plus a transport to expose them. Because this is the *first* product-shaped backend (deals, not infrastructure flags), where it lives relative to the seam, how it authenticates, and how it audits set the pattern every later product slice inherits. That makes it ADR-worthy (issue #29).

In parallel, the identity requirement forced a routing change. The app previously gated on `state.mandateCompany`: `null` showed the full-screen `MandateOnboarding` intake, set showed the shell. With real auth, the first gate must be *sign-in*, and the active deal must be addressable (shareable, bookmarkable, server-resolvable) — i.e. a URL, not a client field. This ADR records both the backend spine and the routing reframe because they shipped together and depend on each other.

## Decision

Ship a Phase 1 auth + deals + audit **spine** behind a versioned REST transport, and reframe routing around authentication and a URL-addressed project.

### Backend spine

1. **The permissions schema is migrated as a minimal Phase 1 slice.** `supabase/migrations/20260604100000_permissions_schema.sql` creates `companies`, `users`, `roles`, `deals`, `deal_parties`, `deal_memberships`, `documents`, and `audit_log` — the subset of `permissions_schema_v3-full.md` that Phase 1 exercises. Out of scope for Phase 1: `ndas`, `deal_expenses`, `notifications`, `compliance_events`. `roles` is seeded idempotently (`on conflict (slug) do update`) with the eight canonical slugs and their permission lists.

2. **Identity is Supabase Auth; `public.users` mirrors it (Option A).** `users.id` is a FK to `auth.users.id`. A `security definer` trigger (`handle_new_auth_user`) provisions / upserts the `public.users` row on first sign-up from `auth.users.raw_user_meta_data`, so every signed-in user has a `users` row that RLS can reference via `auth.uid()` (issue #21). Single-tenant for now: a `DEV_TENANT_ID` constant (`src/lib/db/tenant.ts`) stands in until a `tenants` table is warranted.

3. **The deal/audit transport lives BESIDE the product seam, as REST at `/api/v1/*`** — not inside `ConductiaAPI` (this resolves the open question in #29). The seam is the M&A *content* contract (sellers, acquirers, skills, scoring, compliance verdicts) and stays mock-backed and unchanged. Deals, memberships, documents, and audit are *platform* concerns (who, what, when, may-they) and get their own versioned HTTP surface. Rationale: the same separation ADR-0007 drew for flags — keep infrastructure/platform out of the product domain contract — applied to the first product-shaped backend.

4. **Route handlers self-authenticate; access control is enforced in app code.** Every `/api/v1` handler calls `requireApiUser()` (`src/lib/api/v1/http.ts`), which reads the Supabase **server** client session (`getUser()`) and returns a JSON `401` if absent, or the **admin** (secret-key) client if present. Reads/writes go through the admin client; row-level authorization is enforced by explicit predicates in `src/lib/api/v1/access.ts` (`userCanAccessDeal`, `userIsDealMd`, `listDealsForUser`) — CCO/admin firm-roles see across the tenant, members see their deals, the deal MD alone may grant membership. This is a deliberate **belt** while the RLS **suspenders** are authored (see consequence below).

5. **Deal creation mints a code and makes the creator MD** (issue #23). `POST /api/v1/deals` inserts the target company + deal + a `deal_parties(target)` row + a `deal_memberships` row with `deal_role = md`, sets `status = intake`, and writes an `audit_log(grant)` event. The code is `PREFIX-YEAR-NNN` (`mintDealCode`).

6. **Membership grant is MD-gated and audited** (issue #24). `POST /api/v1/deals/[dealId]/members` upserts a membership (validated `dealRole`), refusing non-MD callers (`403`) and unknown invitees (`404`, Option A: the invitee must have signed up first), and writes an `audit_log(grant)` event.

7. **Document view writes an audit row** (issue #25). `POST /api/v1/deals/[dealId]/documents/[documentId]/view` records `audit_log(action='view', actor_id, deal_id, document_id, ts)` for any caller permitted on the deal. Audit transport for these product events is **app-layer** (written in the route, where the actor identity + request context live) — complementary to ADR-0007's choice of a **DB trigger** for `feature_flags` toggles (which must capture console-direct edits). Both transports coexist by design.

8. **The TypeScript constants mirror the SQL enums.** `src/lib/constants/*` (`roles`, `companies`, `deals`, `documents`, `audit`, `tables`) are the single typed source aligned to the migration's `CHECK` constraints, so routes, seeds, and `check:db` never stringly-type a role/status/action. The migration file remains the source of truth; the constants carry a header pointing back to it.

9. **The API is self-describing.** `openapi/phase1.json` is served at `/api/v1/openapi.json` and rendered by an in-app Swagger explorer at `/dev-api` (dev-only; `notFound()` in production). A seed (`npm run seed:users`, data in `scripts/seed-data.ts`) provisions one account per role so the spine is exercisable end-to-end.

### Routing reframe

10. **Authentication is the first gate, enforced in middleware.** `src/middleware.ts` redirects unauthenticated requests to `/sign-in?redirectTo=…`. Its matcher excludes `/api` (handlers self-authenticate and return JSON 401), `/sign-in`, the dev tools, and static assets. If Supabase is unconfigured the gate is a no-op so the app still boots locally.

11. **The active project is URL state, not session state.** It is the `/projects/[projectId]` segment, resolved via `useParams` (`src/lib/project/resolveProjectId.ts`). This replaces `state.mandateCompany` (retained but unused). The sandbox resolves any id to the Atlassian dataset, so the URL is real and shareable while the demo data stays deterministic.

12. **The shell moves into an `(authed)` route group.** `src/app/(authed)/` owns the `AppShell` chrome for the authenticated surfaces — the project picker at `/` (rendered inside the shell so sign-out is reachable) and the destinations under `/projects/[projectId]` (Mandate / Acquirers / Team / Skills). Sign-in and dev tools sit at the top of `src/app/`, outside the shell. The route group only decides which routes get the chrome; auth itself lives in middleware. The full-screen `MandateOnboarding` is removed; the in-shell picker (`CommandBar variant="hero"`) replaces it.

13. **Identity is now real chrome.** `ProfileMenu` takes the signed-in name/role/initials/mandate (resolved by `useCurrentUser` → `GET /api/v1/me`) instead of a mock persona, and its sign-out clears the Supabase session and routes to `/sign-in` (issue #30). The compliance single-mount invariant is untouched.

## Alternatives considered

- **Put deals inside the `ConductiaAPI` seam.** Fewest boundaries. Rejected for the same reason ADR-0007 rejected it for flags: it pollutes the M&A content contract with platform/identity concerns and couples deal writes to the product mock. Deals get their own versioned REST surface beside the seam.
- **RLS-only authorization (no app-layer predicates).** The "correct" end state. Rejected *for now* because shipping correct, deal-scoped RLS policies for eight tables is its own slice; gating in the route with the admin client lets Phase 1 land with enforced access today, with RLS authored as the follow-up that makes the database the second wall.
- **All audit via DB triggers.** Uniform with the flags story. Rejected for product events: a `view` is an application action whose actor and context are known only in the request; an app-layer write is the natural transport. Triggers stay the right tool for console-direct edits (flags).
- **Keep the mandate as session state / a feature-flagged intake.** Lowest churn. Rejected: a real deal needs a real, shareable address and a server-resolvable id; a client field cannot be bookmarked, linked in a thread, or resolved by an API. URL is the source of truth.
- **Magic-link / OAuth sign-in.** Deferred. Email + password is the smallest correct gate for a sandbox with seeded accounts; richer auth is a later, separate decision.

## Consequences

- A new versioned surface `/api/v1/*` (8 route handlers), a typed access/HTTP module (`src/lib/api/v1/`), an auth hook (`src/lib/auth/useCurrentUser.ts`), the tenant + project resolvers, and the schema-mirroring constants enter the tree. New dev dependency `swagger-ui-dist` powers the explorer.
- The product seam (D8) remains mock-backed and unchanged: the project dashboards still read `getApi()`. Wiring the **MD-facing** intake → real deal creation (#31), the team-invite UI (#32), and the document-open surface (#33) onto these APIs is explicit follow-up; the API surface for all three is delivered and exercisable via `/dev-api`.
- **RLS is enabled on all eight tables but ships policy-free** (service_role bypasses for seeds + the server admin client). Deal-scoped RLS read policies — the second wall behind the app-layer predicates — were authored in the RLS follow-up (#22, migration `20260612150000`); ADR-0007's deferred flag **write** policy also landed (#26, migration `20260612160000`).
- `audit_log.action` stays `view|download|upload|export|grant|revoke`. The `config_change` value once proposed for flag toggles was **not** added — feature-flag changes are internal/dev config, not business audit events (D34).
- The middleware uses the deprecated `middleware.ts` convention (Next warns to migrate to `proxy`); functional now, flagged for a later rename.
- This ADR sets the reusable pattern for product-shaped backend slices: **REST beside the seam · route-handler self-auth · app-layer access predicates (RLS to follow) · app-layer audit for request-context events · schema-mirrored TS constants · OpenAPI + dev explorer · URL-addressed resources**.

## Open questions

1. **Deal-scoped RLS policies.** When do the suspenders land behind the app-layer belt? (Unblocked now that `users`/`roles` exist.) Tracked by the RLS follow-up / #26.
2. **Multi-tenant.** `DEV_TENANT_ID` is a single-tenant placeholder. A `tenants` table + tenant resolution from the session is deferred until a second tenant is real.
3. **`me.mandate` selection.** `GET /api/v1/me` resolves the *first* membership as the "primary" mandate for the profile context line. Multi-deal MDs (issue #10) will need an explicit active-deal selection rather than first-wins.
4. **Invitee provisioning (Option A).** Membership grant requires the invitee to have signed up first. A real invite flow (email → provisioned `auth.users` → pending membership) is a later slice (#32).
