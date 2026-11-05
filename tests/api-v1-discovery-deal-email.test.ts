// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ listDealEmail: vi.fn() }));
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));
vi.mock('@/lib/discovery/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery/api')>()),
  ...api,
}));

import { GET } from '@/app/api/v1/discovery/deal-email/route';

const DB = { tag: 'scoped' };
const ITEM = {
  sourceItemId: 'i-1',
  sentDay: '2026-09-18',
  fromDomain: 'northwind-robotics.example',
  sender: null,
  subject: null,
  own: false,
};

const get = (query = '?deal=KESTR-2026-412') => GET(new Request(`http://localhost/api/v1/discovery/deal-email${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: DB });
  api.listDealEmail.mockResolvedValue({ ok: true, items: [ITEM], truncated: false });
});

describe('GET /api/v1/discovery/deal-email', () => {
  it('gates on deal_discovery first: 404 off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await get()).status).toBe(404);
    expect(requireFlagMock).toHaveBeenCalledWith('deal_discovery');
    expect(scopedMock).not.toHaveBeenCalled();
    expect(api.listDealEmail).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through (401) and reads nothing', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await get()).status).toBe(401);
    expect(api.listDealEmail).not.toHaveBeenCalled();
  });

  it('400s a missing, blank or oversized deal code', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?deal=%20')).status).toBe(400);
    expect((await get(`?deal=${'x'.repeat(65)}`)).status).toBe(400);
    expect(api.listDealEmail).not.toHaveBeenCalled();
  });

  it("reads under the caller's own scoped client and returns the items and the cap flag", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [ITEM], truncated: false });
    expect(api.listDealEmail).toHaveBeenCalledWith(DB, 'KESTR-2026-412');
  });

  it('answers an empty list as a 200 (an unseen deal is indistinguishable from no mail)', async () => {
    api.listDealEmail.mockResolvedValue({ ok: true, items: [], truncated: false });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], truncated: false });
  });

  it('500s a failed read with a fixed message', async () => {
    api.listDealEmail.mockResolvedValue({ ok: false });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load the deal email' });
  });
});
