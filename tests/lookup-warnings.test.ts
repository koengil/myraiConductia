import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as lookup, WARNING } from '@/app/api/v1/invites/lookup/route';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';

/**
 * Lookup warnings and disclosure scoping: D8.1 (each condition, positive and
 * negative), D8.2 (pending invitation, authorized and not), D8.3 (existing
 * user and existing seat, authorized and not, including another company and
 * another tenant).
 *
 * The scoping is the substance. Authority to COMPOSE an invitation is not
 * authority to interrogate the user base, so each disclosable condition is
 * gated by the visibility the actor already holds.
 */

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));

const canManageDealMembers = vi.fn(async () => false);
const canManageCompanyMembers = vi.fn(async () => true);
const userIsDealMd = vi.fn(async () => false);
const userCanManageInvite = vi.fn(async () => false);
vi.mock('@/lib/api/v1/access', () => ({
  // The invite family's deal-visibility gate (D65): the caller can see the deal.
  userCanAccessDeal: async () => true,
  canManageCompanyMembers: (...a: unknown[]) => canManageCompanyMembers(...(a as [])),
  canManageDealMembers: (...a: unknown[]) => canManageDealMembers(...(a as [])),
  userIsDealMd: (...a: unknown[]) => userIsDealMd(...(a as [])),
  userCanManageInvite: (...a: unknown[]) => userCanManageInvite(...(a as [])),
}));
const companyHasActiveDirector = vi.fn(async () => true);
vi.mock('@/lib/api/v1/proposalFeasibility', () => ({
  companyHasActiveDirector: (...a: unknown[]) => companyHasActiveDirector(...(a as [])),
}));

const requireApiUser = vi.fn();
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: () => requireApiUser(),
    resolveDealRef: vi.fn(async () => ({ id: 'deal-1', code: 'PROJECT-X' })),
  };
});

type Resp = { data: unknown; error: { message: string } | null };
const NO_ROW: Resp = { data: null, error: null };

function makeAdmin(
  tables: Record<string, Resp | Resp[]>,
  permission: Resp = { data: true, error: null },
) {
  return {
    from: vi.fn((table: string) => {
      const entry = tables[table] ?? NO_ROW;
      const resp = Array.isArray(entry) ? (entry.shift() ?? NO_ROW) : entry;
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.single = () => Promise.resolve(resp);
      builder.maybeSingle = () => Promise.resolve(resp);
      builder.then = (r: (v: Resp) => unknown) => Promise.resolve(resp).then(r);
      return builder;
    }),
    rpc: vi.fn(() => Promise.resolve(permission)),
  };
}

const ACTOR = {
  tenant_id: 't1',
  firm_role: null,
  is_external: false,
  company_id: 'bank-1',
  company_role: 'director',
};

/** A world where the actor is an internal director of the bank company. */
function world(
  over: Record<string, Resp | Resp[]> = {},
  permission: Resp = { data: true, error: null },
) {
  return makeAdmin(
    {
      users: [{ data: ACTOR, error: null }],
      companies: { data: { id: 'bank-1', name: 'Advisory Bank', type: 'bank' }, error: null },
      company_verified_domains: { data: [{ company_id: 'bank-1', domain: 'bank.dev' }], error: null },
      invites: NO_ROW,
      ...over,
    },
    permission,
  );
}

async function ask(email: string, admin: ReturnType<typeof makeAdmin>, dealId?: string) {
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'dir-1' }, admin });
  const res = await lookup(
    new Request('http://x/api/v1/invites/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, dealId }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const ids = (body: { warnings?: { id: string }[] }) => (body.warnings ?? []).map((w) => w.id);

beforeEach(() => {
  vi.clearAllMocks();
  canManageDealMembers.mockResolvedValue(false);
  canManageCompanyMembers.mockResolvedValue(true);
  companyHasActiveDirector.mockResolvedValue(true);
  userIsDealMd.mockResolvedValue(false);
  userCanManageInvite.mockResolvedValue(false);
});

describe('company candidate authorization', () => {
  it('uses the authoritative invites:send permission for the actor own company', async () => {
    const admin = world();
    const { status } = await ask('alex@bank.dev', admin);

    expect(status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('app_has_company_permission', {
      p_user_id: 'dir-1',
      p_company_id: 'bank-1',
      p_permission_key: COMPANY_PERMISSION.INVITES_SEND,
    });
  });

  it('does not let the legacy can_invite flag create a candidate', async () => {
    const legacyActor = { ...ACTOR, company_role: 'member', can_invite: true };
    const { status, body } = await ask(
      'alex@bank.dev',
      world({ users: { data: legacyActor, error: null } }, { data: false, error: null }),
    );

    expect(status).toBe(200);
    expect(body.companyMatch).toBeNull();
    expect(body.warnings).toEqual([]);
    expect(body.recommendation).toBeNull();
  });

  it('returns unavailable when the permission decision is unreadable', async () => {
    const { status, body } = await ask(
      'alex@bank.dev',
      world({}, { data: null, error: { message: 'down' } }),
    );

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'Lookup is unavailable' });
  });
});

describe('domain conditions (D8.1)', () => {
  it('reports the available company roles when the company is unclaimed', async () => {
    companyHasActiveDirector.mockResolvedValueOnce(false);
    canManageCompanyMembers.mockResolvedValueOnce(true);

    const { body } = await ask('alex@bank.dev', world());

    expect(body.companyRolePolicy).toEqual({
      companyId: 'bank-1',
      memberAllowed: false,
      directorAllowed: true,
      requiresDirector: true,
    });
  });

  it('flags a personal address', async () => {
    const { body } = await ask('someone@gmail.com', world());
    expect(ids(body)).toContain(WARNING.PERSONAL_DOMAIN);
  });

  it('does not flag a business address as personal', async () => {
    const { body } = await ask('alex@bank.dev', world());
    expect(ids(body)).not.toContain(WARNING.PERSONAL_DOMAIN);
  });

  it('matches a company on its verified domain and recommends a seat', async () => {
    const { body } = await ask('alex@bank.dev', world());
    expect(body.companyMatch).toEqual({ companyId: 'bank-1', companyName: 'Advisory Bank' });
    expect(body.recommendation?.dealRole).toBe('deal_team');
  });

  it('matches a subdomain of a verified domain', async () => {
    const { body } = await ask('alex@eu.bank.dev', world());
    expect(body.companyMatch?.companyId).toBe('bank-1');
  });

  it('proposes a readable label for an unrecognized domain', async () => {
    const { body } = await ask('alex@northgate-capital.com', world({ company_verified_domains: { data: [], error: null } }));
    expect(body.companyMatch).toBeNull();
    expect(body.proposedCompany?.label).toBe('Northgate Capital');
  });

  it('flags a company with no verified domain configured', async () => {
    const { body } = await ask('alex@bank.dev', world({ company_verified_domains: { data: [], error: null } }));
    expect(ids(body)).toContain(WARNING.UNVERIFIED_DOMAIN);
  });
});

describe('existing platform user — A17 scoping (D8.3)', () => {
  const sameCompanyUser = { data: { id: 'u-9', company_id: 'bank-1', tenant_id: 't1' }, error: null };
  const otherCompanyUser = { data: { id: 'u-9', company_id: 'other-co', tenant_id: 't1' }, error: null };
  const otherTenantUser = { data: { id: 'u-9', company_id: 'x', tenant_id: 't2' }, error: null };

  it('discloses a user at the actor own company', async () => {
    const { body } = await ask('alex@bank.dev', world({ users: [{ data: ACTOR, error: null }, sameCompanyUser] }));
    expect(ids(body)).toContain(WARNING.EXISTING_PLATFORM_USER);
  });

  it('does not disclose a user at another company the actor cannot see', async () => {
    const { body } = await ask('alex@bank.dev', world({ users: [{ data: ACTOR, error: null }, otherCompanyUser] }));
    expect(ids(body)).not.toContain(WARNING.EXISTING_PLATFORM_USER);
  });

  it('does not disclose a user in another tenant', async () => {
    const { body } = await ask('alex@bank.dev', world({ users: [{ data: ACTOR, error: null }, otherTenantUser] }));
    expect(ids(body)).not.toContain(WARNING.EXISTING_PLATFORM_USER);
  });

  it('discloses to a firm overseer within the tenant', async () => {
    const cco = { data: { ...ACTOR, firm_role: 'cco' }, error: null };
    const { body } = await ask('alex@bank.dev', world({ users: [cco, otherCompanyUser] }));
    expect(ids(body)).toContain(WARNING.EXISTING_PLATFORM_USER);
  });

  it('does not disclose across tenants even to a firm overseer', async () => {
    const cco = { data: { ...ACTOR, firm_role: 'cco' }, error: null };
    const { body } = await ask('alex@bank.dev', world({ users: [cco, otherTenantUser] }));
    expect(ids(body)).not.toContain(WARNING.EXISTING_PLATFORM_USER);
  });

  it('recommends a disclosable same-company colleague preferred role', async () => {
    const preferred = {
      data: {
        id: 'u-9',
        company_id: 'bank-1',
        tenant_id: 't1',
        preferred_deal_role: 'legal',
      },
      error: null,
    };
    const { body } = await ask(
      'alex@bank.dev',
      world({ users: [{ data: ACTOR, error: null }, preferred] }),
    );
    expect(body.recommendation).toMatchObject({
      dealRole: 'legal',
      reasons: { dealRole: 'employee_default' },
    });
  });

  it('falls back to the internal default when the colleague has no preference', async () => {
    const noPreference = {
      data: {
        id: 'u-9',
        company_id: 'bank-1',
        tenant_id: 't1',
        preferred_deal_role: null,
      },
      error: null,
    };
    const { body } = await ask(
      'alex@bank.dev',
      world({ users: [{ data: ACTOR, error: null }, noPreference] }),
    );
    expect(body.recommendation).toMatchObject({
      dealRole: 'deal_team',
      reasons: { dealRole: 'bank_internal_seat' },
    });
  });

  it('never applies a preferred role from another company', async () => {
    const hiddenPreference = {
      data: {
        id: 'u-9',
        company_id: 'other-co',
        tenant_id: 't1',
        preferred_deal_role: 'legal',
      },
      error: null,
    };
    const { body } = await ask(
      'alex@bank.dev',
      world({ users: [{ data: ACTOR, error: null }, hiddenPreference] }),
    );
    expect(body.recommendation).toMatchObject({
      dealRole: 'deal_team',
      reasons: { dealRole: 'bank_internal_seat' },
    });
  });
});

describe('existing deal seat — A18 scoping (D8.3)', () => {
  const seatedUser = { data: { id: 'u-9', company_id: 'other-co', tenant_id: 't1' }, error: null };

  it('discloses a seat to an actor authorized over this deal membership', async () => {
    canManageDealMembers.mockResolvedValue(true);
    const { body } = await ask(
      'alex@bank.dev',
      world({
        users: [{ data: ACTOR, error: null }, seatedUser],
        deal_memberships: { data: { user_id: 'u-9' }, error: null },
        deal_parties: { data: [{ company_id: 'other-co' }], error: null },
        deals: { data: { bank_id: 'bank-1' }, error: null },
      }),
      'PROJECT-X',
    );
    expect(ids(body)).toContain(WARNING.EXISTING_DEAL_SEAT);
  });

  it('does not disclose a seat to an actor with no authority over the membership', async () => {
    const { body } = await ask(
      'alex@bank.dev',
      world({
        users: [{ data: ACTOR, error: null }, seatedUser],
        deal_memberships: { data: { user_id: 'u-9' }, error: null },
      }),
      'PROJECT-X',
    );
    expect(ids(body)).not.toContain(WARNING.EXISTING_DEAL_SEAT);
  });
});

describe('pending invitation — A6 scoping (D8.2)', () => {
  const pending = { data: { id: 'inv-1', company_id: 'bank-1', deal_id: null }, error: null };

  it('discloses to an actor authorized over that invitation', async () => {
    userCanManageInvite.mockResolvedValue(true);
    const { body } = await ask('alex@bank.dev', world({ invites: pending }));
    expect(ids(body)).toContain(WARNING.PENDING_INVITATION);
  });

  it('stays silent for an actor who is not', async () => {
    const { body } = await ask('alex@bank.dev', world({ invites: pending }));
    expect(ids(body)).not.toContain(WARNING.PENDING_INVITATION);
  });
});

describe('malformed input and failed reads (A12, A16)', () => {
  it('refuses a malformed address without querying anything', async () => {
    const admin = world();
    const { status } = await ask('not-an-email', admin);
    expect(status).toBe(400);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('returns unavailable rather than a partial answer when a scope read fails', async () => {
    const { status, body } = await ask(
      'alex@bank.dev',
      world({ company_verified_domains: { data: null, error: { message: 'boom' } } }),
    );
    expect(status).toBe(503);
    expect(body.warnings).toBeUndefined();
    expect(body.recommendation).toBeUndefined();
  });
});
