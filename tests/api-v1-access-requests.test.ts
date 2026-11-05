import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/api/v1/companyAccess', () => ({
  hasCompanyPermission: vi.fn(async () => false),
}));

vi.mock('@/lib/notifications/accessNotifications', () => ({
  notifyAccessRequested: vi.fn(async () => undefined),
  notifyAccessDecision: vi.fn(async () => undefined),
}));

import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { GET, POST } from '@/app/api/v1/access-requests/route';
import { PATCH } from '@/app/api/v1/access-requests/[requestId]/route';
import { notifyAccessRequested } from '@/lib/notifications/accessNotifications';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';

type Resp = { data: unknown; error: unknown };

function signedIn(admin: unknown, user = { id: 'u-member', email: 'member@co.test' }) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as ReturnType<typeof createSupabaseAdminClient>);
}

function chain(resp: Resp) {
  const builder: Record<string, unknown> = {};
  const next = () => builder;
  builder.select = next;
  builder.eq = next;
  builder.in = next;
  builder.order = next;
  builder.insert = () => {
    const insertBuilder: Record<string, unknown> = {};
    insertBuilder.select = () => insertBuilder;
    insertBuilder.single = () => Promise.resolve(resp);
    return insertBuilder;
  };
  builder.update = () => {
    const updateBuilder: Record<string, unknown> = {};
    updateBuilder.eq = () => updateBuilder;
    updateBuilder.select = () => updateBuilder;
    updateBuilder.maybeSingle = () => Promise.resolve(resp);
    return updateBuilder;
  };
  builder.maybeSingle = () => Promise.resolve(resp);
  builder.single = () => Promise.resolve(resp);
  builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
  return builder;
}

afterEach(() => {
  vi.clearAllMocks();
});

const memberProfile = {
  id: 'u-member',
  tenant_id: 't-1',
  company_id: 'co-1',
  company_role: 'member',
  firm_role: null,
  display_name: 'Pat',
  full_name: 'Pat Member',
  status: 'active',
};

const createdRow = {
  id: '11111111-1111-1111-1111-111111111111',
  company_id: 'co-1',
  requester_id: 'u-member',
  destination: 'leads',
  permission_key: 'company:leads:view',
  status: 'pending',
  decided_by: null,
  decided_at: null,
  created_at: '2026-08-31T12:00:00.000Z',
};

describe('POST /api/v1/access-requests', () => {
  it('creates a pending leads request and notifies directors', async () => {
    let userCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === 'users') {
        userCalls += 1;
        if (userCalls <= 2) return chain({ data: memberProfile, error: null });
        return chain({
          data: [{ id: 'u-director', company_role: 'director', firm_role: null }],
          error: null,
        });
      }
      if (table === 'access_requests') {
        const selectBuilder = chain({ data: null, error: null });
        return {
          ...selectBuilder,
          insert: () => {
            const insertBuilder: Record<string, unknown> = {};
            insertBuilder.select = () => insertBuilder;
            insertBuilder.single = () => Promise.resolve({ data: createdRow, error: null });
            return insertBuilder;
          },
        };
      }
      return chain({ data: [{ id: 'u-director' }], error: null });
    });
    signedIn({ from });

    const res = await POST(
      new Request('http://localhost/api/v1/access-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: ACCESS_DESTINATION.LEADS }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request?: { destination: string; status: string } };
    expect(body.request?.destination).toBe('leads');
    expect(body.request?.status).toBe('pending');
    expect(notifyAccessRequested).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        href: '/companies/co-1/members?tab=requests',
        requestId: createdRow.id,
        companyId: 'co-1',
        destinationLabel: 'Leads',
      }),
    );
  });

  it('creates a pending Create leads request', async () => {
    const createdCreate = { ...createdRow, destination: 'leads_create', permission_key: 'company:leads:create' };
    let userCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === 'users') {
        userCalls += 1;
        if (userCalls <= 2) return chain({ data: memberProfile, error: null });
        return chain({
          data: [{ id: 'u-director', company_role: 'director', firm_role: null }],
          error: null,
        });
      }
      if (table === 'access_requests') {
        const selectBuilder = chain({ data: null, error: null });
        return {
          ...selectBuilder,
          insert: () => {
            const insertBuilder: Record<string, unknown> = {};
            insertBuilder.select = () => insertBuilder;
            insertBuilder.single = () => Promise.resolve({ data: createdCreate, error: null });
            return insertBuilder;
          },
        };
      }
      return chain({ data: [{ id: 'u-director' }], error: null });
    });
    signedIn({ from });

    const res = await POST(
      new Request('http://localhost/api/v1/access-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: ACCESS_DESTINATION.LEADS_CREATE }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request?: { destination: string; destinationLabel: string } };
    expect(body.request?.destination).toBe('leads_create');
    expect(body.request?.destinationLabel).toBe('Create leads');
    expect(notifyAccessRequested).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationLabel: 'Create leads' }),
    );
  });

  it('creates a pending Roles request', async () => {
    const createdRoles = {
      ...createdRow,
      destination: 'roles',
      permission_key: 'company:roles:manage',
    };
    let userCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === 'users') {
        userCalls += 1;
        if (userCalls <= 2) return chain({ data: memberProfile, error: null });
        return chain({
          data: [{ id: 'u-director', company_role: 'director', firm_role: null }],
          error: null,
        });
      }
      if (table === 'access_requests') {
        const selectBuilder = chain({ data: null, error: null });
        return {
          ...selectBuilder,
          insert: () => {
            const insertBuilder: Record<string, unknown> = {};
            insertBuilder.select = () => insertBuilder;
            insertBuilder.single = () => Promise.resolve({ data: createdRoles, error: null });
            return insertBuilder;
          },
        };
      }
      return chain({ data: [{ id: 'u-director' }], error: null });
    });
    signedIn({ from });

    const res = await POST(
      new Request('http://localhost/api/v1/access-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: ACCESS_DESTINATION.ROLES }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request?: { destination: string; destinationLabel: string } };
    expect(body.request?.destination).toBe('roles');
    expect(body.request?.destinationLabel).toBe('Roles');
  });

  it('rejects an unknown destination', async () => {
    signedIn({ from: () => chain({ data: memberProfile, error: null }) });
    const res = await POST(
      new Request('http://localhost/api/v1/access-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: 'mail' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/access-requests', () => {
  it('returns the caller mine list', async () => {
    const from = vi.fn((table: string) => {
      if (table === 'users') return chain({ data: memberProfile, error: null });
      return chain({ data: [createdRow], error: null });
    });
    signedIn({ from });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mine?: Array<{ id: string }>; inbox?: unknown[] };
    expect(body.mine?.[0]?.id).toBe(createdRow.id);
    expect(body.inbox).toEqual([]);
  });
});

describe('PATCH /api/v1/access-requests/{id}', () => {
  it('forbids a member from deciding a request', async () => {
    const from = vi.fn((table: string) => {
      if (table === 'users') return chain({ data: memberProfile, error: null });
      return chain({ data: createdRow, error: null });
    });
    signedIn({ from });
    const res = await PATCH(
      new Request('http://localhost/api/v1/access-requests/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      }),
      { params: Promise.resolve({ requestId: createdRow.id }) },
    );
    expect(res.status).toBe(403);
  });
});
