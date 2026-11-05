# Company access management Phase B (#160)

**Date:** 2026-08-14
**Status:** Implemented
**Implementation:** 2026-08-14 on `feat/company-access-management-phase-b`
**Issue:** [#160](https://github.com/FutureProofingDev/intelibank/issues/160)
**Predecessor:** [Phase A design](./2026-08-14-company-admin-directory-design.md)

## PR boundary

The design was prepared while PR #175 was under review so the Phase A decisions
and Phase B direction stayed traceable together. PR #175 has since merged.
Phase B implementation now proceeds on a separate branch created from the
merged `develop` branch.

## Outcome

Company directors and same-tenant firm administrators can define company roles,
compose them from a small enforced permission catalogue, and assign roles or
individual additive permissions to internal employees. A delegated HR-style
role can manage the employee directory and access assignments only within the
authority its holder already possesses.

Phase B completes the roles CRUD, permission bundles, and per-employee access
assignment portions of #160. It does not add deal, document, or workflow
permissions.

## Current model

Conductia currently has four separate concepts:

| Concept | Storage | Authority |
|---|---|---|
| Firm authority | `users.firm_role` | `admin`, `cco` |
| Company control | `users.company_role` | `director`, `member` |
| Deal authority | `deal_memberships.deal_role` | `md`, `deal_team`, `legal`, `seller`, `buyer`, `read_only` |
| Invite delegation | `users.can_invite` | Company-level invite sending only |

The global `roles` table is a closed catalogue for deal and firm roles.
`roles.permissions` is displayed by Gate 0 but is not consulted by any
authorization decision. Phase B does not repurpose that table and does not make
its JSON authoritative.

## Goals

1. Company-scoped custom role CRUD.
2. Fixed, enforced company permission definitions.
3. Multiple role assignments per internal employee.
4. Additive direct permission grants for exceptions.
5. Source-aware effective permission resolution.
6. Delegated administration without privilege escalation.
7. Transactional writes with audit rows in the same database transaction.
8. Migration of the existing `can_invite` delegation to the new model.

## Non-goals

- Custom deal roles or deal-seat assignment.
- Document classification, deal, workflow, mail, or CCO permissions.
- Negative or deny overrides.
- Changing `firm_role`, `company_role`, or the last-director invariant.
- Granting director status through a custom role.
- Offboarding, suspend-versus-remove, or employment lifecycle redesign.
- External-company role administration.
- A hard-coded `hr` firm or company role.
- Mobile navigation work.

## Protected control plane

The following actors are company access roots:

- An active, internal director of the same bank company.
- An active firm administrator whose tenant matches the bank company tenant.

Roots implicitly hold every company permission. They do not need assignment
rows, and custom role edits cannot remove their root authority.

The existing `canManageCompanyMembers` predicate remains the only authority for
adding or removing employees and promoting or demoting directors. Custom
permissions cannot call those protected operations. This separation prevents a
custom HR role from becoming a deal-seat administrator through the existing
director shortcut.

CCO remains an oversight role, not a company access root. External users and
non-bank companies are outside Phase B.

## Permission catalogue

The migration is the source of truth. TypeScript constants and tests mirror it.

| Key | Label | Enforced behavior |
|---|---|---|
| `company:directory:view_all` | View full employee directory | Includes research and trading identity rows. It never exposes their deal data. |
| `company:invites:send` | Send company invitations | Company-level member invitations only. It does not permit deal invitations, resend, revoke, or director invitations. |
| `company:roles:manage` | Manage company roles | Create, edit, and archive custom roles within the actor's grant envelope. |
| `company:access:assign` | Assign employee access | Assign roles and direct permissions within the actor's grant envelope. |

The catalogue is intentionally small. A permission is added only together with
an application and database enforcement consumer.

## Effective permissions

For a non-root employee:

```text
effective permissions
  = union(permissions from active assigned roles)
  + union(active direct permission grants)
```

There are no deny rows. Removing a direct grant does not remove the same
permission when it is inherited from a role. API responses always identify the
source of each effective permission.

An employee must be active, internal, and attached to the bank company for
custom grants to be effective. A company change or removal deletes all custom
access assignments.

## Grant envelope

An actor with `company:roles:manage` may create or edit only a role whose
permission set is a subset of the actor's effective permissions before the
write. An actor with `company:access:assign` may assign only roles and direct
permissions whose complete permission set is a subset of that same pre-write
effective set.

Roots are exempt because they implicitly hold the full catalogue. Revocation is
allowed when the actor has the relevant management permission. Self-assignment
is allowed only within the envelope, so it cannot create authority.

All grant-envelope checks are repeated inside the transactional database write.
An API pre-check may improve the error response but is not authoritative.

## Schema

### `company_permissions`

- `key text primary key`
- `label text not null`
- `description text not null`
- `category text not null`
- `sort_order integer not null`
- A CHECK limiting keys to the four seeded values.

This is a global immutable catalogue. It is not company-editable.

### `company_roles`

- `id uuid primary key`
- `company_id uuid not null references companies(id) on delete cascade`
- `name text not null`
- `description text`
- `version bigint not null default 1`
- `created_by uuid not null references users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `archived_at timestamptz`
- Case-insensitive unique active name per company.
- Composite uniqueness on `(company_id, id)` for scoped foreign keys.

Role names are 2 to 80 trimmed characters. Archived roles cannot be edited or
assigned. A role can be archived only when it has no member assignments.

### `company_role_permissions`

- `company_id uuid not null`
- `role_id uuid not null`
- `permission_key text not null references company_permissions(key)`
- Primary key `(role_id, permission_key)`.
- Composite foreign key `(company_id, role_id)` to `company_roles`.

### `company_member_access`

- `company_id uuid not null`
- `user_id uuid not null`
- `version bigint not null default 1`
- `updated_at timestamptz not null default now()`
- Primary key `(company_id, user_id)`.

This is the concurrency parent for an employee's role and direct grant sets.
The database verifies that the user is active, internal, and currently attached
to the same bank company.

### `company_member_roles`

- `company_id uuid not null`
- `user_id uuid not null`
- `role_id uuid not null`
- `assigned_by uuid not null references users(id)`
- `created_at timestamptz not null default now()`
- Primary key `(user_id, role_id)`.
- Scoped foreign keys to `company_member_access` and `company_roles`.

### `company_member_permissions`

- `company_id uuid not null`
- `user_id uuid not null`
- `permission_key text not null references company_permissions(key)`
- `granted_by uuid not null references users(id)`
- `created_at timestamptz not null default now()`
- Primary key `(user_id, permission_key)`.
- Scoped foreign key to `company_member_access`.

These rows are grants only. Phase B has no deny model.

### Membership lifecycle

The existing company-removal trigger is extended so a change away from a
company deletes that user's `company_member_access` row. Child assignments then
cascade. This keeps custom authority from following a person to another
employer.

## Authoritative SQL functions

The schema adds fail-closed functions:

- `app_company_is_access_root(actor_id, company_id)`
- `app_company_effective_permissions(user_id, company_id)`
- `app_has_company_permission(user_id, company_id, permission_key)`

They enforce active status, internal-user status, bank-company scope, tenant
coherence, role archival state, direct grants, and protected roots. The
TypeScript helper calls these functions rather than reimplementing the joins.

All write RPCs execute only for `service_role`, re-read authority inside the
transaction, lock the mutated role or member-access parent, apply the grant
envelope, mutate rows, increment the version, and insert audit rows before
returning.

## `can_invite` migration

`users.can_invite` is replaced as an authorization source, not merely wrapped.

1. Backfill `company:invites:send` as a direct grant for every active internal
   company member with `can_invite = true`.
2. Change `userCanInviteChecked`, proposal feasibility, invite lookup, and the
   transactional invite RPC to use `app_has_company_permission` for
   company-level invitations.
3. Keep deal-attached invitation authority unchanged.
4. Route the deprecated `{ canInvite }` PATCH branch through the member-access
   transaction during one compatibility release. It changes only the direct
   grant. If the permission is inherited, clearing the direct grant leaves the
   effective permission true and the response reports its role source.
5. Keep `users.can_invite` temporarily as a synchronized direct-grant
   projection. No authorization code may read it after the migration.
6. Remove the column and deprecated PATCH branch in a later contract migration
   after all callers use the source-aware access API.

There is one authoritative resolver throughout this transition. The legacy
column is compatibility output, not a fallback authorization path.

## Tenant and wall hardening

Before new endpoints use company visibility, `userCanViewCompany` must be made
tenant-aware for firm overseers. Its current CCO/admin branch returns true
without checking the target company's tenant.

`company:directory:view_all` grants access to employee identity rows from
research and trading. It does not grant company search, deal discovery, deal
membership, document, inbox, or invitation authority. Existing wall checks on
those surfaces remain unchanged.

## API

All Phase B endpoints are behind a new fail-closed
`company_access_management` feature flag.

### `GET /api/v1/companies/{companyId}/roles`

Returns the permission catalogue, active roles, permission bundles, assignment
counts, versions, and the viewer's effective company permissions. Requires
`company:roles:manage` or `company:access:assign`.

### `POST /api/v1/companies/{companyId}/roles`

Creates a role from `{ name, description, permissionKeys }`. Requires
`company:roles:manage` and the grant envelope. The transactional RPC creates the
role, permissions, and audit row atomically.

### `PATCH /api/v1/companies/{companyId}/roles/{roleId}`

Replaces editable metadata and the exact permission set using
`{ expectedVersion, name, description, permissionKeys }`. A stale version
returns 409. The response includes the new version.

### `DELETE /api/v1/companies/{companyId}/roles/{roleId}`

Archives an unassigned role. `expectedVersion` is required. Assigned roles
return 409 with the current assignment count. Rows are retained for audit
traceability.

### `GET /api/v1/companies/{companyId}/members/{userId}/access`

The target user may read their own effective permissions. A root or actor with
`company:access:assign` may read another internal employee. The response
contains assigned roles, direct grants, effective permissions with sources,
and the member access version.

### `PATCH /api/v1/companies/{companyId}/members/{userId}/access`

Atomically replaces the exact role and direct-grant sets:

```json
{
  "expectedVersion": 4,
  "roleIds": ["..."],
  "directPermissions": ["company:invites:send"]
}
```

Requires `company:access:assign`, target eligibility, the grant envelope, and a
matching version. The response returns the new source-aware effective set.

### Existing endpoints

- `/api/v1/me` returns `company_permissions` for the current company.
- Company-member GET uses `company:directory:view_all` in addition to roots
  when deciding whether `includeWalled=true` is honored.
- Existing add/remove/promote/demote operations remain root-only.
- The legacy company-member `{ canInvite }` PATCH is deprecated as described
  above.
- `/api/v1/roles` remains the fixed deal and firm role catalogue.

## UI

### Company navigation

The Company area gains linked desktop tabs:

- People: `/companies/{companyId}/members`
- Roles & permissions: `/companies/{companyId}/roles`

The existing AppRail entry remains unchanged. Mobile navigation stays deferred.

### People

- Role chips appear on each internal employee.
- A source-aware access drawer shows assigned roles, direct grants, and
  effective permissions.
- Actors with `company:access:assign` can edit role assignments and direct
  grants using the versioned API.
- The editor prevents selection outside the viewer's grant envelope.
- Walled employee identity rows are visible only to roots or actors with
  `company:directory:view_all`.
- Director status and firm roles are shown as protected authority and are not
  editable in the custom access drawer.
- Existing preferred deal role and invitation behavior remain separate.

### Roles & permissions

- Role list with member and permission counts.
- Create and edit form with a fixed permission checklist grouped by category.
- Clear risk copy for `company:roles:manage` and `company:access:assign`.
- Assigned roles cannot be archived until assignments are removed.
- No free-form permission strings and no deal-role mapping.

An HR Manager role is a normal company-created role, not a new schema enum. A
director can compose it from directory, invitation, role-management, or
access-assignment permissions as appropriate for that company.

## Audit

- Role creation uses `create` with reason `company_role_created`.
- Role metadata or bundle replacement uses a new `update` audit action with
  before/after metadata and permission diffs.
- Role archival uses `update` with reason `company_role_archived`.
- Role assignments and direct grants use `grant` and `revoke`, one row per
  effective diff.
- Every row carries `company_id`, target user or role, source type, permission
  key where relevant, actor, and access version in `detail`.

The migration widens the audit action CHECK and TypeScript constants with
`update`. Writes and audit rows are committed in the same RPC transaction.

## RLS

All new tables have RLS enabled. Authenticated clients receive no direct write
policies. Service-role APIs own writes. Read policies are company-scoped and
delegate to the authoritative SQL resolver where required.

The existing `users_select` policy is updated so a same-company actor with
`company:directory:view_all` can read employee identity rows while deal and
document policies remain unchanged.

## Feature flag and rollout

`company_access_management` is added to the typed flag registry and defaults
off. The schema and backfill may deploy while the flag is off. Authorization
switch-over for `company:invites:send` is covered by database and TypeScript
parity tests before the flag is enabled.

Recommended rollout:

1. Apply schema, functions, backfill, and compatibility projection.
2. Deploy resolver, APIs, and UI with the flag off.
3. Verify backfill and resolver parity in the target environment.
4. Enable for one bank company and exercise role, assignment, invite, and
   revocation flows.
5. Enable broadly.
6. Remove the legacy `can_invite` contract in a later migration.

## Acceptance criteria

- A director creates, edits, and archives an unassigned company role.
- A role bundle contains only fixed company permissions.
- An access manager assigns multiple roles and additive direct grants.
- Effective permissions include source attribution and update immediately.
- A delegated actor cannot create or assign authority outside their envelope.
- No custom permission grants a deal seat, director status, deal invitation,
  document access, company search, or mail access.
- Existing `can_invite = true` users retain company-invite behavior after the
  backfill and switch-over.
- Removing or moving an employee deletes all custom company access.
- Cross-company and cross-tenant reads and writes fail closed.
- All mutations are transactional and audited.
- The feature is unavailable while `company_access_management` is off.

## Deferred after Phase B

- Deal and document permission enforcement from the legacy role JSON.
- Negative permission overrides.
- External-company custom roles.
- Employment lifecycle and offboarding redesign.
- Platform-wide department wall enforcement in the existing invitee path.
- Mobile Company navigation.
