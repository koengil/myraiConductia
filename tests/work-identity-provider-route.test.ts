import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ flagOn: true, requireApiUser: vi.fn() }));

vi.mock('@/lib/api/v1/requireFlag', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireFlag: vi.fn(async () =>
      mocks.flagOn ? null : NextResponse.json({ error: 'Not found' }, { status: 404 }),
    ),
  };
});
vi.mock('@/lib/api/v1/http', () => ({ requireApiUser: mocks.requireApiUser }));

import { GET } from '@/app/api/v1/work-identity/provider/route';

// The rule itself is SQL (work_identity_connectable_provider, covered by the DB
// probe); this pins that the route asks it about the caller and relays the answer.
function authedWith(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  mocks.requireApiUser.mockResolvedValue({
    ok: true,
    user: { id: 'u1', email: 'a@bank.com', companyId: 'c1' },
    admin: { rpc },
  });
  return rpc;
}

beforeEach(() => {
  mocks.flagOn = true;
  mocks.requireApiUser.mockReset();
});

describe('GET /api/v1/work-identity/provider', () => {
  it('asks the SQL rule about the caller and returns its provider', async () => {
    const rpc = authedWith({ data: 'azure', error: null });
    expect(await (await GET()).json()).toEqual({ provider: 'azure' });
    expect(rpc).toHaveBeenCalledWith('work_identity_connectable_provider', { p_user: 'u1' });
  });

  it('returns null when nothing is connectable', async () => {
    authedWith({ data: null, error: null });
    expect(await (await GET()).json()).toEqual({ provider: null });
  });

  it('answers 500 when the rule cannot be read', async () => {
    authedWith({ data: null, error: { message: 'boom' } });
    expect((await GET()).status).toBe(500);
  });

  it('answers 404 with the flag off, before authenticating', async () => {
    mocks.flagOn = false;
    expect((await GET()).status).toBe(404);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
  });

  it('leaves a user with no firm to the SQL rule', async () => {
    const rpc = authedWith({ data: null, error: null });
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.com', companyId: null }, admin: { rpc } });
    expect(await (await GET()).json()).toEqual({ provider: null });
    expect(rpc).toHaveBeenCalledWith('work_identity_connectable_provider', { p_user: 'u1' });
  });
});
