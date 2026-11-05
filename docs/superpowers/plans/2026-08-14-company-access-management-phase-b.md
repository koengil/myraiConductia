# Company access management Phase B implementation plan

**Date:** 2026-08-14
**Status:** Implementation complete, automated verification passed
**Design:** [Company access management Phase B](../specs/2026-08-14-company-access-management-phase-b-design.md)
**Issue:** [#160](https://github.com/FutureProofingDev/intelibank/issues/160)

## Delivery boundary

PR #175 merged into `develop` on 2026-08-14. Phase B implementation runs on a
separate feature branch created from that merged base.

No task below authorizes a commit, push, PR mutation, migration application, or
feature-flag change. Obtain authorization for each external or git write.

## Global constraints

- Build from `develop`.
- Preserve the `ConductiaAPI` seam. Company access remains in `/api/v1`.
- Handlers self-authenticate and fail closed.
- The migration is the enum source of truth. TypeScript mirrors it.
- Custom permissions are company-only and never imply deal authority.
- Directors and same-tenant firm admins remain the protected control plane.
- All multi-row access writes and audit rows are one database transaction.
- All visible copy is English and contains no em dash.
- Use the smallest permission catalogue that has real enforcement consumers.

## Task 0: approval and branch gate

1. Review and approve the Phase B design.
2. Merge PR #175 into `develop` with Phase A only plus planning artifacts.
3. Create a new Phase B branch from the updated `develop`.
4. Confirm the working tree is clean and no later migration timestamp conflicts.

Exit: the Phase B implementation branch is based on the merged Phase A schema.

## Task 1: permission and flag constants

Files:

- `src/lib/constants/companyPermissions.ts` (new)
- `src/lib/constants/tables.ts`
- `src/lib/constants/audit.ts`
- `src/lib/flags/keys.ts`
- `scripts/seed-flags.ts` (registry-driven, verify only unless behavior changes)
- `tests/constants-schema-sync.test.ts`

Steps:

1. Add fixed constants for:
   - `company:directory:view_all`
   - `company:invites:send`
   - `company:roles:manage`
   - `company:access:assign`
2. Add type guards that narrow untrusted permission keys.
3. Add table constants for all Phase B tables.
4. Add `AUDIT_ACTION.UPDATE` and synchronize it with the newest audit CHECK.
5. Add `company_access_management` to the typed flag registry, defaulting off
   through the existing seed behavior.

Tests:

- TypeScript permission keys exactly match the migration CHECK and seed.
- Audit constants exactly match the newest migration CHECK.
- The flag registry contains the new key and remains fail closed when absent.

## Task 2: schema, lifecycle, resolver, and transactional RPCs

Files:

- `supabase/migrations/[timestamp]_company_access_management.sql` (new)
- `supabase/migrations/20260612140000_company_removal_cascade.sql` is historical
  and must not be edited; replace its function in the new migration.
- `tests/db/company-access-management.test.ts` (new)
- `tests/db/migration-chain.test.ts` or the repository's current replay test

Steps:

1. Create and seed `company_permissions`.
2. Create `company_roles`, `company_role_permissions`,
   `company_member_access`, `company_member_roles`, and
   `company_member_permissions` with scoped foreign keys and indexes.
3. Add active-name uniqueness and role/member access versions.
4. Extend the company-removal trigger to delete member access when company
   membership changes.
5. Add RLS and service-role grants. Authenticated users receive no direct write
   policy.
6. Add fail-closed SQL functions:
   - `app_company_is_access_root`
   - `app_company_effective_permissions`
   - `app_has_company_permission`
7. Add transactional, service-role-only RPCs for:
   - role creation
   - role replacement
   - role archival
   - member access replacement
8. Re-check authority and the grant envelope inside every RPC after locking the
   relevant version row.
9. Insert audit rows inside the same transaction.

Tests:

- Root resolution is same-tenant and bank-company scoped.
- External, suspended, moved, and cross-company users receive no custom access.
- Role and direct grants union correctly with source attribution.
- Archived roles do not contribute permissions.
- Grant-envelope escalation attempts fail.
- Stale versions fail without partial writes or audit rows.
- Audit failure rolls back the entire mutation.
- Company removal cascades all custom access.
- Migration-chain replay succeeds from an empty database.

## Task 3: TypeScript access wrapper and tenant hardening

Files:

- `src/lib/api/v1/companyAccess.ts` (new)
- `src/lib/api/v1/access.ts`
- `tests/api-v1-company-access.test.ts` (new)
- `tests/api-v1-access.test.ts`

Steps:

1. Add typed wrappers around the SQL effective-permission and has-permission
   functions. Database errors return `unreadable`; enforcement wrappers deny.
2. Do not duplicate permission joins or root logic in TypeScript.
3. Make `userCanViewCompany` tenant-aware for CCO and firm-admin viewers.
4. Keep `canManageCompanyMembers` unchanged as the protected employee and
   director control plane.

Tests:

- Resolver success, denial, and unreadable paths.
- Cross-tenant CCO/admin company visibility is denied.
- Same-tenant oversight and same-company member visibility remain intact.

## Task 4: migrate company invitation delegation

Files:

- The Task 2 migration or a second ordered migration if reviewability requires
  it.
- `src/lib/api/v1/access.ts`
- `src/lib/api/v1/proposalFeasibility.ts`
- `src/app/api/v1/invites/lookup/route.ts`
- `src/app/api/v1/invites/route.ts`
- The newest migration defining the invite-creation RPC must be replaced by a
  new migration, never edited historically.
- `tests/access-invites.test.ts`
- `tests/lookup-warnings.test.ts`
- `tests/db/invite-authority-parity.test.ts`

Steps:

1. Backfill a direct `company:invites:send` grant for active internal members
   with `can_invite = true`.
2. Replace every company-level authorization read of `can_invite` with the
   authoritative company permission resolver.
3. Preserve all deal-attached invite authority and external-party rules.
4. Redefine the transactional invite RPC to use the same SQL resolver.
5. Keep the legacy column only as a synchronized direct-grant projection.
6. Route the legacy `{ canInvite }` PATCH branch through the access transaction
   and mark it deprecated in OpenAPI.
7. Make inherited-permission behavior explicit in the response.

Tests:

- Backfilled delegates retain company-level invite behavior.
- Role-inherited invite permission works.
- Removing a direct grant does not remove a role-inherited permission.
- The permission never grants deal invitations, invite management, or director
  invitations.
- TypeScript and SQL invite-authority parity remains exact.
- Lookup keeps its anti-enumeration query schedule and response rules.

## Task 5: company role APIs

Files:

- `src/app/api/v1/companies/[companyId]/roles/route.ts` (new)
- `src/app/api/v1/companies/[companyId]/roles/[roleId]/route.ts` (new)
- Focused route tests under `tests/`

Steps:

1. Flag-gate every route with `company_access_management`.
2. Self-authenticate and resolve company authority before disclosure.
3. Implement role/catalog listing for role managers and access assigners.
4. Implement create, exact-set patch, and archive through transactional RPCs.
5. Validate JSON objects strictly and reject unknown fields.
6. Normalize names, enforce size limits, and return 409 for duplicate names,
   stale versions, or assigned-role archival.
7. Return source-of-truth versions and assignment counts.

Tests:

- Flag-off 404 behavior.
- Root and delegated authorization.
- Cross-company and cross-tenant denial.
- Invalid permissions and grant-envelope denial.
- Duplicate name, stale version, assigned archive, and successful lifecycle.
- No partial mutation when audit insertion fails.

## Task 6: member access API and `/me`

Files:

- `src/app/api/v1/companies/[companyId]/members/[userId]/access/route.ts` (new)
- `src/app/api/v1/me/route.ts`
- `src/app/api/v1/companies/[companyId]/members/route.ts`
- `src/app/api/v1/companies/[companyId]/members/[userId]/route.ts`
- Focused route tests under `tests/`

Steps:

1. Add source-aware GET for employee access.
2. Add exact-set, versioned PATCH through the transactional RPC.
3. Permit self-read but never self-write without `company:access:assign`.
4. Reject external, suspended, moved, and cross-company targets.
5. Extend `/me` with the current user's effective `company_permissions`.
6. Honor `company:directory:view_all` for opt-in walled roster reads.
7. Keep add/remove/promote/demote root-only.
8. Extend member-removal tests to prove custom access is cleared.

Tests:

- Role and direct assignment replacement with source attribution.
- Self-read, delegated read/write, and denial cases.
- Grant-envelope and stale-version conflicts.
- Walled directory visibility grants identity only.
- Removal clears custom roles, direct permissions, and invite delegation.

## Task 7: People UI

Files:

- `src/app/(authed)/companies/[companyId]/members/page.tsx`
- New focused components under `src/components/company/` when separation reduces
  the existing page rather than wrapping it.
- `tests/company-members-page.test.tsx`
- New access drawer tests under `tests/`

Steps:

1. Read viewer permissions from `/me` and replace raw `can_invite` presentation
   checks with effective permission checks.
2. Show assigned custom role chips on employee rows.
3. Add a source-aware access drawer.
4. Allow versioned role/direct grant edits only for access assigners.
5. Disable choices outside the actor's grant envelope.
6. Preserve preferred deal role, invitations, filters, wall badges, director
   guards, and removal behavior.
7. Present director and firm authority as protected and outside custom access.

Tests:

- Role chips and inherited/direct sources render correctly.
- User edits survive successful refresh and handle 409 reload guidance.
- Delegated assigners see only grantable choices.
- Non-assigners and flag-off users cannot see mutation controls.
- Existing Phase A preferred-role and walled-row tests remain green.

## Task 8: Roles & permissions UI

Files:

- `src/app/(authed)/companies/[companyId]/roles/page.tsx` (new)
- Shared Company tabs under `src/components/company/`
- Focused RTL tests under `tests/`

Steps:

1. Add People and Roles & permissions desktop tabs.
2. Render roles with member count, permission count, and status.
3. Add create/edit form with the fixed permission checklist.
4. Explain high-authority permissions in precise visible copy.
5. Enforce expected-version saves and assigned-role archive conflicts.
6. Keep permission keys out of free-form user input.
7. Preserve the existing AppRail behavior and defer mobile navigation.

Tests:

- Listing, create, edit, stale version, and archive flows.
- Permission checklist respects the viewer grant envelope.
- Assigned role cannot be archived.
- Flag and authorization behavior.

## Task 9: RLS and regression hardening

Files:

- The Phase B migration
- `tests/db/rls-company-access.test.ts` (new)
- Existing access, invite, member, and RLS suites

Steps:

1. Add read policies for the new tables.
2. Update `users_select` for same-company full-directory viewers only.
3. Verify company permissions do not affect deal, document, company-search,
   inbox, or external-party policies.
4. Verify authenticated clients cannot call mutation RPCs or write tables
   directly.

Tests:

- Same-company and cross-company table reads.
- Direct authenticated writes denied.
- Deal/document/mail/search permissions unchanged for every company permission.
- Research/trading identity visibility does not reveal deal information.

## Task 10: API contract, docs, and rollout verification

Files:

- `docs/03-engineering/api-v1.md`
- `openapi/phase1.json`
- Phase B design and plan status fields
- Operational migration/check scripts if required

Steps:

1. Document the permission catalogue, protected roots, grant envelope, APIs,
   errors, source attribution, and `canInvite` deprecation.
2. Add strict OpenAPI 3.1 schemas for role and member-access routes.
3. Add migration and live-database checks for catalogue/backfill integrity.
4. Mark the design Implemented only after runtime and migrations are complete.
5. Record the later contract migration for dropping `users.can_invite`.

Verification commands:

```sh
npx vitest run <focused Phase B suites>
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
jq empty openapi/phase1.json
git diff --check
```

Manual smoke with `company_access_management` enabled:

1. Director creates an HR Manager role.
2. Director assigns the role and one direct permission to an employee.
3. Employee sees the full directory and can perform only granted operations.
4. Employee cannot grant a permission outside their envelope.
5. Role-based invite delegation creates a company invitation but cannot create
   a deal seat or manage an existing invite.
6. Removing the employee clears all custom access.
7. Disabling the flag hides Phase B UI and returns 404 from Phase B routes.

Exit: all automated checks pass, migration replay passes, the smoke path is
recorded, and no unresolved security or contract finding remains.

Implementation is complete on `feat/company-access-management-phase-b` as of
2026-08-14. Full automated verification passed. Authenticated browser smoke was
unavailable because no browser session was connected; migration application and
feature-flag enablement remain rollout steps.
