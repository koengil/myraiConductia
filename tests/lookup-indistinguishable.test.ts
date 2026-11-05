// Criterion A19 — an unauthorized actor cannot tell "exists but hidden from
// you" from "nobody has ever seen this address".
//
// The comparison has to be the SAME normalized request run against two worlds
// that differ ONLY in the hidden fact. Comparing two different addresses would
// prove nothing: normalizedEmail and every domain-derived field differ anyway,
// so the responses could never match and the test would be measuring the wrong
// thing.
//
// Each case therefore fixes the request and varies one row, then asserts the
// serialized responses are byte-identical. The positive control at the end
// varies the SAME row in a way that IS disclosable, and asserts the responses
// differ — without it, an assertion that two responses match could pass simply
// because the route always returns the same thing.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return { ...actual, requireApiUser: vi.fn(), resolveDealRef: vi.fn() };
});

import { POST } from '@/app/api/v1/invites/lookup/route';
import { requireApiUser, resolveDealRef } from '@/lib/api/v1/http';

type Resp = { data: unknown; error: { message: string } | null };

/** Per-table responses; an array is consumed in call order. */
function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const queues: Record<string, Resp[]> = {};
  for (const [table, entry] of Object.entries(tables)) {
    queues[table] = Array.isArray(entry) ? [...entry] : [entry];
  }
  // Every read records the table it hit and the columns it filtered on. Table
  // names alone cannot see a predicate that skips a query on one input and
  // runs it on another, which is the thing A19 is actually about.
  const schedule: string[] = [];
  const from = vi.fn((table: string) => {
    const queue = queues[table] ?? [];
    const resp: Resp = queue.length > 1 ? queue.shift()! : (queue[0] ?? { data: null, error: null });
    const filters: string[] = [];
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const record = () => {
      schedule.push(`${table}(${filters.join(',')})`);
      return Promise.resolve(resp);
    };
    builder.select = chain;
    builder.eq = (column: string) => {
      filters.push(column);
      return builder;
    };
    builder.in = (column: string) => {
      filters.push(column);
      return builder;
    };
    builder.single = record;
    builder.maybeSingle = record;
    builder.then = (onFulfilled: (v: Resp) => unknown) => record().then(onFulfilled);
    return builder;
  });
  const rpc = vi.fn((name: string) => {
    schedule.push(`rpc(${name})`);
    return Promise.resolve({ data: true, error: null });
  });
  return { from, rpc, schedule };
}

/** An ordinary internal director at the advisory bank. No firm-wide oversight. */
const ACTOR: Resp = {
  data: {
    tenant_id: 'tenant-1',
    firm_role: null,
    is_external: false,
    company_id: 'bank-1',
    company_role: 'director',
  },
  error: null,
};

const NO_ROW: Resp = { data: null, error: null };

function worldWhere(existingUser: Resp) {
  return makeAdmin({
    users: [ACTOR, existingUser, ACTOR],
    companies: { data: { id: 'bank-1', name: 'Advisory Bank', type: 'bank' }, error: null },
    company_verified_domains: { data: [{ company_id: 'bank-1', domain: 'bank.dev' }], error: null },
    invites: NO_ROW,
  });
}

async function lookup(admin: ReturnType<typeof makeAdmin>, dealId?: string) {
  // Unstubbed this returns undefined and the route 404s before reaching
  // anything worth measuring, which makes a schedule comparison vacuous.
  vi.mocked(resolveDealRef).mockResolvedValue({ id: 'deal-1', code: 'PROJECT-X' } as never);
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'dir-1', email: 'dir@bank.dev' },
    admin,
  } as never);

  const res = await POST(
    new Request('http://test/api/v1/invites/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // One fixed request. Only the world changes.
      body: JSON.stringify({ email: 'Alex@Target.Example', dealId }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

afterEach(() => vi.clearAllMocks());

describe('lookup — a fact outside the actor’s scope leaves no trace', () => {
  it('answers identically whether an out-of-scope user exists or not', async () => {
    // Same tenant, DIFFERENT company, and the actor is not an overseer and has
    // no deal in context — so A17 permits nothing.
    const exists = await lookup(
      worldWhere({
        data: { id: 'u-9', company_id: 'other-co', tenant_id: 'tenant-1' },
        error: null,
      }),
    );
    const absent = await lookup(worldWhere(NO_ROW));

    expect(exists.status).toBe(absent.status);
    expect(JSON.stringify(exists.body)).toBe(JSON.stringify(absent.body));
  });

  it('answers identically for a user in another tenant', async () => {
    // Cross-tenant reach is closed even for the branches that would otherwise
    // disclose, so this must be indistinguishable too.
    const exists = await lookup(
      worldWhere({
        data: { id: 'u-9', company_id: 'bank-1', tenant_id: 'tenant-2' },
        error: null,
      }),
    );
    const absent = await lookup(worldWhere(NO_ROW));

    expect(JSON.stringify(exists.body)).toBe(JSON.stringify(absent.body));
  });

  it('carries no per-check status map, count, or ordering that could betray a suppressed fact', async () => {
    const { body } = await lookup(
      worldWhere({
        data: { id: 'u-9', company_id: 'other-co', tenant_id: 'tenant-1' },
        error: null,
      }),
    );

    // The shape itself is the guarantee: a flat array of ids. A field like
    // `checks: { existingUser: 'not_permitted' }` would honour the scoping rule
    // in letter and defeat it completely.
    expect(Object.keys(body).sort()).toEqual([
      'companyMatch',
      'companyRolePolicy',
      'domain',
      'normalizedEmail',
      'proposedCompany',
      'recommendation',
      'warnings',
    ]);
    expect(Array.isArray(body.warnings)).toBe(true);
    for (const warning of body.warnings) {
      expect(Object.keys(warning)).toEqual(['id']);
    }
    expect(JSON.stringify(body)).not.toMatch(/not_permitted|suppressed|hidden|withheld|u-9|other-co/);
  });
});

describe('lookup — the control: a fact INSIDE scope does show', () => {
  it('discloses an existing user at the actor’s own company', async () => {
    // Without this, "the two responses matched" could mean the route simply
    // never says anything.
    const inScope = await lookup(
      worldWhere({ data: { id: 'u-9', company_id: 'bank-1', tenant_id: 'tenant-1' }, error: null }),
    );
    const absent = await lookup(worldWhere(NO_ROW));

    expect(inScope.body.warnings).toContainEqual({ id: 'existing_platform_user' });
    expect(JSON.stringify(inScope.body)).not.toBe(JSON.stringify(absent.body));
  });
});

/**
 * The other two hidden-fact classes.
 *
 * A19 names three: an existing user, an existing deal seat, and a pending
 * invitation. Proving it for users only would leave the other two free to leak
 * through exactly the same channel.
 */
describe('A19 — hidden seats and hidden invitations are equally indistinguishable', () => {
  const OUTSIDER: Resp = {
    data: { id: 'u-9', company_id: 'other-co', tenant_id: 'tenant-1' },
    error: null,
  };

  /** The actor's own seat, read by the deal-visibility gate (D65). */
  const ACTOR_SEAT: Resp = { data: { id: 'seat-dir-1' }, error: null };

  /**
   * With a deal in context the invite family's visibility gate runs first. Its
   * reads (the actor's profile and seat, the deal's tenant) depend only on the
   * actor and the deal, never on the typed address, so they are queued ahead of
   * the route's own reads and are identical in every world.
   */
  function worldWithSeat(seat: Resp, invite: Resp, existingUser: Resp, onDeal = false) {
    return makeAdmin({
      users: onDeal ? [ACTOR, ACTOR, existingUser, ACTOR] : [ACTOR, existingUser, ACTOR],
      companies: { data: { id: 'bank-1', name: 'Advisory Bank', type: 'bank' }, error: null },
      company_verified_domains: {
        data: [{ company_id: 'bank-1', domain: 'bank.dev' }],
        error: null,
      },
      deal_memberships: onDeal ? [ACTOR_SEAT, seat] : seat,
      deals: { data: { id: 'deal-1', bank_id: 'bank-1', tenant_id: 'tenant-1' }, error: null },
      deal_parties: NO_ROW,
      invites: invite,
    });
  }

  it('a seat the actor may not see is indistinguishable from no seat', async () => {
    const hidden = await lookup(
      worldWithSeat({ data: { user_id: 'u-9' }, error: null }, NO_ROW, OUTSIDER),
    );
    const absent = await lookup(worldWithSeat(NO_ROW, NO_ROW, OUTSIDER));

    expect(hidden.status).toBe(absent.status);
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(absent.body));
  });

  it('a pending invitation the actor may not manage is indistinguishable from none', async () => {
    const pending: Resp = {
      data: { id: 'inv-9', company_id: 'other-co', deal_id: null },
      error: null,
    };
    const hidden = await lookup(worldWithSeat(NO_ROW, pending, OUTSIDER));
    const absent = await lookup(worldWithSeat(NO_ROW, NO_ROW, OUTSIDER));

    expect(hidden.status).toBe(absent.status);
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(absent.body));
  });

  it('runs the same query schedule whether or not a hidden user or seat exists', async () => {
    // The response can be identical while the WORK is not, and work is
    // observable. This pins the two classes this route controls: an existing
    // user and an existing seat cost exactly what their absence costs.
    const withRows = worldWithSeat({ data: { user_id: 'u-9' }, error: null }, NO_ROW, OUTSIDER, true);
    const withoutRows = worldWithSeat(NO_ROW, NO_ROW, { data: null, error: null }, true);

    // With a deal in context, so the membership read is actually on the
    // schedule. Without one it never runs and the comparison proves less.
    expect((await lookup(withRows, 'PROJECT-X')).status).toBe(200);
    expect((await lookup(withoutRows, 'PROJECT-X')).status).toBe(200);

    const tables = (admin: ReturnType<typeof makeAdmin>) =>
      vi.mocked(admin.from).mock.calls.map(([t]) => t);
    expect(tables(withRows)).toEqual(tables(withoutRows));
    // The gate ran (its reads lead the schedule) and passed the actor through,
    // so the comparison covers the route's own reads too, not a 404.
    expect(withRows.schedule.slice(0, 3)).toEqual([
      'users(id)',
      'deal_memberships(deal_id,user_id)',
      'deals(id)',
    ]);
    expect(withRows.schedule).toEqual(withoutRows.schedule);
  });

  it('runs the same query schedule whether or not a hidden invitation exists', async () => {
    // The third class, and the one this route controls least directly: the
    // authority predicate is handed the hidden row's own company and deal, so
    // if it decided anything before finishing its reads, the shape of the
    // invitation would be legible in the work even when the bytes match.
    //
    // Three worlds, one request. No invitation at all; an invitation attached
    // to nothing; an invitation attached to a deal. The recorded schedule
    // carries filter columns, so a read that is skipped on one input and run
    // on another shows up here as a shorter list.
    const none = worldWithSeat(NO_ROW, NO_ROW, OUTSIDER);
    const companyScoped = worldWithSeat(
      NO_ROW,
      { data: { id: 'inv-9', company_id: 'other-co', deal_id: null }, error: null },
      OUTSIDER,
    );
    const dealScoped = worldWithSeat(
      NO_ROW,
      { data: { id: 'inv-9', company_id: 'other-co', deal_id: 'deal-9' }, error: null },
      OUTSIDER,
    );

    const a = await lookup(none);
    const b = await lookup(companyScoped);
    const c = await lookup(dealScoped);

    expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    expect(JSON.stringify(c.body)).toBe(JSON.stringify(a.body));

    expect(companyScoped.schedule).toEqual(none.schedule);
    expect(dealScoped.schedule).toEqual(none.schedule);

    // The comparison is only worth something if the authority reads are on the
    // schedule at all. Naming them also pins WHICH reads must stay constant.
    expect(none.schedule).toEqual(
      expect.arrayContaining([
        'users(id)',
        'companies(id)',
        'deals(id)',
        'deal_memberships(deal_id,user_id)',
      ]),
    );
  });
});
