import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { requireApiUser } = vi.hoisted(() => ({ requireApiUser: vi.fn() }));

vi.mock('@/lib/api/v1/http', () => ({ requireApiUser }));

import { POST } from '@/app/api/v1/auth/mfa/complete/route';

const insert = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
  requireApiUser.mockResolvedValue({
    ok: true,
    user: { id: 'user-1', email: 'md@example.com' },
    admin: { from: vi.fn(() => ({ insert })) },
  });
});

function request(body: unknown) {
  return new Request('http://localhost/api/v1/auth/mfa/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/auth/mfa/complete', () => {
  it.each(['mfa_enrolled', 'mfa_challenged'])('records the non-secret %s outcome', async (event) => {
    const response = await POST(request({ event }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(requireApiUser).toHaveBeenCalledWith({ allowInvited: true, forceAal2: true });
    expect(insert).toHaveBeenCalledWith({
      actor_id: 'user-1',
      action: event,
      detail: { outcome: 'success', target_user_id: 'user-1' },
    });
    const recorded = JSON.stringify(insert.mock.calls[0]?.[0]);
    expect(recorded).not.toMatch(/factor|code|qr|secret/i);
  });

  it('rejects unsupported events without writing an audit row', async () => {
    const response = await POST(request({ event: 'mfa_bypassed', code: '123456' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_mfa_event' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('surfaces an audit write failure for client retry', async () => {
    insert.mockResolvedValue({ error: { message: 'database unavailable' } });
    const response = await POST(request({ event: 'mfa_challenged' }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'audit_failed' });
  });

  it('preserves the AAL2 boundary response', async () => {
    requireApiUser.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'mfa_required' }, { status: 403 }),
    });
    const response = await POST(request({ event: 'mfa_challenged' }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'mfa_required' });
    expect(insert).not.toHaveBeenCalled();
  });
});
