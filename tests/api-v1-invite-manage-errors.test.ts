import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.INVITE_VERIFICATION_PEPPER = 'unit-test-invite-pepper';

// #331 F3: revoke and resend answer a code on an unmapped database failure,
// never the database's own message (PostgREST quotes the input that failed).
vi.mock('@/lib/api/v1/http', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/v1/http')>('@/lib/api/v1/http');
  return { ...actual, requireApiUser: vi.fn() };
});
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanManageInvite: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  deliverInvite: vi.fn(() => Promise.resolve({ deliveryStatus: 'sent' })),
  fetchInviteEmailContext: vi.fn(() =>
    Promise.resolve({ inviterName: 'Storm Duncan', inviterCompanyName: 'Bank', dealCodename: null }),
  ),
}));

import { requireApiUser } from '@/lib/api/v1/http';
import { DELETE } from '@/app/api/v1/invites/[inviteId]/route';
import { POST as RESEND } from '@/app/api/v1/invites/[inviteId]/resend/route';

const INVITE_ID = '10000000-0000-4000-8000-000000000001';
const CANARY_ERROR = {
  code: '22001',
  message: 'value too long for type character varying(200): CANARY-331-F3',
};

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp>, rpc: Resp) {
  const from = (table: string) => {
    const resp = tables[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const k of ['select', 'eq']) builder[k] = () => builder;
    builder.maybeSingle = () => Promise.resolve(resp);
    return builder;
  };
  return { from, rpc: vi.fn(() => Promise.resolve(rpc)) };
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'md-1', email: 'md@bank.dev' },
    admin,
  } as never);
}

const pendingInvite = {
  id: INVITE_ID,
  email: 'a@b.co',
  company_id: 'c1',
  deal_id: null,
  tenant_id: 't1',
  status: 'pending',
  invited_by: 'md-1',
  auth_method: 'email_code',
};

const params = { params: Promise.resolve({ inviteId: INVITE_ID }) };

afterEach(() => vi.clearAllMocks());

describe('#331 F3 invite management error bodies', () => {
  it('DELETE /api/v1/invites/{id}: an unmapped revoke failure answers a code, never the database message', async () => {
    signedIn(makeAdmin({ invites: { data: pendingInvite, error: null } }, { data: null, error: CANARY_ERROR }));
    const res = await DELETE(new Request(`http://localhost/api/v1/invites/${INVITE_ID}`, { method: 'DELETE' }), params);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('CANARY-331-F3');
    expect(text).toContain('22001');
  });

  it('POST /api/v1/invites/{id}/resend: an unmapped rotate failure answers a code, never the database message', async () => {
    signedIn(
      makeAdmin(
        {
          invites: { data: pendingInvite, error: null },
          companies: { data: { type: 'bank' }, error: null },
        },
        { data: null, error: CANARY_ERROR },
      ),
    );
    const res = await RESEND(
      new Request(`http://localhost/api/v1/invites/${INVITE_ID}/resend`, { method: 'POST' }),
      params,
    );
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('CANARY-331-F3');
    expect(text).toContain('22001');
  });
});
