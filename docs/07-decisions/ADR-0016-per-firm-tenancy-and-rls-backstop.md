# ADR-0016: Per-firm tenancy with RLS as the backstop

Status: Accepted, September 23, 2026 (team sign-off on the PL-01 remediation).
Issues: #78, #79. Decision: D63. Plan of record:
[`docs/03-engineering/rls-overseer-finding/`](../03-engineering/rls-overseer-finding/) on
`docs/rls-overseer-finding`. Migration `supabase/migrations/20260928120000_rls_deal_scoped_policies.sql`;
proof `supabase/tests/rls_deal_scoped_policies.sql`.

## Context

Conductia runs every firm in one shared Postgres. Since v0.6.0 each onboarded firm owns
its own tenant (D54). The app reads and writes through the service role and enforces
access in `src/lib/api/v1/access.ts` and `documentAccess.ts`. The publishable key ships
in the browser, and the deal tables are granted `select` to `authenticated`, so a
signed-in user can also read them through `/rest/v1/*` without entering Next.js. On that
path RLS is the only control.

Five read policies (`deal_parties`, `deal_memberships`, `documents`, `audit_log`,
`deal_steps`) let a cco or admin through with `app_is_overseer`, which tests the firm role
and never the tenant. With one tenant per firm, each firm's admin or cco could read every
other firm's deal rows, MNPI included. `feature_flags_write` let the same roles write the
one global flag table.

## Decision

The database stays shared and the tenant is the isolation boundary. RLS is the backstop:
for every user, a direct read as `authenticated` returns what the app would show, or less,
and never another tenant's rows. The grants stay and the policies are corrected, because a
revoke answers "permission denied" and proves nothing about isolation.

- **Overseer checks are tenant-bound.** Deal-keyed policies call
  `app_is_deal_overseer(deal_id, auth.uid())`, which requires the deal's tenant to be the
  caller's. `app_is_overseer` is allowed only in `users_select`, `deals_select` and the
  company-level branch of `audit_log_select`, each of which carries its own tenant term.
- **The walls match the app.** `documents_select` applies the room wall to everyone,
  overseers included, and keeps class-4 rows to the deal MD and same-tenant overseers. The
  document list route drops the same class-4 rows (D1: the app tightens to RLS).
  `deal_steps_select` excludes external users, as the steps route does.
- **Company-level audit rows belong to the actor's tenant** (D2). A row with no actor is
  hidden from overseers.
- **`feature_flags` is service-role only** (D3). The table has no tenant column, so no
  policy can fence it. Reopening it to `authenticated` needs a tenant column or a
  platform-admin role distinct from `firm_role`, and a new ADR.
- **Service-role-only tables hold no `authenticated` privilege.** Supabase's default
  privileges grant every privilege on a new `public` table, so revoking `select` alone
  leaves write, `truncate` and `trigger` behind. Such tables get `revoke all`.

## Enforcement

`supabase/tests/rls_deal_scoped_policies.sql` runs in CI's `integration` job on every PR.
It seeds two tenants, asserts the row matrix per actor and table as `authenticated`,
asserts the privilege end state, and lints `pg_policies`: any policy outside the allowlist
that calls `app_is_overseer(` or reads `firm_role` inline fails the build. A permanent
self-test proves the lint fires.

## Consequences and limits

A new deal-scoped table needs a policy built on `app_is_deal_overseer` and a probe case,
or no `authenticated` grant at all. Adding an allowlist entry is a reviewed change to the
probe. The audit route still shows members some names RLS hides; that is tracked
separately and ships before or with this change. The rollback file reopens both leaks
and exists only to recover from a broken forward migration.
