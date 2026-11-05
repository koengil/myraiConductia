# Preferred Deal Role + Colleague Directory (#160 Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Company directors/admins can assign each internal colleague a preferred deal role (`deal_team | legal | read_only`) that prefills future deal assignment, on a searchable members page that can also show walled departments — per the approved spec `docs/superpowers/specs/2026-08-14-company-admin-directory-design.md`.

**Architecture:** One nullable `users.preferred_deal_role` column (DB CHECK mirrors a new shared `INTERNAL_ASSIGNABLE_DEAL_ROLES` constant). The existing member PATCH/GET/POST routes are extended in place (single-field CAS pattern preserved); the invite lookup carries the preference into its existing recommendation; Gate 0 and InviteModal consume it as prefill only. No new endpoints, no new tables.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase (SQL migration), TypeScript, Vitest + RTL.

## Global Constraints

- **No commits without authorization:** Martin's session rule — git mutations in this repo require per-action authorization. Pause at each commit step unless authorization was granted for the whole run.
- **Branch:** base work on `develop` (never `main`).
- All artifacts (code, comments, identifiers, docs) in English. No em-dashes in visible copy (brand rule); statements, not questions.
- Responses stay snake_case (`preferred_deal_role`, `is_walled`); request bodies camelCase (`preferredDealRole`) — matching `company_role` / `canInvite` convention (spec decision 10).
- The preference grants nothing: it never creates or modifies a deal membership. Product copy: "Preferred role for future deal assignments. Administrators still confirm it when adding this person to a deal."
- Flag: only the PATCH `preferredDealRole` branch, the page's preferred-role control, and Gate 0 prefill are gated by `platform_onboarding` (`isFlagEnabled` server-side, `useFlag` client-side). GET `includeWalled` is predicate-gated only.
- Migration is the source of truth for enums; `src/lib/constants/*` mirrors it (ADR-0008); `tests/constants-schema-sync.test.ts` enforces the mirror.
- Run tests with `npx vitest run <file>`; full check `npm test` (or the repo's `npm run test` script) plus `npx tsc --noEmit` before finishing.

---

### Task 1: Migration + shared allowlist constant

**Files:**
- Create: `supabase/migrations/20260814120000_preferred_deal_role.sql`
- Modify: `src/lib/constants/roles.ts` (append after `COMPANY_ROLES`, line ~40)
- Modify: `src/lib/api/v1/proposalFeasibility.ts:35-39`
- Test: `tests/constants-schema-sync.test.ts`

**Interfaces:**
- Consumes: `DEAL_ROLE`, `DealRole` from `src/lib/constants/roles.ts`.
- Produces: `INTERNAL_ASSIGNABLE_DEAL_ROLES: readonly DealRole[]` and `resolvePreferredDealRole(value: string | null | undefined): DealRole | null` exported from `@/lib/constants/roles` — every later task imports these. DB column `users.preferred_deal_role text NULL`.

- [ ] **Step 1: Write the failing sync test**

Add to `tests/constants-schema-sync.test.ts`, following that file's existing read-the-migration pattern (it already reads migration SQL and compares CHECK lists; reuse its helper if one exists, else):

```ts
import { INTERNAL_ASSIGNABLE_DEAL_ROLES, resolvePreferredDealRole } from '@/lib/constants/roles';

describe('preferred_deal_role', () => {
  it('CHECK allowlist matches INTERNAL_ASSIGNABLE_DEAL_ROLES', () => {
    const sql = readFileSync(
      'supabase/migrations/20260814120000_preferred_deal_role.sql',
      'utf8',
    );
    const inList = /preferred_deal_role in \(([^)]+)\)/i.exec(sql)?.[1] ?? '';
    const slugs = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(slugs).toEqual([...INTERNAL_ASSIGNABLE_DEAL_ROLES].sort());
  });

  it('resolvePreferredDealRole accepts only the allowlist', () => {
    expect(resolvePreferredDealRole('legal')).toBe('legal');
    expect(resolvePreferredDealRole('md')).toBeNull();
    expect(resolvePreferredDealRole('seller')).toBeNull();
    expect(resolvePreferredDealRole('admin')).toBeNull();
    expect(resolvePreferredDealRole(null)).toBeNull();
    expect(resolvePreferredDealRole(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/constants-schema-sync.test.ts`
Expected: FAIL (no export `INTERNAL_ASSIGNABLE_DEAL_ROLES`, missing migration file).

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260814120000_preferred_deal_role.sql`:

```sql
-- Preferred deal role (#160 Phase A, spec 2026-08-14-company-admin-directory-design).
-- A company-managed PREFERENCE that prefills future deal assignment. It grants
-- nothing, never creates or modifies a deal membership, and administrators
-- still confirm the role when adding the person to a deal.
-- Company-defined roles CRUD is deliberately deferred; the platform `roles`
-- enum stays closed. Allowlist mirrors INTERNAL_ASSIGNABLE_DEAL_ROLES in
-- src/lib/constants/roles.ts (this migration is the source of truth).
alter table users
  add column preferred_deal_role text null references roles(slug);

alter table users
  add constraint users_preferred_deal_role_internal_check
  check (
    preferred_deal_role is null
    or preferred_deal_role in ('deal_team', 'legal', 'read_only')
  );
```

- [ ] **Step 4: Add the constants**

In `src/lib/constants/roles.ts`, after the `COMPANY_ROLES` block:

```ts
/**
 * Deal roles an internal colleague can be granted or prefer. `md` is the
 * protected creator seat, `seller`/`buyer` are external party seats, and
 * firm roles are not deal seats. Mirrors the users_preferred_deal_role
 * CHECK in supabase/migrations/20260814120000_preferred_deal_role.sql and
 * the internal-invitation rule (proposalFeasibility).
 */
export const INTERNAL_ASSIGNABLE_DEAL_ROLES: readonly DealRole[] = [
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
  DEAL_ROLE.READ_ONLY,
];

/** Narrow an untrusted value to an assignable preferred role, else null. */
export function resolvePreferredDealRole(
  value: string | null | undefined,
): DealRole | null {
  return (INTERNAL_ASSIGNABLE_DEAL_ROLES as readonly string[]).includes(value ?? '')
    ? (value as DealRole)
    : null;
}
```

- [ ] **Step 5: Reuse it in proposalFeasibility**

In `src/lib/api/v1/proposalFeasibility.ts`, replace the array literal (keep the exported name — other modules import it):

```ts
import { INTERNAL_ASSIGNABLE_DEAL_ROLES } from '@/lib/constants/roles';

/** Seats an internal (bank-company) invitee may take. `md` is never invitable. */
export const INTERNAL_PROPOSAL_DEAL_ROLES: string[] = [...INTERNAL_ASSIGNABLE_DEAL_ROLES];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/constants-schema-sync.test.ts tests/api-v1-invite-preflight.test.ts`
Expected: PASS (feasibility behavior unchanged).

- [ ] **Step 7: Commit** (authorization required per Global Constraints)

```bash
git add supabase/migrations/20260814120000_preferred_deal_role.sql src/lib/constants/roles.ts src/lib/api/v1/proposalFeasibility.ts tests/constants-schema-sync.test.ts
git commit -m "feat(members): preferred_deal_role column + shared internal allowlist (#160)"
```

---

### Task 2: PATCH members/[userId] — preferredDealRole branch

**Files:**
- Modify: `src/app/api/v1/companies/[companyId]/members/[userId]/route.ts:76-154` (PATCH only)
- Test: `tests/api-v1-members-patch.test.ts`

**Interfaces:**
- Consumes: `INTERNAL_ASSIGNABLE_DEAL_ROLES`, `resolvePreferredDealRole` (Task 1); existing `canManageCompanyMembers`, `AUDIT_ACTION`, `isFlagEnabled` from `@/lib/api/v1/requireFlag`.
- Produces: `PATCH` accepts exactly one of `{ canInvite: boolean }` or `{ preferredDealRole: 'deal_team' | 'legal' | 'read_only' | null }`; responses now select/return `preferred_deal_role` alongside `can_invite`. Audit reason string `'company_preferred_deal_role_changed'`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-v1-members-patch.test.ts` (reuse the file's `makeAdmin`/`signedIn` helpers and `activeStatus`; the mocked `users` responses are consumed in order: actor status probe, before-read, CAS update, restore). Mock the flag module at the top of the file:

```ts
vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
```

Update the local `row` helper to carry the new columns, and add a role-request helper:

```ts
const roleReq = (preferredDealRole: string | null | boolean) =>
  new Request('http://test/api/v1/companies/c1/members/u2', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferredDealRole }),
  });
const roleRow = (
  preferred: string | null,
  extra: Partial<{ department: string | null; is_external: boolean }> = {},
): Resp => ({
  data: {
    id: 'u2', email: 'alex@bank.dev', company_id: 'c1', company_role: 'member',
    can_invite: false, preferred_deal_role: preferred,
    department: extra.department ?? 'ib', is_external: extra.is_external ?? false,
  },
  error: null,
});

describe('PATCH members/[userId] preferred_deal_role', () => {
  it('sets a preferred role and audits a grant', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), roleRow('legal')],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { preferred_deal_role: string } };
    expect(body.member.preferred_deal_role).toBe('legal');
    expect(admin.from).toHaveBeenCalledWith('audit_log');
  });

  it('clears a preferred role and audits a revoke', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow('legal'), roleRow(null)],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);
    const res = await PATCH(roleReq(null), ctx);
    expect(res.status).toBe(200);
  });

  it.each(['md', 'seller', 'buyer', 'admin', 'cco', 'bogus', true])(
    'rejects disallowed value %s with 400',
    async (value) => {
      const admin = makeAdmin({ users: [activeStatus] });
      signedIn(admin);
      const res = await PATCH(roleReq(value as string), ctx);
      expect(res.status).toBe(400);
    },
  );

  it('rejects a request carrying both fields', async () => {
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canInvite: true, preferredDealRole: 'legal' }),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a request carrying neither field', async () => {
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a walled target', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null, { department: 'research' })],
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects an external target', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null, { is_external: true })],
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects when platform_onboarding is off', async () => {
    vi.mocked(isFlagEnabled).mockResolvedValueOnce(false);
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(400);
  });

  it('short-circuits an idempotent role write without auditing', async () => {
    const admin = makeAdmin({ users: [activeStatus, roleRow('legal')] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith('audit_log');
  });

  it('409s when the role changed concurrently (CAS miss)', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), { data: null, error: null }],
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(409);
  });

  it('restores the previous role when the audit write fails', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), roleRow('legal'), { data: null, error: null }],
      audit_log: { data: null, error: { message: 'audit store down' } },
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(500);
    const userCalls = admin.from.mock.calls.filter((call) => call[0] === 'users');
    expect(userCalls.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/api-v1-members-patch.test.ts`
Expected: new describe FAILs (400s where 200 expected etc.); the three existing can_invite tests still PASS.

- [ ] **Step 3: Implement the branch**

Rework `PATCH` in `src/app/api/v1/companies/[companyId]/members/[userId]/route.ts`. Imports to add: `INTERNAL_ASSIGNABLE_DEAL_ROLES, resolvePreferredDealRole` and `DEPARTMENT` from `@/lib/constants/roles`; `isFlagEnabled` from `@/lib/api/v1/requireFlag`. Replace the body-parse-and-below section:

```ts
const MEMBER_COLUMNS =
  'id, email, company_id, company_role, can_invite, preferred_deal_role, department, is_external';

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, userId } = await context.params;

  const allowed = await canManageCompanyMembers(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Only a company director can change member settings', 403);

  let body: { canInvite?: boolean; preferredDealRole?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  // Exactly one settable field per request: the CAS + audit + rollback below
  // is single-field by design (spec decision, mirrors the original toggle).
  const fields = (['canInvite', 'preferredDealRole'] as const).filter((k) => k in body);
  if (fields.length !== 1) {
    return jsonError('Send exactly one of canInvite or preferredDealRole', 400);
  }
  const field = fields[0];

  if (field === 'canInvite' && typeof body.canInvite !== 'boolean') {
    return jsonError('canInvite must be a boolean', 400);
  }
  if (field === 'preferredDealRole') {
    if (!(await isFlagEnabled('platform_onboarding'))) {
      return jsonError('preferredDealRole is not available', 400);
    }
    if (body.preferredDealRole !== null && !resolvePreferredDealRole(body.preferredDealRole)) {
      return jsonError('preferredDealRole must be deal_team, legal, read_only, or null', 400);
    }
  }

  // Read the real previous value first: the rollback below must restore it,
  // and an idempotent request short-circuits without an audit entry.
  const { data: before, error: beforeError } = await auth.admin
    .from('users')
    .select(MEMBER_COLUMNS)
    .eq('id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (beforeError) return jsonError(beforeError.message, 500);
  if (!before) return jsonError('User is not a member of this company', 404);

  if (field === 'preferredDealRole') {
    // The preference exists to prefill deal seats. External users and walled
    // departments can never take an internal seat, so they cannot hold one.
    const walled =
      before.department === DEPARTMENT.RESEARCH || before.department === DEPARTMENT.TRADING;
    if (before.is_external || walled) {
      return jsonError('Preferred roles apply to internal, non-walled members only', 403);
    }
  }

  const column = field === 'canInvite' ? 'can_invite' : 'preferred_deal_role';
  const nextValue = field === 'canInvite' ? body.canInvite : body.preferredDealRole;
  const beforeValue = before[column];
  if (beforeValue === nextValue) {
    return NextResponse.json({ member: before });
  }

  // Compare-and-swap on the value just read: a concurrent change makes this
  // match zero rows instead of silently overwriting it.
  const { data: member, error } = await auth.admin
    .from('users')
    .update({ [column]: nextValue })
    .eq('id', userId)
    .eq('company_id', companyId)
    .eq(column, beforeValue)
    .select(MEMBER_COLUMNS)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!member) {
    return jsonError('The member setting changed concurrently. Reload and retry.', 409);
  }

  const detail =
    field === 'canInvite'
      ? {
          reason: 'company_invite_delegation',
          user: userId,
          company_id: companyId,
          can_invite: nextValue,
        }
      : {
          reason: 'company_preferred_deal_role_changed',
          user: userId,
          company_id: companyId,
          old_preferred_deal_role: beforeValue,
          new_preferred_deal_role: nextValue,
        };
  const granted = field === 'canInvite' ? nextValue === true : nextValue !== null;
  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: granted ? AUDIT_ACTION.GRANT : AUDIT_ACTION.REVOKE,
    detail,
  });
  if (auditError) {
    // No unrecorded permission change: restore the actual previous value,
    // but only over our own write (a concurrent success is never undone).
    // Durable fix is a transactional RPC; tracked for the RLS/hardening pass.
    const { error: restoreError } = await auth.admin
      .from('users')
      .update({ [column]: beforeValue })
      .eq('id', userId)
      .eq('company_id', companyId)
      .eq(column, nextValue);
    if (restoreError) {
      return jsonError('Unable to record the change and the setting was not restored. Retry.', 500);
    }
    return jsonError('Unable to record the change. Try again.', 500);
  }

  return NextResponse.json({ member });
}
```

Note the CAS on a NULL previous value: PostgREST `.eq(column, null)` compiles to `=.null` which never matches. Supabase's query builder handles this via `.is()`. Use:

```ts
const casMatch = (q: ReturnType<typeof auth.admin.from>) =>
  beforeValue === null ? q.is(column, null) : q.eq(column, beforeValue);
```

and apply it in both the CAS update and the restore (the test mock chains `.is` the same as `.eq`; add `builder.is = chain;` to `makeAdmin` in the test file).

- [ ] **Step 4: Run the full test file**

Run: `npx vitest run tests/api-v1-members-patch.test.ts`
Expected: all PASS, including the pre-existing can_invite trio (their responses lack the new columns; loosen `roleRow`/`row` usage or extend `row` with `preferred_deal_role: null, department: 'ib', is_external: false` so the shared code paths behave).

- [ ] **Step 5: Commit** (authorization required)

```bash
git add "src/app/api/v1/companies/[companyId]/members/[userId]/route.ts" tests/api-v1-members-patch.test.ts
git commit -m "feat(members): preferredDealRole PATCH branch with CAS + audit (#160)"
```

---

### Task 3: GET roster `includeWalled` + POST walled-director rejection

**Files:**
- Modify: `src/app/api/v1/companies/[companyId]/members/route.ts` (GET lines 24-45, POST lines 80-96)
- Test: `tests/api-v1-members-get.test.ts` (extend, following its existing mock style)

**Interfaces:**
- Consumes: `canManageCompanyMembers` (already imported in the file), `DEPARTMENT`.
- Produces: `GET .../members` rows now include `preferred_deal_role`; with `?includeWalled=true` and a managing viewer, walled rows appear with `is_walled: true` (all rows carry `is_walled`). `POST` 403s when promoting a walled user to director.

- [ ] **Step 1: Write the failing tests**

Extend `tests/api-v1-members-get.test.ts` using its existing helpers (read the file first; mirror its signed-in + admin mock setup):

```ts
it('includes walled rows only for a managing viewer with ?includeWalled=true', async () => {
  // canManageCompanyMembers mocked true; users select resolves rows including
  // one department:'research' row (mock returns whatever the builder resolves,
  // so assert on the response mapping):
  const res = await GET(
    new Request('http://test/api/v1/companies/c1/members?includeWalled=true'),
    ctx,
  );
  const body = (await res.json()) as { members: Array<{ is_walled: boolean }> };
  expect(body.members.some((m) => m.is_walled)).toBe(true);
});

it('ignores includeWalled for a non-managing viewer (wall filter intact)', async () => {
  // canManageCompanyMembers mocked false → the walled-exclusion .or filter is
  // applied; assert the query builder received the .or clause (spy) and that
  // returned rows all have is_walled false.
});

it('returns preferred_deal_role per member on the bare endpoint', async () => {
  const res = await GET(new Request('http://test/api/v1/companies/c1/members'), ctx);
  const body = (await res.json()) as { members: Array<Record<string, unknown>> };
  expect(body.members[0]).toHaveProperty('preferred_deal_role');
});

it('POST rejects promoting a walled user to director', async () => {
  // target select resolves { id, company_id: null, department: 'trading' };
  // body { email, companyRole: 'director' } → 403.
});
```

(Adapt assertion mechanics to the file's actual mock helper — it may capture builder calls; the four behaviors above are the contract.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/api-v1-members-get.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement GET**

Replace the GET body query section in `src/app/api/v1/companies/[companyId]/members/route.ts`:

```ts
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompany(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to view this company roster', 403);

  // Walled rows are opt-in and manager-only (spec decision 6): the bare
  // endpoint keeps its exact shape so Gate 0 stays wall-safe by default.
  const wantsWalled =
    new URL(request.url).searchParams.get('includeWalled') === 'true';
  const managing = wantsWalled
    ? await canManageCompanyMembers(auth.admin, auth.user.id, companyId)
    : false;

  let query = auth.admin
    .from('users')
    .select(
      'id, full_name, display_name, email, department, company_role, can_invite, preferred_deal_role',
    )
    .eq('company_id', companyId)
    .eq('is_external', false);
  if (!managing) {
    // Exclude only the walled departments; keep members with a null department
    // (three-valued logic would otherwise drop them from a plain NOT IN).
    query = query.or(
      `department.is.null,department.not.in.(${DEPARTMENT.RESEARCH},${DEPARTMENT.TRADING})`,
    );
  }
  const { data, error } = await query.order('full_name');
  if (error) return jsonError(error.message, 500);

  const members = (data ?? []).map((m) => ({
    ...m,
    is_walled:
      m.department === DEPARTMENT.RESEARCH || m.department === DEPARTMENT.TRADING,
  }));
  return NextResponse.json({ members });
}
```

Change the GET signature's first parameter from `_request` to `request`.

- [ ] **Step 4: Implement the POST guard**

In POST, extend the target select and add the check after the existing "already belongs to another company" guard:

```ts
  const { data: target, error: targetError } = await auth.admin
    .from('users')
    .select('id, company_id, department')
    .eq('email', email)
    .maybeSingle();
```

```ts
  // A director manages seats on every deal the bank owns, so a walled
  // (research/trading) user must never hold the directorship (spec decision 7).
  const walled =
    target.department === DEPARTMENT.RESEARCH || target.department === DEPARTMENT.TRADING;
  if (walled && companyRole === COMPANY_ROLE.DIRECTOR) {
    return jsonError('A walled-department member cannot be a company director', 403);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/api-v1-members-get.test.ts tests/api-v1-members-patch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (authorization required)

```bash
git add "src/app/api/v1/companies/[companyId]/members/route.ts" tests/api-v1-members-get.test.ts
git commit -m "feat(members): opt-in walled roster + walled-director guard (#160)"
```

---

### Task 4: Invite lookup carries the employee default

**Files:**
- Modify: `src/app/api/v1/invites/lookup/route.ts:273-317` (existing-user query + disclosure block) and `:358-396` (recommendation block)
- Test: `tests/lookup-warnings.test.ts` (extend, following its existing harness)

**Interfaces:**
- Consumes: `INTERNAL_ASSIGNABLE_DEAL_ROLES`, `resolvePreferredDealRole` (Task 1); column `users.preferred_deal_role` (Task 1).
- Produces: for a bank-company match, `recommendation.reasons.dealRole` is `'employee_default'` (with `recommendation.dealRole` = the target's preference) when and only when the existing user may be disclosed AND `existingUser.company_id === companyMatch.companyId` AND the preference is a valid internal role; otherwise the existing `'bank_internal_seat'` / `DEAL_TEAM` shape, byte-identical to today.

- [ ] **Step 1: Write the failing tests**

Extend `tests/lookup-warnings.test.ts` (reuse its request/mock harness; the behaviors to pin):

```ts
it('recommends the employee preferred role for a disclosable same-company colleague', async () => {
  // existingUser: { id, company_id: BANK_ID, tenant_id: actorTenant, preferred_deal_role: 'legal' }
  // actor shares the company → mayDisclose true; companyMatch is the bank.
  // Expect recommendation.dealRole 'legal', reasons.dealRole 'employee_default'.
});

it('falls back to deal_team when the colleague has no preference', async () => {
  // preferred_deal_role: null → dealRole 'deal_team', reasons.dealRole 'bank_internal_seat'.
});

it('never leaks a preference cross-company', async () => {
  // existingUser.company_id !== companyMatch.companyId (or mayDisclose false)
  // with preferred_deal_role 'legal' → dealRole stays 'deal_team',
  // reasons.dealRole 'bank_internal_seat'.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/lookup-warnings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/app/api/v1/invites/lookup/route.ts`:

(a) Extend the constant-schedule user query (line ~275) — same single query, two more columns:

```ts
  const { data: existingUser, error: userError } = await auth.admin
    .from('users')
    .select('id, company_id, tenant_id, preferred_deal_role')
    .eq('email', email)
    .maybeSingle();
```

(b) Hoist `mayDisclose` so the recommendation block can read it. Replace the `if (existingUser) { ... }` disclosure block:

```ts
  let mayDisclose = false;
  if (existingUser) {
    // A17's three branches, each requiring explicit tenant equality. A firm
    // overseer's reach is tenant-wide, never cross-tenant (#116/#141/#144).
    const sameTenant = existingUser.tenant_id === actor.tenant_id;
    const sharesCompany =
      Boolean(actor.company_id) && existingUser.company_id === actor.company_id;
    const isOverseer = actor.firm_role === 'cco' || actor.firm_role === 'admin';
    mayDisclose =
      sameTenant && (sharesCompany || isOverseer || (Boolean(seat) && overDealMembership));
    if (mayDisclose) found.add(WARNING.EXISTING_PLATFORM_USER);

    // A18: the seat fact is gated on authority over THIS deal's membership.
    if (seat && (overDealMembership || isDealMd)) found.add(WARNING.EXISTING_DEAL_SEAT);
  }
```

(c) In the recommendation block's `isBank` branch:

```ts
    if (isBank) {
      // Gate 0's case. A bank seat has no party relationship to derive from and
      // no phase to raise: phase gates external users only. When the address is
      // a disclosable colleague of this exact bank company, their company-set
      // preference becomes the recommendation (#160 Phase A); the preference
      // proposes, the inviter still decides.
      const preferred =
        mayDisclose && existingUser?.company_id === companyMatch.companyId
          ? resolvePreferredDealRole(existingUser.preferred_deal_role)
          : null;
      recommendation = {
        dealRole: preferred ?? DEAL_ROLE.DEAL_TEAM,
        companyRole: COMPANY_ROLE.MEMBER,
        phase: 0,
        reasons: {
          dealRole: preferred ? 'employee_default' : 'bank_internal_seat',
          phase: 'phase_not_applicable_internal',
        },
      };
    }
```

- [ ] **Step 4: Run the lookup suites**

Run: `npx vitest run tests/lookup-warnings.test.ts tests/lookup-indistinguishable.test.ts`
Expected: PASS (the indistinguishability suite must pass untouched — the query count and shape did not change).

- [ ] **Step 5: Commit** (authorization required)

```bash
git add src/app/api/v1/invites/lookup/route.ts tests/lookup-warnings.test.ts
git commit -m "feat(invites): lookup recommends the employee preferred role (#160)"
```

---

### Task 5: InviteModal applies the role recommendation

**Files:**
- Modify: `src/components/team/InviteModal.tsx` (state ~126-151, onResult ~390-445, role select ~476-489)
- Test: `tests/invite-modal-lookup.test.tsx` (extend)

**Interfaces:**
- Consumes: `recommendation.dealRole` + `reasons.dealRole === 'employee_default'` from lookup (Task 4); local `INTERNAL_DEAL_ROLES`.
- Produces: the internal-role select prefills from the recommendation and retracts symmetrically with the existing phase pattern; a role the inviter touched is never overwritten or withdrawn.

- [ ] **Step 1: Write the failing tests**

Extend `tests/invite-modal-lookup.test.tsx` (reuse its render + mocked-lookup harness):

```ts
it('applies an internal role recommendation to the untouched role select', async () => {
  // lookup resolves { companyMatch: bank, recommendation: { dealRole: 'legal',
  // phase: 0, reasons: { dealRole: 'employee_default', ... } } }
  // → role select value becomes 'legal'.
});

it('does not overwrite a role the inviter already chose', async () => {
  // user selects 'read_only' first (fires roleTouched), then the lookup
  // resolves with dealRole 'legal' → select stays 'read_only'.
});

it('retracts an applied role when the result goes stale', async () => {
  // apply 'legal' via recommendation, then change the email so the result is
  // lost → select returns to the previous value ('deal_team').
});

it('ignores an external role recommendation for the internal select', async () => {
  // recommendation.dealRole 'seller' → internal select unchanged.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/invite-modal-lookup.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/components/team/InviteModal.tsx`:

(a) State (next to `phaseTouched`, line ~142):

```ts
  const [roleTouched, setRoleTouched] = React.useState(false);
```

(b) Extend `appliedRef` (line ~145):

```ts
  const appliedRef = React.useRef<{
    key: string;
    email: string;
    phase: number;
    companyId: string | null;
    previousCompanyId: string;
    role: string | null;
    previousRole: string;
  } | null>(null);
```

(c) In the retraction branch of `onResult` (after the phase revert, line ~415):

```ts
                  if (!roleTouched && applied.role !== null) {
                    setInternalRole((current) =>
                      current === applied.role ? applied.previousRole : current,
                    );
                  }
```

(d) In the application branch (after `if (!phaseTouched) setPhase(nextPhase);`, line ~427):

```ts
                const nextRole = result.recommendation.dealRole;
                // Only internal seats live in this select; a party-derived
                // seller/buyer recommendation belongs to the company path.
                const internalRec = INTERNAL_DEAL_ROLES.some((r) => r.value === nextRole);
                const takesRole = !roleTouched && internalRec && nextRole !== internalRole;
                if (takesRole) setInternalRole(nextRole);
```

and extend the `appliedRef.current` assignment:

```ts
                appliedRef.current = {
                  key: `${email.trim().toLowerCase()}|${takesCompany ? matched : companyId}|${dealId}`,
                  email: email.trim().toLowerCase(),
                  phase: nextPhase,
                  companyId: takesCompany ? matched : null,
                  previousCompanyId: sameAddress
                    ? (prior?.previousCompanyId ?? '')
                    : takesCompany
                      ? companyId
                      : '',
                  role: takesRole ? nextRole : (sameAddress ? (prior?.role ?? null) : null),
                  previousRole: sameAddress
                    ? (prior?.previousRole ?? INTERNAL_DEAL_ROLES[0].value)
                    : internalRole,
                };
```

(e) Role select `onChange` (line ~478) marks ownership:

```ts
                  onChange={(e) => {
                    setInternalRole(e.target.value);
                    setRoleTouched(true);
                    setDomainConfirmation(null);
                  }}
```

- [ ] **Step 4: Run the modal suite**

Run: `npx vitest run tests/invite-modal-lookup.test.tsx`
Expected: PASS, existing cases untouched.

- [ ] **Step 5: Commit** (authorization required)

```bash
git add src/components/team/InviteModal.tsx tests/invite-modal-lookup.test.tsx
git commit -m "feat(team): InviteModal applies the preferred-role recommendation (#160)"
```

---

### Task 6: Gate 0 — shared allowlist + preference prefill

**Files:**
- Modify: `src/components/wizard/Gate0Wizard.tsx:41-58` (type + allowlist), `:582-590` (`toggleRealMember`)
- Test: `tests/gate0-invite-queue.test.ts` sibling — create `tests/gate0-preferred-role.test.ts` only if the toggle logic is extracted; otherwise assert via the existing Gate 0 test harness if one renders the roster step (check `tests/` for a Gate0 RTL harness first; if none exists, the pure-helper test below suffices)

**Interfaces:**
- Consumes: `INTERNAL_ASSIGNABLE_DEAL_ROLES`, `resolvePreferredDealRole` (Task 1); `preferred_deal_role` from GET members (Task 3); existing `onboardingEnabled = useFlag('platform_onboarding')` (line 437).
- Produces: roster selector offers only `deal_team | legal | read_only`; checking a colleague initializes their role from the preference when the flag is on.

- [ ] **Step 1: Write the failing test**

The initialization rule is a pure decision — test it via `resolvePreferredDealRole` composition. Create `tests/gate0-preferred-role.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEAL_ROLE, resolvePreferredDealRole } from '@/lib/constants/roles';

/** Gate 0's initial-role rule: preference when flagged on and valid, else deal_team. */
function initialGateRole(preferred: string | null, onboardingEnabled: boolean) {
  return (onboardingEnabled ? resolvePreferredDealRole(preferred) : null) ?? DEAL_ROLE.DEAL_TEAM;
}

describe('Gate 0 preferred-role initialization', () => {
  it('uses a valid preference when the flag is on', () => {
    expect(initialGateRole('legal', true)).toBe('legal');
  });
  it('falls back to deal_team when the flag is off', () => {
    expect(initialGateRole('legal', false)).toBe('deal_team');
  });
  it('falls back on a missing or invalid preference', () => {
    expect(initialGateRole(null, true)).toBe('deal_team');
    expect(initialGateRole('seller', true)).toBe('deal_team');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gate0-preferred-role.test.ts`
Expected: FAIL only if Task 1 is absent; with Task 1 merged it passes trivially — the real change is Step 3, verified by the full suite + typecheck.

- [ ] **Step 3: Implement in Gate0Wizard**

(a) `RosterMember` type (line 41) gains the field:

```ts
type RosterMember = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  department: string | null;
  company_role: string | null;
  preferred_deal_role: string | null;
};
```

(b) Replace the local allowlist (lines 50-58) with the shared one — delete the `ASSIGNABLE_DEAL_ROLES` declaration and its doc comment, import `INTERNAL_ASSIGNABLE_DEAL_ROLES` and `resolvePreferredDealRole` from `@/lib/constants/roles`, and change the selector render (line ~1310) to:

```tsx
                              {INTERNAL_ASSIGNABLE_DEAL_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {DEAL_ROLE_LABELS[r]}
                                </option>
                              ))}
```

This deliberately drops `seller`/`buyer` from the internal-colleague selector (live bug: the invite pipeline rejects those seats for internal invitees — spec decision 9).

(c) `toggleRealMember` (line 582) initializes from the preference:

```ts
  function toggleRealMember(id: string) {
    if (id === creator?.id) return; // the creator is the locked MD seat
    const preferred = onboardingEnabled
      ? resolvePreferredDealRole(roster.find((m) => m.id === id)?.preferred_deal_role)
      : null;
    setMemberRoles((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = preferred ?? DEAL_ROLE.DEAL_TEAM;
      return next;
    });
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/gate0-preferred-role.test.ts tests/gate0-invite-queue.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors (the type gains a field the API now returns; any Gate 0 fixture objects in tests need the new `preferred_deal_role: null` property).

- [ ] **Step 5: Commit** (authorization required)

```bash
git add src/components/wizard/Gate0Wizard.tsx tests/gate0-preferred-role.test.ts
git commit -m "feat(gate0): shared internal allowlist + preferred-role prefill (#160)"
```

---

### Task 7: Members page — preferred-role control, filter, walled rows

**Files:**
- Modify: `src/app/(authed)/companies/[companyId]/members/page.tsx`
- Test: Create `tests/company-members-page.test.tsx`

**Interfaces:**
- Consumes: GET `?includeWalled=true` with `preferred_deal_role`/`is_walled` (Task 3); PATCH `preferredDealRole` (Task 2); `INTERNAL_ASSIGNABLE_DEAL_ROLES`, `DEAL_ROLE_LABELS`, `useFlag` from `@/lib/flags/FlagsContext`.
- Produces: the shipped directory UI; no route or navigation changes (AppRail link stays as-is per spec).

- [ ] **Step 1: Write the failing tests**

Create `tests/company-members-page.test.tsx` (RTL; mock `next/navigation` `useParams` to `{ companyId: 'c1' }`, mock `@/lib/flags/FlagsContext` `useFlag` to true, and stub `global.fetch` per-URL):

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useParams: () => ({ companyId: 'c1' }) }));
vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: vi.fn(() => true) }));

import CompanyMembersPage from '@/app/(authed)/companies/[companyId]/members/page';

const director = {
  id: 'me', firm_role: null, company_id: 'c1', company_role: 'director',
  is_external: false, can_invite: false,
};
const members = [
  { id: 'me', full_name: 'Storm Duncan', display_name: null, email: 'storm@bank.dev',
    department: 'ib', company_role: 'director', can_invite: false,
    preferred_deal_role: null, is_walled: false },
  { id: 'u2', full_name: 'Alex Reyes', display_name: null, email: 'alex@bank.dev',
    department: 'ib', company_role: 'member', can_invite: false,
    preferred_deal_role: 'legal', is_walled: false },
  { id: 'u3', full_name: 'Ren Ito', display_name: null, email: 'ren@bank.dev',
    department: 'research', company_role: 'member', can_invite: false,
    preferred_deal_role: null, is_walled: true },
];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) =>
      Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
    if (url.includes('/api/v1/me')) return json({ user: director });
    if (url.includes('/members?includeWalled=true')) return json({ members });
    if (url.includes('/invites')) return json({ invites: [] });
    if (url.includes('/members/u2') ) return json({ member: { ...members[1], preferred_deal_role: 'read_only' } });
    return json({});
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('company members page', () => {
  it('requests the roster with includeWalled and renders walled rows non-selectable', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await waitFor(() => expect(screen.getByText('Ren Ito')).toBeInTheDocument());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('includeWalled=true'),
    );
    expect(screen.getByLabelText('Preferred role for Ren Ito')).toBeDisabled();
    // Walled rows offer no director promotion.
    expect(screen.queryByRole('button', { name: /make director/i, hidden: false }))
      .not.toBeNull(); // exists for Alex...
  });

  it('PATCHes preferredDealRole when the selector changes', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await waitFor(() => expect(screen.getByText('Alex Reyes')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Preferred role for Alex Reyes'), {
      target: { value: 'read_only' },
    });
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/v1/companies/c1/members/u2',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ preferredDealRole: 'read_only' }),
        }),
      ),
    );
  });

  it('filters the roster by name or email', async () => {
    stubFetch();
    render(<CompanyMembersPage />);
    await waitFor(() => expect(screen.getByText('Alex Reyes')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Filter members'), {
      target: { value: 'ren@' },
    });
    expect(screen.queryByText('Alex Reyes')).toBeNull();
    expect(screen.getByText('Ren Ito')).toBeInTheDocument();
  });
});
```

(If the walled-director assertion proves awkward, assert directly: `within(renRow).queryByRole('button', { name: /make director/i })` is null while Alex's row has it — use `screen.getByText('Ren Ito').closest('div')`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/company-members-page.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the page changes**

In `src/app/(authed)/companies/[companyId]/members/page.tsx`:

(a) Imports:

```ts
import {
  COMPANY_ROLE,
  DEAL_ROLE_LABELS,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
} from '@/lib/constants/roles';
import { useFlag } from '@/lib/flags/FlagsContext';
```

(b) `Member` type gains `preferred_deal_role: string | null;` and `is_walled: boolean;`.

(c) In `refresh`, fetch `` fetch(`/api/v1/companies/${companyId}/members?includeWalled=true`) `` (the server ignores the parameter for non-managers).

(d) Component state and flag:

```ts
  const [filter, setFilter] = React.useState('');
  const preferredRolesEnabled = useFlag('platform_onboarding');
```

(e) Above the Members section (inside the `<>` after the error/loading branches), the filter input and helper copy:

```tsx
            <div className="flex flex-col gap-[var(--space-1)]">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name or email"
                aria-label="Filter members"
                className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-3)] py-[6px] text-[length:var(--text-sm)] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:max-w-xs"
              />
              {canManage && preferredRolesEnabled ? (
                <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  Preferred role for future deal assignments. Administrators still
                  confirm it when adding this person to a deal.
                </p>
              ) : null}
            </div>
```

(f) Filter the mapped list:

```ts
              {members
                .filter((m) => {
                  const q = filter.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    (m.display_name || m.full_name).toLowerCase().includes(q) ||
                    m.email.toLowerCase().includes(q)
                  );
                })
                .map((m) => {
```

(g) Inside the row's controls (`{canManage ? (<> ... </>) : null}`): add the preferred-role select before the existing buttons, gate "Make director" on `!m.is_walled`, and badge walled rows:

```tsx
                      {m.is_walled ? <span className={badgeClass}>walled</span> : null}
                      {canManage && preferredRolesEnabled ? (
                        <select
                          value={m.preferred_deal_role ?? ''}
                          disabled={busy || m.is_walled}
                          aria-label={`Preferred role for ${m.display_name || m.full_name}`}
                          title={
                            m.is_walled
                              ? 'Walled departments never take deal seats.'
                              : undefined
                          }
                          onChange={(e) =>
                            act(
                              () =>
                                fetch(`/api/v1/companies/${companyId}/members/${m.id}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    preferredDealRole: e.target.value || null,
                                  }),
                                }),
                              'The preferred role was not changed.',
                            )
                          }
                          className="rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-2)] py-[4px] text-[length:var(--text-xs)] text-[var(--ink)] disabled:opacity-60"
                        >
                          <option value="">No preference</option>
                          {INTERNAL_ASSIGNABLE_DEAL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {DEAL_ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      ) : null}
```

and change the "Make director" button's render condition: wrap the existing promote/demote button in `{!m.is_walled ? (...) : null}` (the can-invite toggle and Remove stay available for walled rows).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/company-members-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit** (authorization required)

```bash
git add "src/app/(authed)/companies/[companyId]/members/page.tsx" tests/company-members-page.test.tsx
git commit -m "feat(members): preferred-role control, roster filter, walled rows (#160)"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/03-engineering/api-v1.md` (Endpoints + Authorization tables; the `platform_onboarding` section)
- Modify: `openapi/phase1.json` (only if it already documents the members endpoints — check first; mirror the new request/response fields there)
- Modify: `docs/superpowers/specs/2026-08-14-company-admin-directory-design.md` (Status line → Implemented)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-7.
- Produces: contract docs that match the code; a green full suite.

- [ ] **Step 1: Update api-v1.md**

In the Endpoints table, extend the three members rows:
- `GET /companies/{id}/members` — add: "`?includeWalled=true` includes research/trading rows for managers only; rows carry `preferred_deal_role` and `is_walled`."
- `POST /companies/{id}/members` — add: "rejects director promotion of a walled-department user (403)."
- `PATCH /companies/{id}/members/{userId}` — change description to: "Exactly one of `canInvite` or `preferredDealRole` (`deal_team|legal|read_only|null`, `platform_onboarding`-gated). CAS + audit (`grant`/`revoke`, reason `company_preferred_deal_role_changed`)."
- `POST /invites/lookup` — add: "bank-company recommendation carries `employee_default` when the disclosable colleague has a preferred role."

In the Authorization table add: `preferredDealRole` mutation — `canManageCompanyMembers`; walled/external targets rejected.

- [ ] **Step 2: Check and update openapi/phase1.json**

Run: `grep -n "members" openapi/phase1.json | head`. If the members paths are present, add `preferred_deal_role` / `is_walled` to the member schema, the `includeWalled` query parameter, and the `preferredDealRole` request property. If absent, skip (note it in the commit message).

- [ ] **Step 3: Flip the spec status**

In `docs/superpowers/specs/2026-08-14-company-admin-directory-design.md` change `**Status:** Approved design, pre-implementation` to `**Status:** Implemented (see docs/superpowers/plans/2026-08-14-preferred-deal-role.md)`.

- [ ] **Step 4: Full verification**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all green. Then manual smoke via `/dev-api` or the page: set a preference as director, see the prefill in Gate 0 step 2 and in InviteModal for that colleague's address.

- [ ] **Step 5: Commit** (authorization required)

```bash
git add docs/03-engineering/api-v1.md openapi/phase1.json docs/superpowers/specs/2026-08-14-company-admin-directory-design.md
git commit -m "docs(api-v1): preferred_deal_role contract + spec status (#160)"
```
