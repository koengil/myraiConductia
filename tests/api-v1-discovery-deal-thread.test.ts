// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ readDealThread: vi.fn() }));
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));
vi.mock('@/lib/discovery/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery/api')>()),
  ...api,
}));

import { GET } from '@/app/api/v1/discovery/deal-email/thread/route';
import { verifyReplyToken } from '@/lib/email/replyToken';

const DB = { tag: 'scoped' };
const ITEM = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const THREAD = {
  conversationId: 'rfc822:<root@northwind.example>',
  messages: [
    {
      sourceItemId: ITEM,
      sentAt: '2026-09-18T15:00:00Z',
      from: { address: 'mike@northwind.example', name: 'Mike Cannon' },
      to: [],
      cc: [],
      subject: 'Project Kestrel',
      body: 'We signed the LOI.',
      internetMessageId: '<a@northwind.example>',
      fromSelf: false,
    },
  ],
};

const get = (query = `?deal=KESTR-2026-412&item=${ITEM}`) =>
  GET(new Request(`http://localhost/api/v1/discovery/deal-email/thread${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm', email: 'storm@bank.example' }, db: DB });
  api.readDealThread.mockResolvedValue({ ok: true, thread: THREAD, participants: ['mike@northwind.example', 'storm@bank.example'] });
});

describe('GET /api/v1/discovery/deal-email/thread', () => {
  it('gates on deal_discovery first: 404 off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await get()).status).toBe(404);
    expect(requireFlagMock).toHaveBeenCalledWith('deal_discovery');
    expect(scopedMock).not.toHaveBeenCalled();
    expect(api.readDealThread).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through (401) and reads nothing', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await get()).status).toBe(401);
    expect(api.readDealThread).not.toHaveBeenCalled();
  });

  it('400s a missing or oversized deal code, and an item that is not a uuid', async () => {
    expect((await get(`?item=${ITEM}`)).status).toBe(400);
    expect((await get(`?deal=${'x'.repeat(65)}&item=${ITEM}`)).status).toBe(400);
    expect((await get('?deal=KESTR-2026-412')).status).toBe(400);
    expect((await get('?deal=KESTR-2026-412&item=i-1')).status).toBe(400);
    expect(api.readDealThread).not.toHaveBeenCalled();
  });

  it("reads under the caller's own scoped client and returns the thread with a reply token for the newest message", async () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    const res = await get();
    expect(res.status).toBe(200);
    expect(api.readDealThread).toHaveBeenCalledWith(DB, 'KESTR-2026-412', ITEM, ['storm@bank.example']);
    const body = await res.json();
    expect(body).toEqual({ ...THREAD, replyToken: expect.any(String) });
    expect(verifyReplyToken(body.replyToken, { actorId: 'u-storm', dealCode: 'KESTR-2026-412' })).toMatchObject({
      sourceItemId: ITEM,
      inReplyTo: '<a@northwind.example>',
      references: ['<root@northwind.example>', '<a@northwind.example>'],
      // The thread's addresses: a reply to anyone else goes out unthreaded.
      participants: ['mike@northwind.example', 'storm@bank.example'],
    });
    vi.unstubAllEnvs();
  });

  it('issues no reply token when the newest message has no usable Message-ID', async () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    api.readDealThread.mockResolvedValue({
      ok: true,
      thread: { ...THREAD, messages: [{ ...THREAD.messages[0], internetMessageId: null }] },
    });
    expect((await (await get()).json()).replyToken).toBeNull();
    vi.unstubAllEnvs();
  });

  it('answers one 404 when there is no thread the caller may read', async () => {
    api.readDealThread.mockResolvedValue({ ok: true, thread: null });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('500s a failed read with a fixed message', async () => {
    api.readDealThread.mockResolvedValue({ ok: false });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load the thread' });
  });
});
