import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TWIN_CHAT_HISTORY_MAX_CHARS,
  TWIN_CHAT_HISTORY_MAX_MESSAGES,
  trimTwinChatHistory,
} from '@/lib/ignatious/twinChat';

const ledger = vi.hoisted(() => ({ afterTasks: [] as (() => unknown)[], rows: [] as unknown[] }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => unknown) => {
    ledger.afterTasks.push(task);
  },
}));
vi.mock('@/lib/ai/usage', () => ({
  recordAiUsage: async (_admin: unknown, row: unknown) => {
    ledger.rows.push(row);
    return { error: null };
  },
}));

vi.mock('@/lib/ignatious/jwt', () => ({ mintTriggerToken: () => 'token', digitalTwinScopes: () => [] }));

const companyGate = vi.fn();
vi.mock('@/lib/ignatious/routeContext', () => ({
  requireIgnatiousCompany: companyGate,
  ignatiousErrorResponse: () => new Response('upstream error', { status: 502 }),
}));

const getPersona = vi.fn();
vi.mock('@/lib/conductia/personas', () => ({ getPersona }));

const postTwinMessage = vi.fn();
const admin = { tag: 'admin' };

function twin(leadIds: string[]) {
  return {
    personaId: 'p-1',
    linkedContacts: leadIds.map((leadId) => ({ tenantId: 'tenant-1', leadId, contactId: 'c-1' })),
  };
}

async function send(body: unknown) {
  const { POST } = await import('@/app/api/v1/companies/[companyId]/twins/[personaId]/chat/route');
  return POST(
    new Request('http://x/api/v1/companies/co-1/twins/p-1/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ companyId: 'co-1', personaId: 'p-1' }) },
  );
}

async function runAfterTasks() {
  for (const task of ledger.afterTasks.splice(0)) await task();
}

beforeEach(() => {
  ledger.afterTasks.length = 0;
  ledger.rows.length = 0;
  getPersona.mockReset();
  postTwinMessage.mockReset();
  postTwinMessage.mockResolvedValue({ reply: 'Hello.' });
  companyGate.mockResolvedValue({
    ok: true,
    ctx: {
      admin,
      user: { id: 'user-1', email: 'md@bank.test' },
      config: { tenantId: 'ign-tenant' },
      company: { id: 'co-1', name: 'Lead Co', tenantId: 'tenant-1', registeredByCompanyId: null },
      plane: { postTwinMessage },
    },
  });
});

describe('POST /companies/{id}/twins/{personaId}/chat', () => {
  it('talks to a twin of this company, loaded within its firm', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    const res = await send({ message: 'Hi', history: [{ role: 'user', content: 'Earlier' }] });
    expect(res.status).toBe(200);
    expect(getPersona).toHaveBeenCalledWith(admin, 'ign-tenant', 'tenant-1', 'p-1');
    expect(postTwinMessage).toHaveBeenCalledOnce();
  });

  it('answers 404 for a twin of another company', async () => {
    getPersona.mockResolvedValue(twin(['co-2']));
    const res = await send({ message: 'Hi' });
    expect(res.status).toBe(404);
    expect(postTwinMessage).not.toHaveBeenCalled();
  });

  it('answers 404 for a twin outside the firm', async () => {
    getPersona.mockResolvedValue(null);
    const res = await send({ message: 'Hi' });
    expect(res.status).toBe(404);
    expect(postTwinMessage).not.toHaveBeenCalled();
  });

  it('refuses a history over the turn cap', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    const history = Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' }));
    const res = await send({ message: 'Hi', history });
    expect(res.status).toBe(400);
    expect(postTwinMessage).not.toHaveBeenCalled();
  });

  it('refuses a history over the character budget', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    const history = [{ role: 'user', content: 'x'.repeat(50_001) }];
    const res = await send({ message: 'Hi', history });
    expect(res.status).toBe(400);
    expect(postTwinMessage).not.toHaveBeenCalled();
  });

  it('accepts a history exactly at both limits', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    const history = Array.from({ length: 50 }, () => ({ role: 'user', content: 'x'.repeat(1_000) }));
    const res = await send({ message: 'Hi', history });
    expect(res.status).toBe(200);
    expect(postTwinMessage).toHaveBeenCalledOnce();
  });

  it('caps the message at the same character budget', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    expect((await send({ message: 'x'.repeat(50_000) })).status).toBe(200);
    expect((await send({ message: 'x'.repeat(50_001) })).status).toBe(400);
    expect(postTwinMessage).toHaveBeenCalledOnce();
  });

  it('records the turn on the AI cost ledger, under the bare model id', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    postTwinMessage.mockResolvedValue({ reply: 'Hello.', modelId: 'anthropic/claude-sonnet-5', costUsd: 0.0123 });
    const res = await send({ message: 'Hi' });
    expect(res.status).toBe(200);
    await runAfterTasks();
    expect(ledger.rows).toEqual([
      {
        tenantId: 'tenant-1',
        companyId: 'co-1',
        actorId: 'user-1',
        source: 'twin_chat',
        task: 'twin_chat',
        externalId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        model: 'claude-sonnet-5',
        costUsd: 0.0123,
      },
    ]);
  });

  it('writes one row per turn, and a null cost when the reply carries none', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    await send({ message: 'Hi' });
    await send({ message: 'Again' });
    await runAfterTasks();
    expect(ledger.rows).toHaveLength(2);
    const [first, second] = ledger.rows as { externalId: string; model: unknown; costUsd: unknown }[];
    expect(first.externalId).not.toBe(second.externalId);
    expect(first).toMatchObject({ model: null, costUsd: null });
  });

  it('writes nothing when the twin call fails or the request is refused', async () => {
    getPersona.mockResolvedValue(twin(['co-1']));
    postTwinMessage.mockRejectedValue(new Error('down'));
    expect((await send({ message: 'Hi' })).status).toBe(502);
    getPersona.mockResolvedValue(twin(['co-2']));
    expect((await send({ message: 'Hi' })).status).toBe(404);
    await runAfterTasks();
    expect(ledger.rows).toEqual([]);
  });

  it('answers 404 for a missing twin before any size check', async () => {
    getPersona.mockResolvedValue(null);
    const history = Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' }));
    const res = await send({ message: 'x'.repeat(50_001), history });
    expect(res.status).toBe(404);
  });
});

describe('chatLeadTwin', () => {
  it('sends the trimmed history', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ reply: 'ok' }), { status: 200 }));
    const { chatLeadTwin } = await import('@/lib/ignatious/client');
    const history = Array.from({ length: TWIN_CHAT_HISTORY_MAX_MESSAGES + 5 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    await chatLeadTwin('co-1', 'p-1', 'Hi', history);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { history: unknown[] };
    expect(sent.history).toEqual(trimTwinChatHistory(history));
    expect(sent.history).toHaveLength(TWIN_CHAT_HISTORY_MAX_MESSAGES);
    fetchSpy.mockRestore();
  });
});

describe('trimTwinChatHistory', () => {
  const turn = (content: string) => ({ role: 'user' as const, content });

  it('keeps the most recent turns within the turn cap, oldest first', () => {
    const history = Array.from({ length: TWIN_CHAT_HISTORY_MAX_MESSAGES + 10 }, (_, i) => turn(`m${i}`));
    const trimmed = trimTwinChatHistory(history);
    expect(trimmed).toHaveLength(TWIN_CHAT_HISTORY_MAX_MESSAGES);
    expect(trimmed[0].content).toBe('m10');
    expect(trimmed.at(-1)?.content).toBe(`m${TWIN_CHAT_HISTORY_MAX_MESSAGES + 9}`);
  });

  it('keeps the most recent turns within the character budget', () => {
    const half = TWIN_CHAT_HISTORY_MAX_CHARS / 2;
    const trimmed = trimTwinChatHistory([turn('a'.repeat(half)), turn('b'.repeat(half)), turn('c'.repeat(half))]);
    expect(trimmed.map((t) => t.content[0])).toEqual(['b', 'c']);
  });

  it('cuts a single oversize turn to the budget instead of dropping it', () => {
    const trimmed = trimTwinChatHistory([turn('a'), turn('z'.repeat(TWIN_CHAT_HISTORY_MAX_CHARS + 10))]);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].content).toBe('z'.repeat(TWIN_CHAT_HISTORY_MAX_CHARS));
  });

  it('leaves a short history as it is', () => {
    const history = [turn('a'), turn('b')];
    expect(trimTwinChatHistory(history)).toEqual(history);
  });
});
