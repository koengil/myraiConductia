import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiUser, requireFlag } = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  requireFlag: vi.fn(),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser,
}));
vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag }));

import { POST } from '@/app/api/v1/mail-warning-outcomes/route';

/*
 * POST /api/v1/mail-warning-outcomes — the composer reports what happened
 * after an email warning (Storm Q5 = B). Anonymous by design: the server
 * resolves the tenant and adds to a daily counter; no person, deal or content
 * is recorded.
 */

function signedIn(profile: { tenant_id: string } | null, rpcError: unknown = null, profileError: unknown = null) {
  const rpc = vi.fn(async () => ({ data: null, error: rpcError }));
  const admin = {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const k of ['select', 'eq']) b[k] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: profile, error: profileError });
      return b;
    },
    rpc,
  };
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'u-1', email: 'md@bank.test' }, admin });
  return rpc;
}

const post = (body: unknown) =>
  POST(new Request('http://x/api/v1/mail-warning-outcomes', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  requireFlag.mockResolvedValue(null);
});

describe('POST /api/v1/mail-warning-outcomes', () => {
  it('adds one to the counter for each reported warning, with the tenant only', async () => {
    const rpc = signedIn({ tenant_id: 'tenant-1' });
    const res = await post({
      outcomes: [
        { kind: 'risk_issues', outcome: 'sent_after_warning' },
        { kind: 'recipient_review', outcome: 'sent_after_warning' },
      ],
    });
    expect(res.status).toBe(204);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('record_mail_warning_outcome', {
      p_tenant_id: 'tenant-1',
      p_kind: 'risk_issues',
      p_outcome: 'sent_after_warning',
    });
    // Nothing that names a person, a deal or the message reaches the counter.
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/u-1|md@bank|deal|subject|body/i);
  });

  it('counts a repeated pair once per report', async () => {
    const rpc = signedIn({ tenant_id: 'tenant-1' });
    await post({
      outcomes: [
        { kind: 'risk_issues', outcome: 'sent_after_warning' },
        { kind: 'risk_issues', outcome: 'sent_after_warning' },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}],
    [{ outcomes: [] }],
    [{ outcomes: [{ kind: 'other', outcome: 'sent_after_warning' }] }],
    [{ outcomes: [{ kind: 'risk_issues', outcome: 'maybe' }] }],
    // D80: an email that was not sent is never recorded.
    [{ outcomes: [{ kind: 'risk_issues', outcome: 'abandoned' }] }],
    [{ outcomes: Array(5).fill({ kind: 'risk_issues', outcome: 'sent_after_warning' }) }],
  ])('rejects an invalid report %j', async (body) => {
    const rpc = signedIn({ tenant_id: 'tenant-1' });
    expect((await post(body)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires the mail flag and a signed-in user', async () => {
    requireFlag.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await post({ outcomes: [{ kind: 'risk_issues', outcome: 'sent_after_warning' }] })).status).toBe(404);
    requireFlag.mockResolvedValue(null);
    requireApiUser.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await post({ outcomes: [{ kind: 'risk_issues', outcome: 'sent_after_warning' }] })).status).toBe(401);
  });

  it('answers 503 when the profile lookup fails, like the other routes', async () => {
    const rpc = signedIn(null, null, { message: 'db down' });
    expect((await post({ outcomes: [{ kind: 'risk_issues', outcome: 'sent_after_warning' }] })).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a user without a profile, and reports a failed write', async () => {
    signedIn(null);
    expect((await post({ outcomes: [{ kind: 'risk_issues', outcome: 'sent_after_warning' }] })).status).toBe(404);
    signedIn({ tenant_id: 'tenant-1' }, { message: 'boom' });
    expect((await post({ outcomes: [{ kind: 'risk_issues', outcome: 'sent_after_warning' }] })).status).toBe(500);
  });
});
