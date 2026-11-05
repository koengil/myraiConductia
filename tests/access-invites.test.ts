import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  userIsOnboarded,
  userCanInvite,
  userCanInviteChecked,
  userCanManageInvite,
} from '@/lib/api/v1/access';

/*
 * Who-may-invite matrix (spec-v3 criterion 5; cr-plan-v1 2.1) against the REAL
 * predicates, driven by a chainable admin stub. The wall under test: external
 * directors grow their own team on their own deals — nothing else.
 */

type Resp = { data: unknown; error: unknown };

function makeAdmin(
  given: Record<string, Resp | Resp[]>,
  permission: Resp = { data: false, error: null },
): SupabaseClient {
  // Every actor and every invited company sit in tenant t1 unless a test says
  // otherwise, so a case that expects `false` fails on the rule it is about
  // rather than on tenant coherence.
  const tables: Record<string, Resp | Resp[]> = {
    companies: { data: { tenant_id: 't1' }, error: null },
    ...given,
  };
  const from = (table: string) => {
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
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpc = () => Promise.resolve(permission);
  return { from, rpc } as unknown as SupabaseClient;
}

const externalDirector = (companyId: string): Resp => ({
  data: {
    firm_role: null,
    is_external: true,
    company_id: companyId,
    company_role: 'director',
    tenant_id: 't1',
  },
  error: null,
});
const externalMember: Resp = {
  data: {
    firm_role: null,
    is_external: true,
    company_id: 'c1',
    company_role: 'member',
    tenant_id: 't1',
  },
  error: null,
};
const firmAdmin: Resp = {
  data: {
    firm_role: 'admin',
    is_external: false,
    company_id: 'bank',
    company_role: null,
    tenant_id: 't1',
  },
  error: null,
};
const internalStaff: Resp = {
  data: {
    firm_role: null,
    is_external: false,
    company_id: 'bank',
    company_role: null,
    tenant_id: 't1',
  },
  error: null,
};

describe('userIsOnboarded', () => {
  it('true for an active profile, false for invited, false for missing', async () => {
    expect(
      await userIsOnboarded(makeAdmin({ users: { data: { status: 'active' }, error: null } }), 'u1'),
    ).toBe(true);
    expect(
      await userIsOnboarded(makeAdmin({ users: { data: { status: 'invited' }, error: null } }), 'u1'),
    ).toBe(false);
    expect(await userIsOnboarded(makeAdmin({}), 'u1')).toBe(false);
  });
});

describe('userCanInvite — external side of the wall', () => {
  it('firm admin may invite anywhere', async () => {
    const ok = await userCanInvite(
      makeAdmin({ users: firmAdmin }, { data: true, error: null }),
      'a1',
      {
      companyId: 'anything',
      dealId: null,
      },
    );
    expect(ok).toBe(true);
  });

  it("a firm admin may invite onto their own firm's deal only (#248)", async () => {
    const own = makeAdmin({ users: firmAdmin, deals: { data: { tenant_id: 't1' }, error: null } });
    expect(await userCanInvite(own, 'a1', { companyId: 'c1', dealId: 'd1' })).toBe(true);

    const foreign = makeAdmin({ users: firmAdmin, deals: { data: { tenant_id: 't2' }, error: null } });
    expect(await userCanInvite(foreign, 'a1', { companyId: 'c1', dealId: 'd-other-firm' })).toBe(
      false,
    );

    const missing = makeAdmin({ users: firmAdmin, deals: { data: null, error: null } });
    expect(await userCanInvite(missing, 'a1', { companyId: 'c1', dealId: 'd-none' })).toBe(false);

    const unreadable = makeAdmin({ users: firmAdmin, deals: { data: null, error: { message: 'x' } } });
    expect(await userCanInviteChecked(unreadable, 'a1', { companyId: 'c1', dealId: 'd1' })).toBe(
      'unreadable',
    );
  });

  it('an external MEMBER may never invite', async () => {
    const ok = await userCanInvite(makeAdmin({ users: externalMember }), 'a1', {
      companyId: 'c1',
      dealId: 'd1',
    });
    expect(ok).toBe(false);
  });

  it("an external director may not invite into ANOTHER company", async () => {
    const ok = await userCanInvite(makeAdmin({ users: externalDirector('c1') }), 'a1', {
      companyId: 'c-other',
      dealId: 'd1',
    });
    expect(ok).toBe(false);
  });

  it('an external CLIENT director may invite employees into their own company without a deal', async () => {
    const client = makeAdmin({
      users: externalDirector('c1'),
      companies: { data: { tenant_id: 't1', type: 'client' }, error: null },
    });
    expect(await userCanInvite(client, 'a1', { companyId: 'c1', dealId: null })).toBe(true);
  });

  it('an external director of a NON-client company gets no deal-less invite (matches create_invite, #296)', async () => {
    for (const type of ['target', 'acquirer', 'counterparty']) {
      const admin = makeAdmin({
        users: externalDirector('c1'),
        companies: { data: { tenant_id: 't1', type }, error: null },
      });
      expect(await userCanInvite(admin, 'a1', { companyId: 'c1', dealId: null }), type).toBe(false);
    }
  });

  it('reports a failed company read as unreadable rather than as a refusal', async () => {
    const admin = makeAdmin({
      users: externalDirector('c1'),
      companies: { data: null, error: { message: 'x' } },
    });
    expect(await userCanInviteChecked(admin, 'a1', { companyId: 'c1', dealId: null })).toBe('unreadable');
  });

  it("an external director may not invite onto a deal their company is NOT party to", async () => {
    const admin = makeAdmin({
      users: externalDirector('c1'),
      deal_parties: { data: null, error: null },
    });
    expect(await userCanInvite(admin, 'a1', { companyId: 'c1', dealId: 'd1' })).toBe(false);
  });

  it('an external director MAY invite own-company members onto a deal their company is party to', async () => {
    const admin = makeAdmin({
      users: externalDirector('c1'),
      deal_parties: { data: { id: 'p1' }, error: null },
    });
    expect(await userCanInvite(admin, 'a1', { companyId: 'c1', dealId: 'd1' })).toBe(true);
  });

  it('a missing actor profile denies', async () => {
    expect(await userCanInvite(makeAdmin({}), 'ghost', { companyId: 'c1', dealId: null })).toBe(
      false,
    );
  });
});

describe('userCanInvite — internal side (delegates to seat management)', () => {
  it('the deal MD may invite onto their deal', async () => {
    const admin = makeAdmin({
      // 1: actor profile; 2: userIsDealMd's firm_role probe.
      users: [internalStaff, { data: { firm_role: null }, error: null }],
      deal_memberships: { data: { deal_role: 'md' }, error: null },
    });
    expect(await userCanInvite(admin, 'md-1', { companyId: 'c1', dealId: 'd1' })).toBe(true);
  });
});

describe('userCanManageInvite — scoped disclosure boundary (cr-plan-v4 4.1)', () => {
  it('an external director sees only their own company invites', async () => {
    expect(
      await userCanManageInvite(makeAdmin({ users: externalDirector('c1') }), 'a1', {
        companyId: 'c1',
        dealId: null,
      }),
    ).toBe(true);
    expect(
      await userCanManageInvite(makeAdmin({ users: externalDirector('c1') }), 'a1', {
        companyId: 'c-other',
        dealId: null,
      }),
    ).toBe(false);
  });

  it('an internal actor needs seat-management rights over the invite deal', async () => {
    const admin = makeAdmin({
      users: [internalStaff, { data: { firm_role: null }, error: null }],
      deal_memberships: { data: { deal_role: 'md' }, error: null },
    });
    expect(await userCanManageInvite(admin, 'md-1', { companyId: 'c1', dealId: 'd1' })).toBe(
      true,
    );
  });

  it('a firm admin is an admin of their firm, not of the platform', async () => {
    expect(
      await userCanManageInvite(makeAdmin({ users: firmAdmin }), 'a1', {
        companyId: 'c1',
        dealId: null,
      }),
    ).toBe(true);

    // The pending-invite index is global, so an address can resolve to an
    // invitation in a tenant this admin has no relationship with. Their admin
    // bit does not reach it (A6, A19).
    expect(
      await userCanManageInvite(
        makeAdmin({ users: firmAdmin, companies: { data: { tenant_id: 't2' }, error: null } }),
        'a1',
        { companyId: 'c-elsewhere', dealId: null },
      ),
    ).toBe(false);
  });

  it('an invitation whose company cannot be resolved is not disclosed', async () => {
    expect(
      await userCanManageInvite(
        makeAdmin({ users: firmAdmin, companies: { data: null, error: null } }),
        'a1',
        { companyId: 'no-such-company', dealId: null },
      ),
    ).toBe(false);
  });
});

describe('userCanInvite — authoritative company invitation permission', () => {
  const grantedMember: Resp = {
    data: {
      firm_role: null,
      is_external: false,
      company_id: 'c1',
      company_role: 'member',
      can_invite: false,
    },
    error: null,
  };
  const legacyFlagMember: Resp = {
    data: {
      firm_role: null,
      is_external: false,
      company_id: 'c1',
      company_role: 'member',
      can_invite: true,
    },
    error: null,
  };
  const notDirector: Resp = {
    data: { firm_role: null, company_id: 'c1', company_role: 'member' },
    error: null,
  };

  it('an effective invites:send grant permits a company-level invite', async () => {
    const ok = await userCanInvite(
      makeAdmin({ users: grantedMember }, { data: true, error: null }),
      'u1',
      { companyId: 'c1', dealId: null },
    );
    expect(ok).toBe(true);
  });

  it('never treats the legacy users.can_invite flag as authority', async () => {
    const ok = await userCanInvite(makeAdmin({ users: legacyFlagMember }), 'u1', {
      companyId: 'c1',
      dealId: null,
    });
    expect(ok).toBe(false);
  });

  it('the company permission does not grant deal-scoped inviting', async () => {
    const ok = await userCanInvite(
      makeAdmin({
        users: [grantedMember, { data: { firm_role: null }, error: null }, notDirector],
        deal_memberships: [
          { data: null, error: null },
          { data: null, error: null },
        ],
        deals: { data: { bank_id: 'other-bank' }, error: null },
      }, { data: true, error: null }),
      'u1',
      { companyId: 'c1', dealId: 'd1' },
    );
    expect(ok).toBe(false);
  });

  it('invites:send never extends to invite management (resend/revoke)', async () => {
    const ok = await userCanManageInvite(makeAdmin({ users: [grantedMember, notDirector] }), 'u1', {
      companyId: 'c1',
      dealId: null,
    });
    expect(ok).toBe(false);
  });
});

/*
 * Read failures at DEPTH (finding 1.2, frozen B10).
 *
 * `userCanInviteChecked` already reported its own failed reads as
 * 'unreadable', but delegated the real decision to nested predicates that
 * discarded their `error` and answered false. A preview built on that renders
 * a complete perimeter with "cannot invite teammates" — confident, specific,
 * and wrong, when the honest answer is that authority could not be read.
 *
 * Each case is asserted twice on purpose. The tri-state is the new behaviour;
 * `userCanInvite` returning false on the SAME stub is the guarantee that
 * enforcement did not move, which is the part that would be a security
 * regression if it did.
 */
const readFailed = { data: null, error: { message: 'connection reset' } };
const dealMdProfile = { data: { firm_role: null, tenant_id: 't1' }, error: null };

describe('unreadable authority at depth', () => {
  // Deal-authority path: users(actor) -> userIsDealMdChecked{ users, deal_memberships }
  function dealPathAdmin() {
    return makeAdmin({
      users: [internalStaff, dealMdProfile],
      deal_memberships: [readFailed],
    });
  }

  it('reports unreadable when the deal-authority read fails', async () => {
    expect(await userCanInviteChecked(dealPathAdmin(), 'u1', { companyId: 'c1', dealId: 'd1' })).toBe(
      'unreadable',
    );
  });

  it('still denies for enforcement when the deal-authority read fails', async () => {
    expect(await userCanInvite(dealPathAdmin(), 'u1', { companyId: 'c1', dealId: 'd1' })).toBe(false);
  });

  // Company-authority path: users(actor) -> app_has_company_permission RPC.
  function companyPathAdmin() {
    return makeAdmin({ users: internalStaff }, readFailed);
  }

  it('reports unreadable when the company-authority read fails', async () => {
    expect(
      await userCanInviteChecked(companyPathAdmin(), 'u1', { companyId: 'c1', dealId: null }),
    ).toBe('unreadable');
  });

  it('still denies for enforcement when the company-authority read fails', async () => {
    expect(await userCanInvite(companyPathAdmin(), 'u1', { companyId: 'c1', dealId: null })).toBe(
      false,
    );
  });

  // The distinction has to stay a distinction: a real absence is still a
  // confident no, not an outage.
  it('a missing actor is false, not unreadable', async () => {
    expect(
      await userCanInviteChecked(makeAdmin({ users: { data: null, error: null } }), 'u1', {
        companyId: 'c1',
        dealId: null,
      }),
    ).toBe(false);
  });
});
