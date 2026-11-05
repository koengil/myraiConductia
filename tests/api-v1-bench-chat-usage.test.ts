import { beforeEach, describe, expect, it, vi } from 'vitest';

const afterTasks: Promise<unknown>[] = [];
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    afterTasks.push(task());
  },
}));

const recordAiUsage = vi.fn<(admin: unknown, row: Record<string, unknown>) => Promise<{ error: null }>>(async () => ({ error: null }));
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage }));
vi.mock('@/lib/ignatious/jwt', () => ({ mintTriggerToken: () => 'token', benchScopes: () => [] }));

const chat = vi.fn();
vi.mock('@/lib/ignatious/bench', () => ({ createSkillBench: () => ({ chat }) }));

const dealGate = vi.fn();
const companyGate = vi.fn();
vi.mock('@/lib/ignatious/routeContext', () => ({
  requireIgnatiousDealAccess: dealGate,
  requireIgnatiousCompany: companyGate,
  ignatiousErrorResponse: () => new Response('upstream error', { status: 502 }),
}));

const admin = { tag: 'admin' };
const user = { id: 'user-1', email: 'md@bank.test' };
const config = { tenantId: 'ign-tenant', leadIdPrefix: '' };

function sse(frames: unknown[]): Response {
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function post(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

const TURN = [
  { type: 'ready', conversationId: 'conv-1', model: 'anthropic/claude-sonnet-5' },
  { type: 'run', runId: 'run_abc' },
  { type: 'text', text: 'Drafted.' },
  { type: 'done', costUsd: 0.0421, durationMs: 900 },
];

beforeEach(() => {
  afterTasks.length = 0;
  recordAiUsage.mockClear();
  chat.mockReset();
  dealGate.mockResolvedValue({
    ok: true,
    ctx: { admin, user, config, deal: { id: 'deal-uuid', code: 'ZZ-1', tenantId: 'tenant-1' } },
  });
  companyGate.mockResolvedValue({
    ok: true,
    ctx: { admin, user, config, company: { id: 'co-1', name: 'Lead Co', tenantId: 'tenant-1', registeredByCompanyId: null } },
  });
});

describe('POST /deals/{id}/bench/chat — AI spend ledger', () => {
  it('streams the reply through and records the turn once, against the deal, the person and the step', async () => {
    chat.mockResolvedValue(sse(TURN));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x/api/v1/deals/ZZ-1/bench/chat', { message: 'Draft it', stepId: 'p1-s10' }), {
      params: Promise.resolve({ dealId: 'ZZ-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"text":"Drafted."');
    await Promise.all(afterTasks);
    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(recordAiUsage).toHaveBeenCalledWith(admin, {
      tenantId: 'tenant-1',
      dealId: 'deal-uuid',
      actorId: 'user-1',
      source: 'bench_chat',
      task: 'p1-s10',
      externalId: 'run_abc',
      model: 'claude-sonnet-5',
      costUsd: 0.0421,
    });
    // The step id is ours; the bench never sees it.
    expect(chat.mock.calls[0][0]).not.toHaveProperty('stepId');
  });

  it('files the turn under the bench itself when no step, or a malformed one, is named', async () => {
    chat.mockResolvedValue(sse(TURN));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi', stepId: '../../etc' }), { params: Promise.resolve({ dealId: 'ZZ-1' }) });
    await res.text();
    await Promise.all(afterTasks);
    expect(recordAiUsage.mock.calls[0][1]).toMatchObject({ task: 'bench_chat', externalId: 'run_abc' });
  });

  it('records the turn even when the browser stops reading', async () => {
    chat.mockResolvedValue(sse(TURN));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi' }), { params: Promise.resolve({ dealId: 'ZZ-1' }) });
    await res.body?.cancel();
    await Promise.all(afterTasks);
    expect(recordAiUsage).toHaveBeenCalledOnce();
  });

  it('keeps an unpriced turn on the ledger with a null cost', async () => {
    chat.mockResolvedValue(sse([{ type: 'ready', conversationId: 'c' }, { type: 'run', runId: 'run_np' }, { type: 'done', costUsd: null, durationMs: 3 }]));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi' }), { params: Promise.resolve({ dealId: 'ZZ-1' }) });
    await res.text();
    await Promise.all(afterTasks);
    expect(recordAiUsage.mock.calls[0][1]).toMatchObject({ externalId: 'run_np', costUsd: null, model: null });
  });

  it('writes nothing for a turn that failed before finishing', async () => {
    chat.mockResolvedValue(sse([{ type: 'ready', conversationId: 'c' }, { type: 'error', message: 'boom' }]));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi' }), { params: Promise.resolve({ dealId: 'ZZ-1' }) });
    await res.text();
    await Promise.all(afterTasks);
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it('passes an upstream refusal through untouched and records nothing', async () => {
    chat.mockResolvedValue(new Response('{"error":"nope"}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const { POST } = await import('@/app/api/v1/deals/[dealId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi' }), { params: Promise.resolve({ dealId: 'ZZ-1' }) });
    expect(res.status).toBe(503);
    await Promise.all(afterTasks);
    expect(recordAiUsage).not.toHaveBeenCalled();
  });
});

describe('POST /companies/{id}/bench/chat — AI spend ledger', () => {
  it('records a lead-bench turn against the company, with no deal', async () => {
    chat.mockResolvedValue(sse(TURN));
    const { POST } = await import('@/app/api/v1/companies/[companyId]/bench/chat/route');
    const res = await POST(post('http://x', { message: 'Hi', stepId: 'p1-s10' }), { params: Promise.resolve({ companyId: 'co-1' }) });
    await res.text();
    await Promise.all(afterTasks);
    expect(recordAiUsage).toHaveBeenCalledWith(admin, {
      tenantId: 'tenant-1',
      companyId: 'co-1',
      actorId: 'user-1',
      source: 'bench_chat',
      task: 'bench_chat',
      externalId: 'run_abc',
      model: 'claude-sonnet-5',
      costUsd: 0.0421,
    });
  });
});
