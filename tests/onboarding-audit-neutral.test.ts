import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Criteria B9 and D4: previewing is a read. It creates no membership, no
 * invitation, no grant and no document-view audit event, and the events that
 * already existed keep their meaning.
 *
 * The structural guarantee is that computePerimeterInternal is pure and does no
 * IO, so it cannot write an audit row. This file holds the behavioural evidence
 * for the surrounding routes, which do touch the database.
 */
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));
vi.mock('@/lib/api/v1/access', () => ({
  // The invite family's deal-visibility gate (D65): the caller can see the deal.
  userCanAccessDeal: vi.fn(async () => true),
  userCanInvite: vi.fn(async () => true),
  userCanInviteChecked: vi.fn(async () => true),
  canManageCompanyMembers: vi.fn(async () => true),
  canManageDealMembers: vi.fn(async () => true),
  userIsDealMd: vi.fn(async () => true),
  userCanManageInvite: vi.fn(async () => true),
}));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: vi.fn(),
    resolveDealRef: vi.fn(async () => ({ id: 'deal-1', code: 'PROJECT-X' })),
  };
});

import { requireApiUser } from '@/lib/api/v1/http';
import { POST as lookup } from '@/app/api/v1/invites/lookup/route';
import { POST as preview } from '@/app/api/v1/invites/perimeter-preview/route';

type Resp = { data: unknown; error: unknown };

const WRITES = ['insert', 'update', 'upsert', 'delete'] as const;

function trackingAdmin(tables: Record<string, Resp>) {
  const touched: string[] = [];
  const writes: string[] = [];
  const from = (table: string) => {
    touched.push(table);
    const resp = tables[table] ?? { data: null, error: null };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const term = () => Promise.resolve(resp);
    b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain;
    for (const w of WRITES) {
      b[w] = () => {
        writes.push(`${table}.${w}`);
        return b;
      };
    }
    b.single = term; b.maybeSingle = term;
    b.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return b;
  };
  const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return { client: { from, rpc }, touched, writes, rpc };
}

function post(url: string, body: unknown) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

const VIEWER_TABLES: Record<string, Resp> = {
  users: { data: { tenant_id: 't1', firm_role: null, is_external: true, company_id: 'seller-1', company_role: 'director', deal_role: 'seller', phase: 2 }, error: null },
  companies: { data: { id: 'seller-1', name: 'Target Co', type: 'target' }, error: null },
  company_verified_domains: { data: [{ company_id: 'seller-1', domain: 'target.dev' }], error: null },
  deals: { data: { id: 'deal-1', tenant_id: 't1', bank_id: 'bank-1' }, error: null },
  deal_parties: { data: { party_role: 'target' }, error: null },
  deal_memberships: { data: { deal_role: 'seller', phase: 2 }, error: null },
  documents: { data: [{ room: 'deal', classification: 2, min_phase: 0 }], error: null },
  invites: { data: null, error: null },
};

afterEach(() => vi.clearAllMocks());

describe('previewing and looking up write nothing (B9, D4)', () => {
  it('the perimeter preview performs no write and no RPC', async () => {
    const { client, touched, writes, rpc } = trackingAdmin(VIEWER_TABLES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(requireApiUser).mockResolvedValue({ ok: true, user: { id: 'md-1' }, admin: client } as any);

    const res = await preview(
      post('http://localhost/api/v1/invites/perimeter-preview', {
        member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 3 },
      }),
    );

    expect(res.status).toBe(200);
    expect(writes).toEqual([]);
    expect(touched).not.toContain('audit_log');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lookup performs no write and never touches the audit log', async () => {
    const { client, touched, writes, rpc } = trackingAdmin(VIEWER_TABLES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(requireApiUser).mockResolvedValue({ ok: true, user: { id: 'md-1' }, admin: client } as any);

    await lookup(post('http://localhost/api/v1/invites/lookup', { email: 'alex@target.dev', dealId: 'PROJECT-X' }));

    expect(writes).toEqual([]);
    expect(touched).not.toContain('audit_log');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a proposal preview writes nothing either', async () => {
    const { client, writes, touched } = trackingAdmin(VIEWER_TABLES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(requireApiUser).mockResolvedValue({ ok: true, user: { id: 'md-1' }, admin: client } as any);

    await preview(
      post('http://localhost/api/v1/invites/perimeter-preview', {
        proposal: { email: 'alex@target.dev', companyId: 'seller-1', companyRole: 'member', dealId: 'PROJECT-X', dealRole: 'seller', phase: 2 },
      }),
    );

    expect(writes).toEqual([]);
    expect(touched).not.toContain('audit_log');
  });
});
