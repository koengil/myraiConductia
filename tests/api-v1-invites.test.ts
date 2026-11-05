import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.INVITE_VERIFICATION_PEPPER = 'unit-test-invite-pepper';

// Route deps: auth clients, the platform_onboarding gate, authorization
// predicates (unit-tested separately in access-invites.test.ts), and the
// delivery pipeline (link generation + Resend) — all mocked so the tests
// drive the route's own logic: validation, role-shape walls, scoped duplicate
// disclosure, and delivery-status reporting.
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: vi.fn(() => Promise.resolve(true)),
  userCanInvite: vi.fn(() => Promise.resolve(true)),
  userCanInviteChecked: vi.fn(async () => true),
  userCanManageInvite: vi.fn(() => Promise.resolve(true)),
  canManageCompanyMembers: vi.fn(() => Promise.resolve(true)),
  canManageDealMembers: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  deliverInvite: vi.fn(() => Promise.resolve({ deliveryStatus: 'sent' })),
  fetchInviteEmailContext: vi.fn(() =>
    Promise.resolve({
      inviterName: 'Storm Duncan',
      inviterCompanyName: 'Futureproofing Capital',
      companyName: 'Atlassian',
      companyType: 'target',
      dealCodename: 'Project Rangers',
    }),
  ),
}));
vi.mock('@/lib/api/v1/proposalFeasibility', () => ({
  companyHasActiveDirector: vi.fn(() => Promise.resolve(true)),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { isFlagEnabled, requireFlag } from '@/lib/api/v1/requireFlag';
import {
  canManageCompanyMembers,
  canManageDealMembers,
  userCanAccessDeal,
  userCanInvite,
  userCanInviteChecked,
  userCanManageInvite,
} from '@/lib/api/v1/access';
import { deliverInvite } from '@/lib/api/v1/inviteDelivery';
import { companyHasActiveDirector } from '@/lib/api/v1/proposalFeasibility';
import { jsonError } from '@/lib/api/v1/http';
import { GET, POST } from '@/app/api/v1/invites/route';
import { POST as ACCEPT } from '@/app/api/v1/invites/accept/route';
import { TOS_VERSION } from '@/lib/constants/legal';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentity';

type Resp = { data: unknown; error: unknown };

function makeAdmin(opts: { tables?: Record<string, Resp | Resp[]>; rpc?: Resp | Resp[] } = {}) {
  const tables = opts.tables ?? {};
  // Routes resolve the deal code/UUID first; default the read so tests
  // that never assert on deals don't have to stub it.
  if (!('deals' in tables)) (tables as Record<string, unknown>).deals = { data: { id: 'd1', code: 'PRJRA' }, error: null };
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.insert = chain;
    builder.update = chain;
    builder.eq = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpcResponses = Array.isArray(opts.rpc) ? [...opts.rpc] : null;
  const rpc = vi.fn(() => Promise.resolve(
    rpcResponses
      ? (rpcResponses.length > 0 ? rpcResponses.shift() : { data: null, error: null })
      : (opts.rpc ?? { data: null, error: null }),
  ));
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

function signedIn(
  admin: ReturnType<typeof makeAdmin>,
  user = { id: 'md-1', email: 'md@bank.dev' },
  sessionRpc: Resp = { data: null, error: null },
) {
  const rpc = vi.fn(() => Promise.resolve(sessionRpc));
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
      },
      getUser: () =>
        Promise.resolve({
          data: {
            user: {
              ...user,
              user_metadata: { invite_id: 'inv-1', credential_nonce: 'nonce-1' },
            },
          },
          error: null,
        }),
    },
    rpc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
  return { sessionRpc: rpc };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/v1/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** requireApiUser's onboarding probe reads users.status first. */
const activeStatus: Resp = { data: { status: 'active' }, error: null };
const internalActor: Resp = { data: { is_external: false, firm_role: null }, error: null };

const CREATED = {
  duplicate: false,
  id: 'inv-1',
  credential_nonce: 'nonce-1',
  tenant_id: 'tenant-1',
  expires_at: '2026-08-07T00:00:00Z',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(companyHasActiveDirector).mockResolvedValue(true);
});

describe('POST /api/v1/invites — flag gate & validation', () => {
  it('404s when platform_onboarding is off', async () => {
    vi.mocked(requireFlag).mockResolvedValueOnce(jsonError('Not found', 404));
    const res = await POST(req({ email: 'a@b.co', companyId: 'c1' }));
    expect(res.status).toBe(404);
  });

  it('rejects a malformed email', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    const res = await POST(req({ email: 'not-an-email', companyId: 'c1' }));
    expect(res.status).toBe(400);
  });

  it('rejects dealId without dealRole (and vice versa)', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    const res = await POST(req({ email: 'a@b.co', companyId: 'c1', dealId: 'd1' }));
    expect(res.status).toBe(400);
  });

  it('403s when the actor may not invite into this scope', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    vi.mocked(userCanInvite).mockResolvedValueOnce(false);
    const res = await POST(req({ email: 'a@b.co', companyId: 'c1' }));
    expect(res.status).toBe(403);
  });
});

describe('/api/v1/invites on a deal the caller cannot see (D65)', () => {
  const onDeal = { email: 'a@b.co', companyId: 'c1', dealId: 'FALCO-2026-001', dealRole: 'seller' };
  const list = () =>
    GET(new Request('http://localhost/api/v1/invites?dealId=FALCO-2026-001', { method: 'GET' }));
  const externalDirector: Resp = {
    data: { is_external: true, firm_role: null, company_id: 'c-party', company_role: 'director' },
    error: null,
  };
  const bankDirector: Resp = {
    data: { is_external: false, firm_role: null, company_id: 'bank-1', company_role: 'director' },
    error: null,
  };
  const inviteRows: Resp = { data: [], error: null };

  /** Neither a seat nor deal-scoped invite authority. */
  function hidden() {
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce(false);
  }

  it('POST: an unseated caller without invite authority gets the missing-deal answer, not 403', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    hidden();

    const res = await POST(req(onDeal));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(userCanInvite).not.toHaveBeenCalled();
  });

  it('POST: a seated caller without invite authority keeps the role 403', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    vi.mocked(userCanInvite).mockResolvedValueOnce(false);

    const res = await POST(req(onDeal));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('POST: the gate asks the invite predicate about the caller\'s own company', async () => {
    signedIn(makeAdmin({ tables: { users: [{ data: { status: 'active', company_id: 'c-party' }, error: null }] } }));
    hidden();

    await POST(req(onDeal));

    expect(userCanInviteChecked).toHaveBeenCalledWith(expect.anything(), 'md-1', {
      companyId: 'c-party',
      dealId: 'd1',
    });
  });

  it('POST: a failed authority read is a 503, never a pass', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus] } }));
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce('unreadable');

    const res = await POST(req(onDeal));

    expect(res.status).toBe(503);
    expect(userCanInvite).not.toHaveBeenCalled();
  });

  it('GET: a non-party external director gets the missing-deal answer, not 200', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus, externalDirector], invites: inviteRows } }));
    hidden();

    const res = await list();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('GET: another firm\'s admin gets the missing-deal answer, not that deal\'s invites', async () => {
    const foreignAdmin: Resp = { data: { is_external: false, firm_role: 'admin' }, error: null };
    signedIn(makeAdmin({ tables: { users: [activeStatus, foreignAdmin], invites: inviteRows } }));
    hidden();

    const res = await list();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('GET: a party company\'s director with no seat still lists their company\'s invites', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus, externalDirector], invites: inviteRows } }));
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce(true);

    const res = await list();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invites: [] });
  });

  it('GET: the owning bank\'s director with no seat still lists the deal\'s invites', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus, bankDirector], invites: inviteRows } }));
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce(true);

    const res = await list();

    expect(res.status).toBe(200);
    expect(canManageDealMembers).toHaveBeenCalledWith(expect.anything(), 'md-1', 'd1');
  });

  it('GET: a seated caller who cannot manage members keeps the role 403', async () => {
    signedIn(makeAdmin({ tables: { users: [activeStatus, internalActor], invites: inviteRows } }));
    vi.mocked(canManageDealMembers).mockResolvedValueOnce(false);

    const res = await list();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});

describe('POST /api/v1/invites — role-shape walls', () => {
  it('403s a director invite from a delegated can_invite member', async () => {
    // userCanInvite passes (delegation), but a director seat is a
    // company-management act — canManageCompanyMembers must hold.
    signedIn(
      makeAdmin({
        tables: {
          users: [activeStatus, internalActor],
          companies: { data: { name: 'Futureproofing Capital', type: 'bank' }, error: null },
        },
      }),
    );
    vi.mocked(canManageCompanyMembers).mockResolvedValueOnce(false);
    const res = await POST(req({ email: 'a@b.co', companyId: 'c1', companyRole: 'director' }));
    expect(res.status).toBe(403);
  });


  it('rejects an internal deal role for an external company', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: [activeStatus, internalActor],
          companies: { data: { name: 'BuyerCo', type: 'acquirer' }, error: null },
        },
      }),
    );
    const res = await POST(
      req({ email: 'a@b.co', companyId: 'c1', dealId: 'd1', dealRole: 'deal_team' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a seller seat for a company whose party role is acquirer-side', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: [activeStatus, internalActor],
          companies: { data: { name: 'BuyerCo', type: 'acquirer' }, error: null },
          deal_parties: { data: { party_role: 'acquirer_shortlist' }, error: null },
        },
      }),
    );
    const res = await POST(
      req({ email: 'a@b.co', companyId: 'c1', dealId: 'd1', dealRole: 'seller' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('buyer');
  });

  it('rejects an external seat when the company is not a party to the deal', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: [activeStatus, internalActor],
          companies: { data: { name: 'BuyerCo', type: 'acquirer' }, error: null },
          deal_parties: { data: null, error: null },
        },
      }),
    );
    const res = await POST(
      req({ email: 'a@b.co', companyId: 'c1', dealId: 'd1', dealRole: 'buyer' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a seller/buyer seat for a bank company', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: [activeStatus, internalActor],
          companies: { data: { name: 'Bank', type: 'bank' }, error: null },
        },
      }),
    );
    const res = await POST(
      req({ email: 'a@b.co', companyId: 'bank-1', dealId: 'd1', dealRole: 'seller' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/invites — creation & delivery', () => {
  it('rejects a Member invitation when the company has no active director', async () => {
    vi.mocked(companyHasActiveDirector).mockResolvedValueOnce(false);
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Target', type: 'target' }, error: null },
      },
    });
    signedIn(admin);

    const res = await POST(req({ email: 'a@b.co', companyId: 'c1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This company needs its first active director. Invite this person as Company Director.',
      code: 'company_requires_director',
    });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('creates, delivers, and reports deliveryStatus sent', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'BuyerCo', type: 'acquirer' }, error: null },
        deal_parties: { data: { party_role: 'acquirer_shortlist' }, error: null },
      },
      rpc: { data: CREATED, error: null },
    });
    signedIn(admin);
    const confirmationId = '10000000-0000-4000-8000-000000000001';
    const res = await POST(
      req({
        email: 'A@B.co',
        companyId: 'c1',
        dealId: 'd1',
        dealRole: 'buyer',
        confirmationId,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { deliveryStatus: string; email: string } };
    expect(body.invite.deliveryStatus).toBe('sent');
    // Email normalized to lowercase before hitting the unique pending index.
    expect(body.invite.email).toBe('a@b.co');
    expect(admin.rpc).toHaveBeenCalledWith('create_invite', expect.objectContaining({
      p_email: 'a@b.co',
      p_domain_confirmation_id: confirmationId,
    }));
    expect(vi.mocked(deliverInvite)).toHaveBeenCalledWith(
      admin,
      'http://localhost',
      expect.objectContaining({
        inviterName: 'Storm Duncan',
        inviterCompanyName: 'Futureproofing Capital',
        dealCodename: 'Project Rangers',
      }),
    );
  });

  it('reports created-but-undelivered honestly (recovery via resend)', async () => {
    vi.mocked(deliverInvite).mockResolvedValueOnce({
      deliveryStatus: 'unsent',
      error: 'email_send_failed',
    });
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: { data: CREATED, error: null },
    });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { deliveryStatus: string };
      deliveryError?: string;
    };
    expect(body.invite.deliveryStatus).toBe('unsent');
    expect(body.deliveryError).toBe('email_delivery_failed');
  });

  it('reports an existing account when the invite has no deal seat', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: { data: null, error: { message: 'active_account' } },
    });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('active account');
  });

  it('#331 F3 canary: an unmapped create_invite failure answers a code, never the database message', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: {
        data: null,
        error: { code: '22001', message: 'value too long for type character varying(200): CANARY-331-F3' },
      },
    });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('CANARY-331-F3');
    expect(text).toContain('22001');
  });

  it('adds an existing account directly to the deal', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: [
        { data: null, error: { message: 'active_account' } },
        { data: { id: 'u-existing', email: 'a@b.co', access_granted: true }, error: null },
      ],
    });
    signedIn(admin);
    const res = await POST(req({
      email: 'a@b.co', companyId: 'bank-1', dealId: 'd1', dealRole: 'deal_team',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      existingUser: { id: 'u-existing', email: 'a@b.co', accessGranted: true },
    });
    expect(admin.rpc).toHaveBeenLastCalledWith('grant_existing_account_to_deal', {
      p_actor: 'md-1',
      p_email: 'a@b.co',
      p_company_id: 'bank-1',
      p_deal_id: 'd1',
      p_deal_role: 'deal_team',
      p_phase: 0,
    });
  });

  it('does not silently discard a company-role elevation for an existing account', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: { data: null, error: { message: 'active_account' } },
    });
    signedIn(admin);
    const res = await POST(req({
      email: 'a@b.co', companyId: 'bank-1', companyRole: 'director', dealId: 'd1', dealRole: 'deal_team',
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/company-role/i) });
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it('grants an existing account even when a domain confirmation is pending', async () => {
    // preflight sets confirmationRequired for every non-matching domain, so
    // refusing on it would make this branch unreachable for any company whose
    // domains are not yet verified — the common case for a new counterparty.
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: [
        { data: null, error: { message: 'active_account' } },
        { data: { id: 'u-existing', email: 'a@b.co', access_granted: true }, error: null },
      ],
    });
    signedIn(admin);
    const res = await POST(req({
      email: 'a@b.co',
      companyId: 'bank-1',
      dealId: 'd1',
      dealRole: 'deal_team',
      confirmationId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      existingUser: { id: 'u-existing', email: 'a@b.co', accessGranted: true },
    });
    expect(admin.rpc).toHaveBeenLastCalledWith('grant_existing_account_to_deal', expect.any(Object));
  });
});

describe('POST /api/v1/invites — scoped duplicate disclosure (cr-plan-v4 4.1)', () => {
  const duplicate = {
    duplicate: true,
    id: 'inv-existing',
    delivery_status: 'unsent',
    company_id: 'c-other',
    deal_id: null,
  };

  it('discloses id + delivery state to an actor authorized over the existing scope', async () => {
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: { data: duplicate, error: null },
    });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { inviteId?: string; deliveryStatus?: string };
    expect(body.inviteId).toBe('inv-existing');
    expect(body.deliveryStatus).toBe('unsent');
  });

  it('stays opaque for an actor with no authority over the existing invite', async () => {
    vi.mocked(userCanManageInvite).mockResolvedValueOnce(false);
    const admin = makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
      },
      rpc: { data: duplicate, error: null },
    });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; inviteId?: string };
    expect(body.error).toBe('duplicate_pending');
    expect(body.inviteId).toBeUndefined();
  });
});

describe('POST /api/v1/invites/accept', () => {
  it('finalizes through the SESSION-BOUND client so auth.uid() is the acceptor', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    const { sessionRpc } = signedIn(admin, undefined, {
      data: { deal_id: 'd1', company_id: 'c1', is_external: true },
      error: null,
    });
    const res = await ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Dana Buyer',
          tosAccepted: true,
          password: 'secret-pass',
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(sessionRpc).toHaveBeenCalledWith('accept_invite', {
      p_invite_id: 'inv-1',
      p_nonce: 'nonce-1',
      p_password: 'secret-pass',
      p_tos_version: TOS_VERSION,
      p_display_name: 'Dana Buyer',
    });
    // The admin client must NOT have been the RPC carrier.
    expect(admin.rpc).not.toHaveBeenCalled();
    const body = (await res.json()) as { dealId: string; isExternal: boolean };
    expect(body.dealId).toBe('d1');
    expect(body.isExternal).toBe(true);
  });

  it('400s when the Terms of Service are not accepted', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    const { sessionRpc } = signedIn(admin, undefined, { data: null, error: null });
    const res = await ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Dana Buyer' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it('410s an expired invitation', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    signedIn(admin, undefined, { data: null, error: { message: 'invite_expired' } });
    const res = await ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tosAccepted: true, password: 'secret-pass' }),
      }),
    );
    expect(res.status).toBe(410);
  });

  it('410s a superseded credential (rotated nonce)', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    signedIn(admin, undefined, { data: null, error: { message: 'credential_mismatch' } });
    const res = await ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tosAccepted: true, password: 'secret-pass' }),
      }),
    );
    expect(res.status).toBe(410);
  });

  it('maps the database director invariant to actionable recovery guidance', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    signedIn(admin, undefined, {
      data: null,
      error: {
        message: 'Company c1 must retain at least one active director',
      },
    });

    const res = await ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tosAccepted: true, password: 'secret-pass' }),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This company needs an active director. Ask a firm admin to send a new Company Director invitation.',
      code: 'company_requires_director',
    });
  });
});

describe('onboarding containment — requireApiUser', () => {
  it("403s an 'invited' account on a normal route", async () => {
    signedIn(
      makeAdmin({ tables: { users: [{ data: { status: 'invited' }, error: null }] } }),
    );
    const res = await POST(req({ email: 'a@b.co', companyId: 'c1' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('onboarding_incomplete');
  });
});

describe('recipient affiliation on invitations',()=>{
 it('uses the atomic affiliation-aware invite operation',async()=>{
  const admin=makeAdmin({tables:{users:[activeStatus,internalActor],companies:{data:{name:'ZZ TEST Client',type:'client'},error:null},deal_parties:{data:{party_role:'target'},error:null}},rpc:{data:CREATED,error:null}});
  signedIn(admin);
  const res=await POST(req({email:'zz-test@client.test',companyId:'c1',companyRole:'member',dealId:'d1',dealRole:'seller',recipientAffiliation:'client'}));
  expect(res.status).toBe(201);
  expect(admin.rpc).toHaveBeenCalledWith('create_invite_with_affiliation',expect.objectContaining({p_affiliation:'client',p_phase:0,p_company_role:'member'}));
 });
 it('does not accept bank_team as a caller-supplied exemption',async()=>{
  const admin=makeAdmin({tables:{users:[activeStatus,internalActor],companies:{data:{name:'ZZ TEST Bank',type:'bank'},error:null}}});signedIn(admin);
  expect((await POST(req({email:'zz-test@bank.test',companyId:'c1',dealId:'d1',dealRole:'read_only',recipientAffiliation:'bank_team'}))).status).toBe(400);expect(admin.rpc).not.toHaveBeenCalled();
 });
});

describe('POST /api/v1/invites — sign-in method (#316)', () => {
  function adminFor(providerRow: Resp) {
    return makeAdmin({
      tables: {
        users: [activeStatus, internalActor],
        companies: { data: { name: 'Bank', type: 'bank' }, error: null },
        firm_identity_providers: providerRow,
      },
      rpc: { data: CREATED, error: null },
    });
  }

  it('creates a work-identity invite when the flag is on and the firm has a provider', async () => {
    const admin = adminFor({ data: { company_id: 'bank-1' }, error: null });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(201);
    expect(admin.rpc).toHaveBeenCalledWith(
      'create_invite',
      expect.objectContaining({ p_auth_method: 'work_identity' }),
    );
    expect(vi.mocked(deliverInvite)).toHaveBeenCalledWith(
      admin,
      'http://localhost',
      expect.objectContaining({ authMethod: 'work_identity', workIdentityEnabled: true }),
    );
  });

  it('keeps the email-code method when the firm has no provider', async () => {
    const admin = adminFor({ data: null, error: null });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(201);
    const [, args] = admin.rpc.mock.calls.find(([name]) => name === 'create_invite') ?? [];
    expect(args).not.toHaveProperty('p_auth_method');
    expect(vi.mocked(deliverInvite)).toHaveBeenCalledWith(
      admin,
      'http://localhost',
      expect.objectContaining({ authMethod: 'email_code' }),
    );
  });

  it('keeps the email-code method while the flag is off, even with a provider', async () => {
    vi.mocked(isFlagEnabled).mockResolvedValueOnce(false);
    const admin = adminFor({ data: { company_id: 'bank-1' }, error: null });
    signedIn(admin);
    const res = await POST(req({ email: 'a@b.co', companyId: 'bank-1' }));
    expect(res.status).toBe(201);
    const [, args] = admin.rpc.mock.calls.find(([name]) => name === 'create_invite') ?? [];
    expect(args).not.toHaveProperty('p_auth_method');
  });
});

describe('POST /api/v1/invites/accept — password and work identity (#316)', () => {
  const acceptWith = (body: unknown) =>
    ACCEPT(
      new Request('http://localhost/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it.each([
    ['missing', undefined],
    ['too short', '12345'],
    ['over 72 bytes', 'é'.repeat(37)],
  ])('400s a %s password before the RPC', async (_label, password) => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    const { sessionRpc } = signedIn(admin);
    const res = await acceptWith({ tosAccepted: true, password });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'weak_password' });
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['weak_password', 400],
    ['challenge_session_mismatch', 409],
    ['invite_method_mismatch', 409],
  ])('maps %s from the RPC', async (message, status) => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    signedIn(admin, undefined, { data: null, error: { message } });
    const res = await acceptWith({ tosAccepted: true, password: 'secret-pass' });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: message });
  });

  it('403s inviter_not_authorized with the work-identity copy (#296: acceptance re-derives the inviter seat)', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    signedIn(admin, undefined, { data: null, error: { message: 'inviter_not_authorized' } });
    const res = await acceptWith({ tosAccepted: true, password: 'secret-pass' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: workIdentityErrorCopy(WORK_IDENTITY_ERROR.INVITER_AUTHORITY_LOST).message,
      code: 'inviter_not_authorized',
    });
  });

  it('409s invite_context_missing when the account lost its invite keys', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    const { sessionRpc } = signedIn(admin);
    const server = await vi.mocked(createSupabaseServerClient)();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      ...server,
      auth: {
        ...server.auth,
        getUser: () =>
          Promise.resolve({
            data: { user: { id: 'md-1', email: 'md@bank.dev', user_metadata: {} } },
            error: null,
          }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await acceptWith({ tosAccepted: true, password: 'secret-pass' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'invite_context_missing' });
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it('never writes the attestation from the route', async () => {
    const admin = makeAdmin({ tables: { users: [{ data: null, error: null }] } });
    const insert = vi.fn();
    const from = admin.from;
    (admin as { from: unknown }).from = (table: string) => {
      const builder = from(table) as unknown as Record<string, unknown>;
      return { ...builder, insert };
    };
    signedIn(admin, undefined, { data: { deal_id: null, company_id: 'c1', is_external: true }, error: null });
    const res = await acceptWith({ tosAccepted: true, password: 'secret-pass' });
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });
});
