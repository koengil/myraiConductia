import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Criteria A11 and D3: no response introduced by this work exposes a
 * verification code, invitation credential, session token or storage
 * credential.
 *
 * Error responses are checked as well as success responses. An error path is
 * where a raw database message is most likely to be handed straight back, and
 * this repository already has one such catch-all, so the assertion has to cover
 * the failure branch or it is checking the easy half.
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

/** Anything that would be a credential if it escaped. */
const SECRET_SHAPES = [
  /credential/i,
  /nonce/i,
  /verification_?code/i,
  /challenge/i,
  /digest/i,
  /service_role/i,
  /\btoken\b/i,
  /password/i,
  /storage_file_id/i,
  /signed_?url/i,
];

type Resp = { data: unknown; error: unknown };

function admin(tables: Record<string, Resp>) {
  const from = (table: string) => {
    const resp = tables[table] ?? { data: null, error: null };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const term = () => Promise.resolve(resp);
    b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain;
    b.single = term; b.maybeSingle = term;
    b.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return b;
  };
  const rpc = () => Promise.resolve({ data: true, error: null });
  return { from, rpc };
}

function signedIn(tables: Record<string, Resp>) {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'md-1' },
    admin: admin(tables),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function post(url: string, body: unknown) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

function expectNoSecrets(label: string, serialized: string) {
  for (const shape of SECRET_SHAPES) {
    expect(shape.test(serialized), `${label} leaked ${shape}`).toBe(false);
  }
}

afterEach(() => vi.clearAllMocks());

describe('no onboarding response carries a secret (A11, D3)', () => {
  it('lookup success carries none', async () => {
    signedIn({
      users: { data: { tenant_id: 't1', firm_role: null, is_external: false, company_id: 'bank-1', company_role: 'director' }, error: null },
      company_verified_domains: { data: [{ company_id: 'bank-1', domain: 'bank.dev' }], error: null },
      companies: { data: { id: 'bank-1', name: 'Advisory Bank', type: 'bank' }, error: null },
      invites: { data: null, error: null },
    });

    const res = await lookup(post('http://localhost/api/v1/invites/lookup', { email: 'alex@bank.dev' }));
    expectNoSecrets('lookup success', JSON.stringify(await res.json()));
  });

  it('lookup failure carries none, and no raw database text', async () => {
    signedIn({ users: { data: null, error: { message: 'permission denied for relation users, key=sk_live_x' } } });

    const res = await lookup(post('http://localhost/api/v1/invites/lookup', { email: 'alex@bank.dev' }));
    const serialized = JSON.stringify(await res.json());

    expect(res.status).toBe(503);
    expectNoSecrets('lookup failure', serialized);
    expect(serialized).not.toMatch(/permission denied|sk_live/);
  });

  it('preview failure carries none', async () => {
    signedIn({ users: { data: null, error: { message: 'connection reset, token=abc' } } });

    const res = await preview(
      post('http://localhost/api/v1/invites/perimeter-preview', {
        proposal: { email: 'alex@target.dev', companyId: 'seller-1', companyRole: 'member', dealId: 'PROJECT-X', dealRole: 'seller', phase: 1 },
      }),
    );
    const serialized = JSON.stringify(await res.json());

    expectNoSecrets('preview failure', serialized);
    expect(serialized).not.toMatch(/connection reset|abc/);
  });
});
