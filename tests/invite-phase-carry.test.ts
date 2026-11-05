import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.INVITE_VERIFICATION_PEPPER = 'unit-test-invite-pepper';

/**
 * The confirmed disclosure phase has to survive the whole journey: the inviter
 * confirms it on screen, it reaches create_invite, it is stored on the
 * invitation, and accept_invite grants exactly it.
 *
 * Before this work the last two steps did not exist — accept_invite inserted a
 * literal 0 and audited a literal 0 — so an inviter could confirm phase 2, watch
 * a phase-2 preview, and the accepted user would land on phase 0. A preview that
 * confidently describes access nobody receives is worse than no preview.
 *
 * This file pins the TypeScript half (the route hands the phase to the RPC and
 * refuses malformed values). The SQL half — stored verbatim, granted verbatim,
 * pinned to 0 for internal seats — is in supabase/tests/invite_authority_parity.sql.
 */
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/access', () => ({
  // The invite family's deal-visibility gate (D65): the caller can see the deal.
  userCanAccessDeal: vi.fn(async () => true),
  userCanInvite: vi.fn(() => Promise.resolve(true)),
  userCanInviteChecked: vi.fn(async () => true),
  userCanManageInvite: vi.fn(() => Promise.resolve(true)),
  canManageCompanyMembers: vi.fn(() => Promise.resolve(true)),
  canManageDealMembers: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  deliverInvite: vi.fn(() => Promise.resolve({ deliveryStatus: 'sent' })),
  fetchInviteEmailContext: vi.fn(() => Promise.resolve({})),
}));
vi.mock('@/lib/api/v1/proposalFeasibility', () => ({
  companyHasActiveDirector: vi.fn(() => Promise.resolve(true)),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { POST } from '@/app/api/v1/invites/route';

type Resp = { data: unknown; error: unknown };

const CREATED: Resp = {
  data: {
    duplicate: false,
    id: 'inv-1',
    delivery_status: 'sent',
    company_id: 'seller-1',
    deal_id: 'deal-1',
    credential_nonce: 'nonce-1',
    tenant_id: 'tenant-1',
    expires_at: '2026-09-01T00:00:00Z',
  },
  error: null,
};

function makeAdmin(rpcResp: Resp = CREATED) {
  const tables: Record<string, Resp> = {
    deals: { data: { id: 'deal-1', code: 'PROJECT-X' }, error: null },
    companies: { data: { name: 'Target Co', type: 'target' }, error: null },
    deal_parties: { data: { party_role: 'target' }, error: null },
  };
  const from = (table: string) => {
    const resp = tables[table] ?? { data: null, error: null };
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
    builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpc = vi.fn(() => Promise.resolve(rpcResp));
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    rpc: ReturnType<typeof vi.fn>;
  };
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
      },
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'md-1', email: 'md@bank.dev' } }, error: null }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function req(over: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/v1/invites', {
    method: 'POST',
    body: JSON.stringify({
      email: 'invitee@target.dev',
      companyId: 'seller-1',
      companyRole: 'member',
      dealId: 'PROJECT-X',
      dealRole: 'seller',
      ...over,
    }),
  });
}

afterEach(() => vi.clearAllMocks());

describe('confirmed phase reaches the invitation', () => {
  it('hands the confirmed phase to create_invite', async () => {
    const admin = makeAdmin();
    signedIn(admin);

    const res = await POST(req({ phase: 2 }));

    expect(res.status).toBe(201);
    const [name, args] = admin.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('create_invite');
    expect(args.p_phase).toBe(2);
  });

  it('defaults to phase 0, so callers that predate this field are unaffected', async () => {
    const admin = makeAdmin();
    signedIn(admin);

    await POST(req());

    const [, args] = admin.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_phase).toBe(0);
  });

  it('refuses a malformed phase before reaching the write', async () => {
    for (const phase of [-1, 1.5, 'two']) {
      const admin = makeAdmin();
      signedIn(admin);

      const res = await POST(req({ phase }));

      expect(res.status, `phase ${String(phase)}`).toBe(400);
      expect(admin.rpc).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });
});

describe('authority lost between compose and send', () => {
  it('answers opaquely when the write transaction refuses on authority', async () => {
    const admin = makeAdmin({ data: null, error: { message: 'not_permitted' } });
    signedIn(admin);

    const res = await POST(req({ phase: 1 }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(403);
    // A prober learns that the send was refused, not which company, deal or
    // membership changed underneath them.
    expect(JSON.stringify(body)).not.toMatch(/seller-1|deal-1|director|party/i);
  });

  it('reports a shape refusal as a client error, not a server fault', async () => {
    for (const code of ['invalid_company_role', 'invalid_deal_role', 'invalid_phase']) {
      const admin = makeAdmin({ data: null, error: { message: code } });
      signedIn(admin);

      const res = await POST(req());

      expect(res.status, code).toBe(400);
      vi.clearAllMocks();
    }
  });
});
