// assessProposal — the shared feasibility path behind smart lookup, the
// perimeter preview, and the send route (plan-v5 §5).
//
// This suite pins assessProposal's OWN logic: check ordering, company-role
// coercion, deal-role shape, phase handling, and the error/denial split. The
// authority predicates are mocked here on purpose, because that is what makes
// the ordering guarantee testable: when the target is in another tenant we can
// assert userCanInvite was NEVER CALLED, rather than merely that the answer was
// no. The tier -> verdict mapping those predicates produce is pinned separately
// in tests/invite-authority-parity.test.ts against the real module.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/access', () => ({
  userCanInvite: vi.fn(() => Promise.resolve(true)),
  userCanInviteChecked: vi.fn(async () => true),
  canManageCompanyMembers: vi.fn(() => Promise.resolve(true)),
}));

import { assessProposal, type Proposal } from '@/lib/api/v1/proposalFeasibility';
import { canManageCompanyMembers, userCanInvite } from '@/lib/api/v1/access';

type Resp = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = vi.fn((table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
    return builder;
  });
  return { from } as never;
}

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

const internalDirector: Resp = {
  data: {
    tenant_id: TENANT,
    firm_role: null,
    is_external: false,
    company_id: 'bank-1',
    company_role: 'director',
    can_invite: false,
  },
  error: null,
};
const externalDirector: Resp = {
  data: {
    tenant_id: TENANT,
    firm_role: null,
    is_external: true,
    company_id: 'seller-1',
    company_role: 'director',
    can_invite: false,
  },
  error: null,
};
const firmAdmin: Resp = {
  data: {
    tenant_id: TENANT,
    firm_role: 'admin',
    is_external: false,
    company_id: 'bank-1',
    company_role: 'director',
    can_invite: false,
  },
  error: null,
};

const bankCompany: Resp = { data: { tenant_id: TENANT, type: 'bank' }, error: null };
const sellerCompany: Resp = { data: { tenant_id: TENANT, type: 'target' }, error: null };
const buyerCompany: Resp = { data: { tenant_id: TENANT, type: 'acquirer' }, error: null };
const foreignCompany: Resp = { data: { tenant_id: OTHER_TENANT, type: 'target' }, error: null };

const dealInTenant: Resp = { data: { tenant_id: TENANT }, error: null };
const sellerParty: Resp = { data: { party_role: 'target' }, error: null };
const buyerParty: Resp = { data: { party_role: 'acquirer_shortlist' }, error: null };

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  email: 'alex@target.example',
  companyId: 'seller-1',
  companyRole: 'member',
  dealId: 'deal-1',
  dealRole: 'seller',
  phase: 0,
  ...over,
});

beforeEach(() => {
  vi.mocked(userCanInvite).mockResolvedValue(true);
  vi.mocked(canManageCompanyMembers).mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('assessProposal — tenant coherence runs first, unconditionally', () => {
  it('refuses a cross-tenant company WITHOUT consulting userCanInvite', async () => {
    // The regression this guards: userCanInvite returns true for any firm admin
    // before it checks tenancy, so consulting it first would let an admin probe
    // another tenant's companies through the preview.
    //
    // Every OTHER fixture is deliberately valid, so the company tenant check is
    // the only thing that can refuse. An earlier version of this test omitted
    // the deal fixture and passed against a build with the tenant comparison
    // deleted: it was being satisfied by the missing-deal wall instead.
    const admin = makeAdmin({
      users: firmAdmin,
      companies: foreignCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'admin-1', proposal());

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(userCanInvite).not.toHaveBeenCalled();
  });

  it('refuses a cross-tenant deal WITHOUT consulting userCanInvite', async () => {
    const admin = makeAdmin({
      users: firmAdmin,
      companies: sellerCompany,
      deals: { data: { tenant_id: OTHER_TENANT }, error: null },
    });

    const result = await assessProposal(admin, 'admin-1', proposal());

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(userCanInvite).not.toHaveBeenCalled();
  });

  it('gives an unknown company the same answer as a cross-tenant one', async () => {
    // Two different truths, one response: neither confirms the other.
    const rest = { deals: dealInTenant, deal_parties: sellerParty };
    const unknown = await assessProposal(
      makeAdmin({ users: internalDirector, companies: { data: null, error: null }, ...rest }),
      'dir-1',
      proposal(),
    );
    const foreign = await assessProposal(
      makeAdmin({ users: internalDirector, companies: foreignCompany, ...rest }),
      'dir-1',
      proposal(),
    );

    expect(unknown).toEqual(foreign);
    expect(unknown).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('assessProposal — company role mirrors the send route', () => {
  it('requires the first active user at an unclaimed company to be a director', async () => {
    const admin = makeAdmin({
      users: [internalDirector, { data: null, error: null }],
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'admin-1', proposal());

    expect(result).toEqual({ ok: false, reason: 'company_requires_director' });
  });

  it('coerces an EXTERNAL actor to member and never consults company management', async () => {
    const admin = makeAdmin({
      users: externalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(
      admin,
      'ext-dir',
      proposal({ companyRole: 'director' }),
    );

    expect(result).toMatchObject({ ok: true, companyRole: 'member' });
    expect(canManageCompanyMembers).not.toHaveBeenCalled();
  });

  it('permits an authorized INTERNAL actor to invite a director', async () => {
    // The authority plan-v3 would have removed by coercing on company instead
    // of on actor.
    const admin = makeAdmin({
      users: internalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'dir-1', proposal({ companyRole: 'director' }));

    expect(result).toMatchObject({ ok: true, companyRole: 'director' });
    expect(canManageCompanyMembers).toHaveBeenCalledWith(admin, 'dir-1', 'seller-1');
  });

  it('refuses a director invite when company management authority is absent', async () => {
    vi.mocked(canManageCompanyMembers).mockResolvedValue(false);
    const admin = makeAdmin({
      users: internalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'member-1', proposal({ companyRole: 'director' }));

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects a company role outside the allowed pair', async () => {
    const admin = makeAdmin({ users: internalDirector, companies: sellerCompany, deals: dealInTenant });

    const result = await assessProposal(admin, 'dir-1', proposal({ companyRole: 'owner' }));

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('assessProposal — deal-role shape is party-derived', () => {
  it('resolves the buyer seat from an acquirer party row', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: buyerCompany,
      deals: dealInTenant,
      deal_parties: buyerParty,
    });

    const result = await assessProposal(
      admin,
      'dir-1',
      proposal({ companyId: 'buyer-1', dealRole: 'buyer' }),
    );

    expect(result).toMatchObject({ ok: true, dealRole: 'buyer' });
  });

  it('refuses a seat that contradicts the party relationship', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: buyerCompany,
      deals: dealInTenant,
      deal_parties: buyerParty,
    });

    const result = await assessProposal(admin, 'dir-1', proposal({ companyId: 'buyer-1', dealRole: 'seller' }));

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an external company that is not a party to the deal', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: { data: null, error: null },
    });

    expect(await assessProposal(admin, 'dir-1', proposal())).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an internal seat for an external company and vice versa', async () => {
    const external = await assessProposal(
      makeAdmin({ users: internalDirector, companies: sellerCompany, deals: dealInTenant }),
      'dir-1',
      proposal({ dealRole: 'deal_team' }),
    );
    const bank = await assessProposal(
      makeAdmin({ users: internalDirector, companies: bankCompany, deals: dealInTenant }),
      'dir-1',
      proposal({ companyId: 'bank-1', dealRole: 'seller' }),
    );

    expect(external).toEqual({ ok: false, reason: 'invalid' });
    expect(bank).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never admits the md seat', async () => {
    const admin = makeAdmin({ users: internalDirector, companies: bankCompany, deals: dealInTenant });

    expect(
      await assessProposal(admin, 'dir-1', proposal({ companyId: 'bank-1', dealRole: 'md' })),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a deal role with no deal attached', async () => {
    const admin = makeAdmin({ users: internalDirector, companies: sellerCompany });

    expect(await assessProposal(admin, 'dir-1', proposal({ dealId: null }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('assessProposal — phase and the resolved subject', () => {
  it('preserves a proposed phase for an external company', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'dir-1', proposal({ phase: 2 }));

    expect(result).toMatchObject({
      ok: true,
      phase: 2,
      subject: { isExternal: true, hasOversight: false, dealRole: 'seller', phase: 2 },
    });
  });

  it('coerces phase to 0 for a bank-company seat rather than honouring it', async () => {
    // Phase gates external users only, so an internal seat has no phase to
    // raise. Gate 0 queues bank-company invitations; this is that boundary.
    const admin = makeAdmin({ users: internalDirector, companies: bankCompany, deals: dealInTenant });

    const result = await assessProposal(
      admin,
      'dir-1',
      proposal({ companyId: 'bank-1', dealRole: 'deal_team', phase: 3 }),
    );

    expect(result).toMatchObject({
      ok: true,
      phase: 0,
      subject: { isExternal: false, phase: 0 },
    });
  });

  it('refuses a negative or fractional phase', async () => {
    const admin = () =>
      makeAdmin({
        users: internalDirector,
        companies: sellerCompany,
        deals: dealInTenant,
        deal_parties: sellerParty,
      });

    expect(await assessProposal(admin(), 'dir-1', proposal({ phase: -1 }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await assessProposal(admin(), 'dir-1', proposal({ phase: 1.5 }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('never grants oversight to a proposed subject', async () => {
    const admin = makeAdmin({
      users: firmAdmin,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: sellerParty,
    });

    const result = await assessProposal(admin, 'admin-1', proposal());

    expect(result).toMatchObject({ ok: true, subject: { hasOversight: false } });
  });
});

describe('assessProposal — a failed read is never a denial', () => {
  it('reports unavailable when the company read errors', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: { data: null, error: { message: 'timeout' } },
    });

    expect(await assessProposal(admin, 'dir-1', proposal())).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reports unavailable when the party read errors', async () => {
    const admin = makeAdmin({
      users: internalDirector,
      companies: sellerCompany,
      deals: dealInTenant,
      deal_parties: { data: null, error: { message: 'timeout' } },
    });

    expect(await assessProposal(admin, 'dir-1', proposal())).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reports unavailable when an authority predicate throws', async () => {
    vi.mocked(userCanInvite).mockRejectedValue(new Error('down'));
    const admin = makeAdmin({ users: internalDirector, companies: sellerCompany, deals: dealInTenant });

    expect(await assessProposal(admin, 'dir-1', proposal())).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('refuses when the actor profile is missing', async () => {
    const admin = makeAdmin({ users: { data: null, error: null } });

    expect(await assessProposal(admin, 'ghost', proposal())).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
