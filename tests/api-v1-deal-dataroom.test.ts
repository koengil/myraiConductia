import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiUser, classifyInternalUser, userCanAccessDeal, steps } = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  classifyInternalUser: vi.fn(),
  userCanAccessDeal: vi.fn(),
  steps: {
    loadDealByIdOrCode: vi.fn(),
    dealDataroomStatus: vi.fn(),
    provisionDealDataroomOnCreate: vi.fn(),
  },
}));

vi.mock('@/lib/api/v1/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/http')>()),
  requireApiUser,
}));
vi.mock('@/lib/api/v1/access', () => ({ classifyInternalUser, userCanAccessDeal }));
vi.mock('@/lib/dataroom/steps', () => steps);

import { GET, POST } from '@/app/api/v1/deals/[dealId]/dataroom/route';

const admin = { tag: 'admin' };
const context = { params: Promise.resolve({ dealId: 'FALCO-2026-123' }) };
const req = (method: string) => new Request('http://localhost/api/v1/deals/FALCO-2026-123/dataroom', { method });

beforeEach(() => {
  vi.clearAllMocks();
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'md-1', email: 'md@bank.test' }, admin });
  classifyInternalUser.mockResolvedValue('internal');
  userCanAccessDeal.mockResolvedValue(true);
  steps.loadDealByIdOrCode.mockResolvedValue({ id: 'd1', code: 'FALCO-2026-123' });
});

describe('deal data room status and retry (PL-27)', () => {
  it('GET reports a pending data room', async () => {
    steps.dealDataroomStatus.mockResolvedValue('pending');
    const res = await GET(req('GET'), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending' });
  });

  it('POST retries the setup for the resolved deal and answers 200 when it completes', async () => {
    steps.provisionDealDataroomOnCreate.mockResolvedValue('ready');
    const res = await POST(req('POST'), context);
    expect(steps.provisionDealDataroomOnCreate).toHaveBeenCalledWith(admin, 'd1', 'FALCO-2026-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });

  it('POST answers 502 and stays pending when the setup fails again', async () => {
    steps.provisionDealDataroomOnCreate.mockResolvedValue('pending');
    const res = await POST(req('POST'), context);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 'pending' });
  });

  it('refuses an external user before touching Box', async () => {
    classifyInternalUser.mockResolvedValue('external');
    const res = await POST(req('POST'), context);
    expect(res.status).toBe(403);
    expect(steps.provisionDealDataroomOnCreate).not.toHaveBeenCalled();
  });

  it('fails closed when the profile lookup errors', async () => {
    classifyInternalUser.mockResolvedValue('error');
    const res = await GET(req('GET'), context);
    expect(res.status).toBe(500);
    expect(steps.dealDataroomStatus).not.toHaveBeenCalled();
  });

  it('answers a caller with no seat on the deal as if the deal did not exist', async () => {
    userCanAccessDeal.mockResolvedValue(false);
    const res = await POST(req('POST'), context);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(steps.provisionDealDataroomOnCreate).not.toHaveBeenCalled();
  });

  it('answers 404 for a deal that does not exist', async () => {
    steps.loadDealByIdOrCode.mockResolvedValue(null);
    const res = await GET(req('GET'), context);
    expect(res.status).toBe(404);
  });
});
