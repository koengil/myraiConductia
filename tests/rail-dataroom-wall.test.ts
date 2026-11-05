import { describe, expect, it, vi, afterEach } from 'vitest';

import { classifyInternalUser } from '@/lib/api/v1/access';
import { GET as STEPS } from '@/app/api/v1/deals/[dealId]/steps/route';
import { GET as DATAROOM } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/route';
import { POST as UPLOAD } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/upload/route';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Rail-step datarooms are internal work product (review 09a4e78 findings
 * 1-3): every route must refuse external users outright and FAIL CLOSED when
 * the profile lookup breaks — a broken lookup is a server fault, not access.
 */

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: vi.fn(() => Promise.resolve({ id: 'd1', code: 'PRJRA' })),
  listDealStepsWithDatarooms: vi.fn(() => Promise.resolve([])),
  seedDataroomsForDeal: vi.fn(() => Promise.resolve()),
  provisionDataroomFolder: vi.fn(),
}));

type Resp = { data: unknown; error: { message: string } | null };

/** Per-table responses consumed in order; the house stub shape. */
function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const admin = {
    from(table: string) {
      const entry = tables[table];
      const resp: Resp = Array.isArray(entry)
        ? (entry.shift() ?? { data: null, error: null })
        : (entry ?? { data: null, error: null });
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'is']) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = () => Promise.resolve(resp);
      builder.single = () => Promise.resolve(resp);
      builder.then = (res: (v: Resp) => unknown) => Promise.resolve(resp).then(res);
      return builder;
    },
  };
  return admin as unknown as SupabaseClient;
}

function signedIn(admin: SupabaseClient, userId: string) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: userId, email: `${userId}@x.co` } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
  } as never);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
}

const activeStatus: Resp = { data: { status: 'active' }, error: null };
const notOverseer: Resp = { data: { firm_role: null, tenant_id: 't1' }, error: null };
const externalProfile: Resp = { data: { is_external: true }, error: null };
const seat: Resp = { data: { deal_role: 'seller' }, error: null };
// The deal sits in the member's tenant, so the seat is real: these callers
// know the deal exists and keep their 403 (decision-log D65).
const sameTenantDeal: Resp = { data: { tenant_id: 't1' }, error: null };

const stepsCtx = { params: Promise.resolve({ dealId: 'd1' }) };
const stepCtx = { params: Promise.resolve({ dealId: 'd1', stepId: 's1' }) };
const req = (method: string) => new Request('http://localhost/api/v1/x', { method });

/** users reads in order: requireApiUser status, access firm_role, wall is_external. */
const externalTables = () => ({
  users: [activeStatus, notOverseer, externalProfile],
  deal_memberships: [seat],
  deals: sameTenantDeal,
});

describe('rail dataroom internal wall', () => {
  afterEach(() => vi.clearAllMocks());

  it('classifyInternalUser fails closed on lookup error and missing profile', async () => {
    const erroring = makeAdmin({ users: { data: null, error: { message: 'boom' } } });
    expect(await classifyInternalUser(erroring, 'u1')).toBe('error');
    const missing = makeAdmin({ users: { data: null, error: null } });
    expect(await classifyInternalUser(missing, 'u1')).toBe('external');
  });

  it('steps aggregate refuses an external member (403)', async () => {
    const admin = makeAdmin(externalTables());
    signedIn(admin, 'ext-1');
    const res = await STEPS(req('GET'), stepsCtx);
    expect(res.status).toBe(403);
  });

  it('per-step dataroom listing refuses an external member (403)', async () => {
    const admin = makeAdmin(externalTables());
    signedIn(admin, 'ext-1');
    const res = await DATAROOM(req('GET'), stepCtx);
    expect(res.status).toBe(403);
  });

  it('per-step dataroom listing 500s when the profile lookup breaks (fail closed)', async () => {
    const admin = makeAdmin({
      users: [activeStatus, notOverseer, { data: null, error: { message: 'boom' } }],
      deal_memberships: [seat],
      deals: sameTenantDeal,
    });
    signedIn(admin, 'ext-1');
    const res = await DATAROOM(req('GET'), stepCtx);
    expect(res.status).toBe(500);
  });

  it('upload refuses an external seller before any storage side effect (403)', async () => {
    const admin = makeAdmin(externalTables());
    signedIn(admin, 'ext-seller');
    const res = await UPLOAD(req('POST'), stepCtx);
    expect(res.status).toBe(403);
  });
});
