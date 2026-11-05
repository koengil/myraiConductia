import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));
vi.mock('@/lib/api/v1/access', () => ({ userCanInvite: vi.fn(async () => true),
  userCanInviteChecked: vi.fn(async () => true),
  userCanAccessDeal: vi.fn(async () => true) }));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: vi.fn(),
    resolveDealRef: vi.fn(async (_admin, dealId: string) => ({ id: dealId, code: 'PRJ' })),
  };
});
import { requireApiUser } from '@/lib/api/v1/http';
import { userCanAccessDeal, userCanInvite, userCanInviteChecked } from '@/lib/api/v1/access';
import { POST } from '@/app/api/v1/invites/preflight/route';

afterEach(() => vi.clearAllMocks());

function request(body: unknown) {
  return new Request('http://localhost/api/v1/invites/preflight', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function adminWithDomains(domains: string[]) {
  const insert = vi.fn();
  const from = vi.fn((table: string) => {
    const response =
      table === 'companies'
        ? { data: { id: 'c1' }, error: null }
        : table === 'company_verified_domains'
          ? { data: domains.map((domain) => ({ domain })), error: null }
          : {
              data: { id: 'confirm-1', expires_at: '2026-08-04T17:00:00Z' },
              error: null,
            };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.order = chain;
    builder.insert = (value: unknown) => {
      insert(value);
      return builder;
    };
    builder.maybeSingle = async () => response;
    builder.single = async () => response;
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve);
    return builder;
  });
  return { admin: { from }, insert, from };
}

describe('POST /api/v1/invites/preflight', () => {
  it('permits exact/subdomain matches without returning configured domains', async () => {
    const { admin, insert } = adminWithDomains(['bank.example']);
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1' },
      admin,
    } as never);
    const res = await POST(
      request({
        email: 'Person@EMEA.Bank.Example',
        companyId: 'c1',
        companyRole: 'member',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      normalizedEmail: 'person@emea.bank.example',
      classification: 'match',
      confirmationRequired: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('binds a mismatch confirmation to actor, target, deal, and roles', async () => {
    const { admin, insert } = adminWithDomains(['bank.example']);
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1' },
      admin,
    } as never);
    const res = await POST(
      request({
        email: 'person@other.example',
        companyId: 'c1',
        companyRole: 'director',
        dealId: 'd1',
        dealRole: 'seller',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      normalizedEmail: 'person@other.example',
      classification: 'mismatch',
      confirmationRequired: true,
      confirmationId: 'confirm-1',
    });
    expect(insert).toHaveBeenCalledWith({
      actor_id: 'actor-1',
      email: 'person@other.example',
      company_id: 'c1',
      company_role: 'director',
      deal_id: 'd1',
      deal_role: 'seller',
      classification: 'mismatch',
    });
  });

  describe('a deal the caller cannot see (D65)', () => {
    const onDeal = {
      email: 'person@other.example',
      companyId: 'c1',
      companyRole: 'member',
      dealId: 'd1',
      dealRole: 'seller',
    };

    it('answers exactly like a missing deal, before any company or domain read', async () => {
      const { admin, from } = adminWithDomains(['bank.example']);
      vi.mocked(requireApiUser).mockResolvedValue({ ok: true, user: { id: 'actor-1' }, admin } as never);
      vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
      vi.mocked(userCanInviteChecked).mockResolvedValueOnce(false);

      const res = await POST(request(onDeal));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Deal not found' });
      expect(from).not.toHaveBeenCalled();
    });

    it('keeps the role 403 for a caller who can see the deal but may not invite', async () => {
      const { admin } = adminWithDomains(['bank.example']);
      vi.mocked(requireApiUser).mockResolvedValue({ ok: true, user: { id: 'actor-1' }, admin } as never);
      vi.mocked(userCanInvite).mockResolvedValueOnce(false);

      const res = await POST(request(onDeal));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    });
  });
});
