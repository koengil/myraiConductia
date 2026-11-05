import { afterEach, describe, expect, it, vi } from 'vitest';

// Same mocking strategy as api-v1-invites.test.ts: auth clients, the flag
// gate, and the delivery pipeline are stubbed so the tests drive the route's
// own logic — admin wall, find-or-create identity rule, duplicate mapping.
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  deliverInvite: vi.fn(() => Promise.resolve({ deliveryStatus: 'sent' })),
  fetchInviteEmailContext: vi.fn(() =>
    Promise.resolve({
      inviterName: 'Ada Admin',
      inviterCompanyName: 'Conductia',
      companyName: 'Ignatius Partners',
      companyType: 'client',
      dealCodename: null,
    }),
  ),
}));
vi.mock('@/lib/api/v1/inviteChallenge', () => ({
  generateInviteChallengeCode: vi.fn(() => '123456'),
  digestInviteChallengeCode: vi.fn(() => 'a'.repeat(64)),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { deliverInvite } from '@/lib/api/v1/inviteDelivery';
import { jsonError } from '@/lib/api/v1/http';
import { POST } from '@/app/api/v1/companies/onboard/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(opts: { tables?: Record<string, Resp | Resp[]>; rpc?: Resp } = {}) {
  const tables = opts.tables ?? {};
  // Post-137 defaults: an empty verified-domain set (classification
  // 'unverified') and a recordable domain confirmation.
  if (!('company_verified_domains' in tables)) {
    (tables as Record<string, Resp>).company_verified_domains = { data: [], error: null };
  }
  if (!('invite_domain_confirmations' in tables)) {
    (tables as Record<string, Resp>).invite_domain_confirmations = {
      data: { id: 'conf-1' },
      error: null,
    };
  }
  // Inserted payloads and the columns each query filtered on are recorded: the
  // tenant a company lands in, and whether the lookup was tenant-scoped, are
  // the behaviour under test for the per-org tenancy rule.
  const inserts: Record<string, unknown[]> = {};
  const filtered: Record<string, string[]> = {};
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.insert = (payload: unknown) => {
      (inserts[table] ??= []).push(payload);
      return builder;
    };
    builder.eq = (column: string) => {
      (filtered[table] ??= []).push(column);
      return builder;
    };
    builder.ilike = chain;
    builder.delete = chain;
    builder.update = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpc = vi.fn(() => Promise.resolve(opts.rpc ?? { data: null, error: null }));
  return { from, rpc, inserts, filtered } as unknown as ReturnType<
    typeof createSupabaseAdminClient
  > & {
    rpc: ReturnType<typeof vi.fn>;
    inserts: Record<string, unknown[]>;
    filtered: Record<string, string[]>;
  };
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'admin-1', email: 'admin@bank.dev' }) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/v1/companies/onboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** requireApiUser's onboarding probe reads users.status first. */
const activeStatus: Resp = { data: { status: 'active' }, error: null };
const adminActor: Resp = { data: { firm_role: 'admin', tenant_id: 'tenant-1' }, error: null };
const staffActor: Resp = { data: { firm_role: null, tenant_id: 'tenant-1' }, error: null };

const CREATED_INVITE = {
  duplicate: false,
  id: 'inv-1',
  credential_nonce: 'nonce-1',
  tenant_id: 'tenant-1',
  expires_at: '2026-08-13T00:00:00Z',
};

const VALID = { name: 'Ignatius Partners', type: 'client', ownerEmail: 'owner@ignatius.com' };
const CONF_ID = '11111111-1111-4111-8111-111111111111';
// Second call of the two-step flow: the admin confirmed the non-matching domain.
const CONFIRMED = { ...VALID, confirmationId: CONF_ID };

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/companies/onboard', () => {
  it('404s when platform_onboarding is off', async () => {
    vi.mocked(requireFlag).mockResolvedValueOnce(jsonError('Not found', 404));
    const res = await POST(req(VALID));
    expect(res.status).toBe(404);
  });

  it('403s for a non-admin actor', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus, staffActor] } }));
    const res = await POST(req(VALID));
    expect(res.status).toBe(403);
  });

  it('rejects a missing name, bad type, and malformed ownerEmail', async () => {
    for (const body of [
      { ...VALID, name: '  ' },
      { ...VALID, type: 'cartel' },
      { ...VALID, ownerEmail: 'not-an-email' },
    ]) {
      signedIn(makeAdmin({ tables: { users: [activeStatus, adminActor] } }));
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      vi.clearAllMocks();
    }
  });

  it('creates the company and sends the director invite', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [
          { data: null, error: null }, // lookup: no match
          { data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null }, // insert
        ],
        audit_log: { data: null, error: null },
      },
      rpc: { data: CREATED_INVITE, error: null },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.company).toMatchObject({ id: 'co-1', created: true });
    expect(body.invite).toMatchObject({
      email: 'owner@ignatius.com',
      companyRole: 'director',
      status: 'pending',
      deliveryStatus: 'sent',
    });
    expect(body.verificationCode).toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledWith(
      'create_invite',
      expect.objectContaining({
        p_company_role: 'director',
        p_deal_id: null,
        p_challenge_digest: 'a'.repeat(64),
        p_domain_confirmation_id: CONF_ID,
      }),
    );
    expect(vi.mocked(deliverInvite)).toHaveBeenCalledWith(
      admin,
      'http://localhost',
      expect.objectContaining({
        inviterName: 'Ada Admin',
        inviterCompanyName: 'Conductia',
        dealCodename: null,
      }),
    );
  });

  it('mints the invite link against NEXT_PUBLIC_APP_URL, not the host that called the API', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.conductia.com');
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [
          { data: null, error: null },
          { data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null },
        ],
        audit_log: { data: null, error: null },
      },
      rpc: { data: CREATED_INVITE, error: null },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(201);
    expect(vi.mocked(deliverInvite)).toHaveBeenCalledWith(
      admin,
      'https://app.conductia.com',
      expect.anything(),
    );
    vi.unstubAllEnvs();
  });

  it('reuses an existing company by case-insensitive name and reports created: false', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [{ data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null }],
      },
      rpc: { data: CREATED_INVITE, error: null },
    });
    signedIn(admin);
    const res = await POST(req({ ...CONFIRMED, name: 'ignatius partners' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.company.created).toBe(false);
  });

  it('maps a pending duplicate to 409 with the invite id disclosed (actor is admin)', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [{ data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null }],
      },
      rpc: { data: { duplicate: true, id: 'inv-9', delivery_status: 'sent' }, error: null },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'duplicate_pending', inviteId: 'inv-9' });
  });

  it('fails closed when the company creation cannot be audited', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [
          { data: null, error: null },
          { data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null },
        ],
        audit_log: { data: null, error: { message: 'audit store down' } },
      },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(500);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('answers domain_confirmation_required with a confirmation id on the first call', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [{ data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null }],
      },
    });
    signedIn(admin);
    const res = await POST(req(VALID));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(body.error).toBe('domain_confirmation_required');
    expect(body.confirmationId).toBe('conf-1');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('409s when a same-name company exists with a conflicting type', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [{ data: { id: 'co-1', name: 'Ignatius Partners', type: 'bank' }, error: null }],
      },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(409);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  // #156: two banks in one tenant made a second bank's staff look like the
  // first bank's internal staff, which let an Ignatious director enumerate
  // Conductia's client leads. A firm owns a tenant; a party lives in one.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function onboarding(type: 'bank' | 'client', lookup: Resp) {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [lookup, { data: { id: 'co-1', name: 'Ignatius Capital', type }, error: null }],
        audit_log: { data: null, error: null },
      },
      rpc: { data: CREATED_INVITE, error: null },
    });
    signedIn(admin);
    return admin;
  }

  it('gives a newly onboarded firm its own tenant, not the platform admin one', async () => {
    const admin = onboarding('bank', { data: null, error: null });
    const res = await POST(
      req({ name: 'Ignatius Capital', type: 'bank', ownerEmail: 'owner@ignatius.com', confirmationId: CONF_ID }),
    );
    expect(res.status).toBe(201);
    const inserted = admin.inserts.companies?.[0] as { tenant_id: string };
    expect(inserted.tenant_id).not.toBe('tenant-1');
    expect(inserted.tenant_id).toMatch(UUID);
  });

  it('keeps a non-firm company in the onboarding tenant, so it can be a deal party', async () => {
    const admin = onboarding('client', { data: null, error: null });
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(201);
    expect(admin.inserts.companies?.[0]).toMatchObject({ tenant_id: 'tenant-1' });
  });

  it('matches an existing firm across tenants, so the confirm step reuses its tenant', async () => {
    // Scoping the firm lookup to the actor would miss the company the first
    // call created and mint it a second tenant on the confirm call.
    const admin = onboarding('bank', {
      data: { id: 'co-1', name: 'Ignatius Capital', type: 'bank' },
      error: null,
    });
    const res = await POST(
      req({ name: 'Ignatius Capital', type: 'bank', ownerEmail: 'owner@ignatius.com', confirmationId: CONF_ID }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).company.created).toBe(false);
    expect(admin.inserts.companies).toBeUndefined();
    expect(admin.filtered.companies ?? []).not.toContain('tenant_id');
  });

  it('scopes a non-firm lookup to the onboarding tenant', async () => {
    const admin = onboarding('client', {
      data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' },
      error: null,
    });
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(201);
    expect(admin.filtered.companies ?? []).toContain('tenant_id');
  });

  it('maps active_account to 409 with redirect-to-members guidance', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, adminActor],
        companies: [{ data: { id: 'co-1', name: 'Ignatius Partners', type: 'client' }, error: null }],
      },
      rpc: { data: null, error: { message: 'active_account' } },
    });
    signedIn(admin);
    const res = await POST(req(CONFIRMED));
    expect(res.status).toBe(409);
  });
});
