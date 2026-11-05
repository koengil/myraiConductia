import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import { billedAttempt, callModel, type ModelCallResult, type ModelRequest } from '@/lib/modelGateway';
import { PREAMBLE } from '@/lib/modelGateway/prompts/dealProposal.v2';
import { PROMPT_HASH } from '@/lib/modelGateway/prompts/milestoneExtract.v1';
import { loadRecording, recordedTransport, recordingDigest, type RecordingFile } from '@/lib/modelGateway/record';
import { GATEWAY_MESSAGES_URL, gatewayModelId, gatewayTransport, postGatewayMessages } from '@/lib/modelGateway/transports';
import { __resetWarnOnceForTests, warnOnce, type GatewayMessagesRequest } from '@/lib/modelGateway/gatewayClient';

const TENANT = '00000000-0000-4000-8000-0000000000aa';

const REQ: ModelRequest = {
  purpose: 'milestone_extract',
  promptVersion: 'v1',
  model: 'anthropic/claude-sonnet-5',
  tenantId: TENANT,
  sourceItemId: 'item-1',
  contentHash: 'hash-1',
  input: { subject: 'Project Kestrel: LOI signed', sentAt: '2026-09-18T17:30:00.000Z', body: 'The LOI was signed today.' },
};

// The demo-only deal proposal request (#460): the same transport, a second purpose.
const PROPOSAL_REQ: ModelRequest = {
  purpose: 'deal_proposal',
  promptVersion: 'v2',
  model: PROPOSAL_MODEL,
  tenantId: TENANT,
  contentHash: 'hash-1',
  input: {
    subject: 'RE: Bid clarifications',
    sentAt: '2026-08-07T08:50:00.000Z',
    body: 'Following up on the working capital question.',
    domains: ['castellan.example', 'bank.example'],
    candidates: [{ ref: 'c:00000000-0000-4000-8000-0000000000aa', name: 'Project Kestrel' }],
  },
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('gatewayTransport', () => {
  it('posts to the gateway with the zero-retention field at the top level of the body', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        id: 'msg_123',
        model: 'anthropic/claude-sonnet-5',
        content: [{ type: 'text', text: '{"milestones":[]}' }],
        usage: { input_tokens: 400, output_tokens: 20 },
      }),
    );
    const result = await callModel(REQ, gatewayTransport({ apiKey: 'gw-key', fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GATEWAY_MESSAGES_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('gw-key');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    const body = JSON.parse(init.body as string);
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
    expect(body.model).toBe('anthropic/claude-sonnet-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[0].content).toContain('The LOI was signed today.');

    expect(result).toMatchObject({
      ok: true,
      text: '{"milestones":[]}',
      responseId: 'msg_123',
      transport: 'gateway',
      usage: { model: 'anthropic/claude-sonnet-5', inputTokens: 400, outputTokens: 20 },
    });
  });

  it('sends a deal_proposal request with the identical zero-retention field, the email first and the questions last', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        id: 'msg_456',
        model: 'claude-haiku-5.5',
        content: [{ type: 'text', text: '{"deal_related":false,"p_deal":0.1,"deal":null,"phase":null,"p_phase":0}' }],
        usage: { input_tokens: 900, output_tokens: 30 },
      }),
    );
    const result = await callModel(PROPOSAL_REQ, gatewayTransport({ apiKey: 'gw-key', fetchImpl: fetchImpl as unknown as typeof fetch }));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GATEWAY_MESSAGES_URL);
    const body = JSON.parse(init.body as string);
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
    expect(body.model).toBe('anthropic/claude-haiku-5.5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.system).toBe(PREAMBLE);
    expect(body.messages).toHaveLength(1);
    const content = body.messages[0].content as string;
    expect(content.startsWith('<email>\n')).toBe(true);
    expect(content.endsWith('</questions>')).toBe(true);
    expect(content.indexOf('Following up on the working capital question.')).toBeLessThan(content.indexOf('<questions>'));
    expect(content).toContain('c:00000000-0000-4000-8000-0000000000aa: Project Kestrel');
    expect(result).toMatchObject({ ok: true, responseId: 'msg_456', usage: { model: 'claude-haiku-5.5', inputTokens: 900 } });
  });

  it('sends nothing without a key', async () => {
    const fetchImpl = vi.fn();
    const saved = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const result = await callModel(REQ, gatewayTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }));
      expect(result).toMatchObject({ ok: false, code: 'no_key', transport: 'gateway' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved;
    }
  });

  it('reports a timeout as timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    });
    const result = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('reports a non-OK status, or a network error, as http, without the body', async () => {
    const bad = vi.fn(async () => new Response('secret upstream detail', { status: 500 }));
    const r1 = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: bad as unknown as typeof fetch }));
    expect(r1).toMatchObject({ ok: false, code: 'http' });
    expect(JSON.stringify(r1)).not.toContain('secret upstream detail');
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const r2 = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: down as unknown as typeof fetch }));
    expect(r2).toMatchObject({ ok: false, code: 'http' });
  });
});

describe('postGatewayMessages', () => {
  const CALL = { feature: 'compliance_screen' as const, model: 'anthropic/claude-sonnet-5', system: 'sys', user: 'hello', maxTokens: 64, timeoutMs: 1000 };
  const asFetch = (f: unknown) => f as typeof fetch;

  it('sends the zero-retention body to the gateway and returns text, id and usage', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        id: 'msg_9',
        model: 'anthropic/claude-sonnet-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const r = await postGatewayMessages({ ...CALL, apiKey: 'gw-key', fetchImpl: asFetch(fetchImpl) });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GATEWAY_MESSAGES_URL);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('gw-key');
    const body = JSON.parse(init.body as string);
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
    expect(body).toMatchObject({ model: 'anthropic/claude-sonnet-5', max_tokens: 64, system: 'sys' });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body).not.toHaveProperty('thinking');
    expect(r).toEqual({
      ok: true,
      text: 'hi',
      responseId: 'msg_9',
      usage: { model: 'anthropic/claude-sonnet-5', inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('adds thinking only when asked', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ content: [] }));
    await postGatewayMessages({ ...CALL, apiKey: 'k', thinking: { type: 'disabled' }, fetchImpl: asFetch(fetchImpl) });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).thinking).toEqual({ type: 'disabled' });
  });

  it('reads AI_GATEWAY_API_KEY at call time, and sends nothing without it', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ content: [] }));
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    expect(await postGatewayMessages({ ...CALL, fetchImpl: asFetch(fetchImpl) })).toEqual({ ok: false, code: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubEnv('AI_GATEWAY_API_KEY', 'late-key');
    await postGatewayMessages({ ...CALL, fetchImpl: asFetch(fetchImpl) });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('late-key');
    vi.unstubAllEnvs();
  });

  it('reports a non-2xx as http with the status and a code, never the body', async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'secret upstream detail' } }), { status: 529 }));
    const r = await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(bad) });
    expect(r).toEqual({ ok: false, code: 'http', status: 529, errorCode: 'overloaded_error' });
    expect(JSON.stringify(r)).not.toContain('secret upstream detail');
  });

  it('reports a timeout, and a network error, without throwing', async () => {
    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(slow) })).toEqual({ ok: false, code: 'timeout' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(down) })).toEqual({ ok: false, code: 'http' });
  });

  it.each([
    ['invalid JSON', () => new Response('not json', { status: 200 })],
    ['null', () => okResponse(null)],
    ['a non-object', () => okResponse(42)],
  ])('a 2xx reply that is %s becomes http, not a throw, and is marked billed (#645)', async (_label, make) => {
    const fetchImpl = vi.fn(async () => make());
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(fetchImpl) })).toEqual({
      ok: false,
      code: 'http',
      billed: true,
      usage: null,
      responseId: '',
    });
    const viaTransport = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: asFetch(fetchImpl) }));
    expect(viaTransport).toMatchObject({ ok: false, code: 'http', billed: true, usage: null, responseId: '', transport: 'gateway' });
  });

  it('a 2xx reply whose body does not arrive in time becomes timeout, marked billed (#645)', async () => {
    const fetchImpl = vi.fn(async () => {
      const res = okResponse({});
      res.json = async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      };
      return res;
    });
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(fetchImpl) })).toEqual({
      ok: false,
      code: 'timeout',
      billed: true,
      usage: null,
      responseId: '',
    });
  });

  it('a billed 2xx reply whose content cannot be read becomes http and still carries its usage and id, through the transport too', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ id: 'm', model: 'anthropic/claude-sonnet-5', usage: { input_tokens: 9, output_tokens: 3 }, content: 'not a list' }),
    );
    const usage = { model: 'anthropic/claude-sonnet-5', inputTokens: 9, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(fetchImpl) })).toEqual({
      ok: false,
      code: 'http',
      billed: true,
      usage,
      responseId: 'm',
    });
    const viaTransport = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: asFetch(fetchImpl) }));
    expect(viaTransport).toMatchObject({ ok: false, outcome: 'failed', code: 'http', billed: true, usage, responseId: 'm', transport: 'gateway' });
  });

  it('a failure before any 2xx reply carries no billed marker, through the transport too', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const viaTransport = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: asFetch(down) }));
    expect(viaTransport).not.toHaveProperty('billed');
    expect(viaTransport).not.toHaveProperty('usage');
  });

  it('returns null text when the reply has no text block', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'm', content: [{ type: 'tool_use' }] }));
    const r = await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: asFetch(fetchImpl) });
    expect(r).toMatchObject({ ok: true, text: null, responseId: 'm', usage: null });
  });
});

describe('a model id the request cannot serve', () => {
  const CALL = { feature: 'compliance_screen' as const, system: 'sys', user: 'hello', maxTokens: 64, timeoutMs: 1000 };

  it.each(['openai/gpt-4o-mini', 'zai/glm-4.6', 'claude-sonnet-5'])(
    '%s is refused before anything is sent: the request is pinned to only: [anthropic]',
    async (model) => {
      const fetchImpl = vi.fn();
      expect(await postGatewayMessages({ ...CALL, model, apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
        ok: false,
        code: 'http',
        errorCode: 'non_anthropic_model',
      });
      expect(await callModel({ ...REQ, model }, gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }))).toMatchObject({
        ok: false,
        code: 'http',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe('a ZDR refusal', () => {
  const CALL = { feature: 'compliance_screen' as const, model: 'anthropic/claude-sonnet-5', system: 'sys', user: 'hello', maxTokens: 64, timeoutMs: 1000 };
  const SECRET = 'canary-zdr-body-text';
  const reply = (status: number, error: Record<string, unknown>) => () =>
    new Response(JSON.stringify({ type: 'error', error }), { status });
  const PLAN = reply(403, { type: 'permission_denied', message: `Zero Data Retention (ZDR) is only available for Pro and Enterprise plans ${SECRET}` });
  const NO_PROVIDER = reply(400, { type: 'no_providers_available', message: `No ZDR (Zero Data Retention) providers available for model x ${SECRET}` });

  it.each([
    ['403 permission_denied naming ZDR (the plan)', PLAN, 403, 'permission_denied'],
    ['400 no_providers_available (the model)', NO_PROVIDER, 400, 'no_providers_available'],
  ])('%s becomes zdr_unavailable, with the status and type only', async (_label, make, status, type) => {
    const fetchImpl = vi.fn(async () => make());
    const r = await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, code: 'zdr_unavailable', zdrReason: type, status, errorCode: type });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const viaTransport = await callModel(REQ, gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(viaTransport).toMatchObject({ ok: false, code: 'zdr_unavailable', zdrReason: type, transport: 'gateway' });
  });

  it('a 403 permission_denied that does not name ZDR stays http', async () => {
    const fetchImpl = vi.fn(async () => reply(403, { type: 'permission_denied', message: 'key revoked' })());
    expect(await postGatewayMessages({ ...CALL, apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      code: 'http',
      status: 403,
      errorCode: 'permission_denied',
    });
  });

  it('warnOnce keys on the feature and the message, so a later refusal is not hidden by a missing-key warning', () => {
    __resetWarnOnceForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('f', 'one');
    warnOnce('f', 'one');
    warnOnce('f', 'two');
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['[f] one', '[f] two']);
    warn.mockRestore();
  });
});

describe('the model_outcome line: one per call, closed values only (#474)', () => {
  const CANARY = 'CANARY-331 Project Falcon jane@bank.example';
  const CALL: GatewayMessagesRequest = {
    feature: 'compliance_screen',
    model: 'anthropic/claude-sonnet-5',
    system: CANARY,
    user: CANARY,
    maxTokens: 64,
    timeoutMs: 1000,
    apiKey: 'k',
  };
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
  const refusal = (status: number, type: string) => json(status, { type: 'error', error: { type, message: `Zero Data Retention (ZDR) ${CANARY}` } });
  const asFetch = (reply: () => Response) => vi.fn(async () => reply()) as unknown as typeof fetch;

  let written: Array<{ method: 'log' | 'warn' | 'error'; text: string }> = [];
  beforeEach(() => {
    written = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push({ method, text: args.map(String).join(' ') }));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Every line written, parsed, with the console method that wrote it; ms is checked to be a whole number, then left out. */
  function lines() {
    return written.map(({ method, text }) => {
      const { ms, ...line } = JSON.parse(text) as Record<string, unknown>;
      expect(Number.isInteger(ms) && (ms as number) >= 0, text).toBe(true);
      return { method, line };
    });
  }
  const contentFree = () => expect(written.map((w) => w.text).join('\n')).not.toContain('CANARY-331');

  const FAILURES: Array<[string, () => Response, Record<string, unknown>]> = [
    ['a non-2xx reply', json(529, { error: { type: 'overloaded_error', message: CANARY } }), { outcome: 'http', failure: 'upstream_status', status: 529 }],
    ['a 403 ZDR refusal', refusal(403, 'permission_denied'), { outcome: 'zdr_unavailable', failure: 'upstream_status', zdrReason: 'permission_denied', status: 403 }],
    ['a 400 ZDR refusal', refusal(400, 'no_providers_available'), { outcome: 'zdr_unavailable', failure: 'upstream_status', zdrReason: 'no_providers_available', status: 400 }],
    ['a 2xx reply that is not JSON', () => new Response(CANARY, { status: 200 }), { outcome: 'http', failure: 'malformed_reply' }],
    ['a 2xx reply that is not an object', json(200, 42), { outcome: 'http', failure: 'malformed_reply' }],
    ['a 2xx reply whose content is not a list', json(200, { id: 'm', content: CANARY }), { outcome: 'http', failure: 'malformed_reply' }],
    ['a network error', () => { throw new TypeError(`fetch failed ${CANARY}`); }, { outcome: 'http', failure: 'network' }],
    ['a timeout', () => { throw Object.assign(new Error(CANARY), { name: 'TimeoutError' }); }, { outcome: 'timeout' }],
  ];

  it.each(FAILURES)('%s writes one error line with its closed outcome', async (_label, reply, expected) => {
    await postGatewayMessages({ ...CALL, fetchImpl: asFetch(reply) });
    expect(lines()).toEqual([{ method: 'error', line: { evt: 'model_outcome', feature: 'compliance_screen', ...expected } }]);
    contentFree();
  });

  it('refuses a non-Anthropic id with its own failure, before anything is sent', async () => {
    const fetchImpl = vi.fn();
    await postGatewayMessages({ ...CALL, model: 'openai/gpt-4o-mini', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      { method: 'error', line: { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: 'non_anthropic_model' } },
    ]);
  });

  it('decides no_key itself, for a web caller and through the worker transport alike', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await postGatewayMessages({ ...CALL, apiKey: undefined, fetchImpl });
    expect(await callModel(REQ, gatewayTransport({ fetchImpl }))).toMatchObject({ ok: false, code: 'no_key', transport: 'gateway' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      { method: 'error', line: { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'no_key' } },
      { method: 'error', line: { evt: 'model_outcome', feature: 'milestone_extract', outcome: 'no_key', tenant: TENANT } },
    ]);
  });

  it('decides the transport no_key when it is built, before the prompt, even if the env gains a key later', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', undefined);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const transport = gatewayTransport({ fetchImpl });
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-key-set-later');
    expect(await callModel(REQ, transport)).toMatchObject({ ok: false, code: 'no_key', transport: 'gateway' });
    expect(fetchImpl).not.toHaveBeenCalled();
    // No prompt is built: a request whose prompt version is unknown still answers no_key, it does not throw.
    const unknownPrompt = { ...REQ, promptVersion: 'v0' } as unknown as ModelRequest;
    expect(await transport.send(unknownPrompt)).toMatchObject({ ok: false, code: 'no_key', transport: 'gateway' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'milestone_extract', outcome: 'no_key', tenant: TENANT };
    expect(lines()).toEqual([{ method: 'error', line }, { method: 'error', line }]);
  });

  it('logs a success for the web features only: the worker counts its own successes', async () => {
    const fetchImpl = asFetch(() => okResponse({ id: 'm', content: [{ type: 'text', text: CANARY }] }));
    await postGatewayMessages({ ...CALL, fetchImpl });
    await postGatewayMessages({ ...CALL, feature: 'codename_suggest', fetchImpl });
    await postGatewayMessages({ ...CALL, feature: 'milestone_extract', tenant: TENANT, fetchImpl });
    await callModel(PROPOSAL_REQ, gatewayTransport({ apiKey: 'k', fetchImpl }));
    expect(lines()).toEqual([
      { method: 'log', line: { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'ok' } },
      { method: 'log', line: { evt: 'model_outcome', feature: 'codename_suggest', outcome: 'ok' } },
    ]);
    contentFree();
  });

  it('logs a worker failure at console.error with its tenant, once per attempt, never at console.warn', async () => {
    const fetchImpl = asFetch(refusal(400, 'no_providers_available'));
    const transport = gatewayTransport({ apiKey: 'k', fetchImpl });
    await callModel(PROPOSAL_REQ, transport);
    await callModel(PROPOSAL_REQ, transport); // a D106 retry is a second attempt: a second line
    const line = { evt: 'model_outcome', feature: 'deal_proposal', outcome: 'zdr_unavailable', failure: 'upstream_status', zdrReason: 'no_providers_available', status: 400, tenant: TENANT };
    expect(lines()).toEqual([{ method: 'error', line }, { method: 'error', line }]);
    expect(written.map((w) => w.text).join('\n')).not.toContain('working capital');
    contentFree();
  });
});

describe('gatewayModelId', () => {
  it('prefixes a bare id and passes a prefixed one through', () => {
    expect(gatewayModelId('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(gatewayModelId('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });
});

describe('billedAttempt (#645)', () => {
  const USAGE = { model: 'anthropic/claude-haiku-5.5', inputTokens: 2000, outputTokens: 100 };
  const ok = (over: Partial<Extract<ModelCallResult, { ok: true }>> = {}): ModelCallResult => ({
    ok: true, text: '{}', responseId: 'msg_1', usage: USAGE, transport: 'gateway', latencyMs: 0, ...over,
  });
  const failed = (over: Partial<Extract<ModelCallResult, { ok: false }>> = {}): ModelCallResult => ({
    ok: false, outcome: 'failed', code: 'http', transport: 'gateway', latencyMs: 0, ...over,
  });

  it('owes a priced row for a reply with usage, keyed by its id', () => {
    expect(billedAttempt(ok(), 'anthropic/requested')).toEqual({ externalId: 'msg_1', model: USAGE.model, usage: USAGE });
    expect(billedAttempt(failed({ billed: true, usage: USAGE, responseId: 'msg_2' }), 'anthropic/requested')).toEqual({
      externalId: 'msg_2', model: USAGE.model, usage: USAGE,
    });
  });

  it('owes an unpriced row under the requested model for a billed reply without usage', () => {
    expect(billedAttempt(ok({ usage: null }), 'anthropic/requested')).toEqual({ externalId: 'msg_1', model: 'anthropic/requested', usage: null });
    expect(billedAttempt(failed({ billed: true, usage: null, responseId: 'msg_3' }), 'anthropic/requested')).toMatchObject({
      model: 'anthropic/requested', usage: null,
    });
  });

  it('owes an unpriced row, never a $0 priced one, for a usage block without token counts', async () => {
    // usage {} parses to zero counts (usage.ts maps a missing count to 0): the bill is unknown, not free.
    const fetchImpl = vi.fn(async () =>
      okResponse({ id: 'msg_9', model: 'anthropic/claude-haiku-5.5', content: [{ type: 'text', text: '{}' }], usage: {} }),
    );
    const call = await callModel(PROPOSAL_REQ, gatewayTransport({ apiKey: 'gw-key', fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(billedAttempt(call, 'anthropic/requested')).toEqual({ externalId: 'msg_9', model: 'anthropic/claude-haiku-5.5', usage: null });
    const empty = { model: USAGE.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(billedAttempt(failed({ billed: true, usage: empty, responseId: 'msg_10' }), 'm')!.usage).toBeNull();
    // One count is enough to price the row.
    expect(billedAttempt(ok({ usage: { ...empty, outputTokens: 5 } }), 'm')!.usage).toMatchObject({ inputTokens: 0, outputTokens: 5 });
  });

  it('keys a reply without an id on a local: id of its own, never the shared empty one', () => {
    const a = billedAttempt(ok({ responseId: '' }), 'm')!;
    const b = billedAttempt(failed({ billed: true, usage: null, responseId: '' }), 'm')!;
    const c = billedAttempt(failed({ billed: true }), 'm')!;
    for (const x of [a, b, c]) expect(x.externalId).toMatch(/^local:[0-9a-f-]{36}$/);
    expect(new Set([a.externalId, b.externalId, c.externalId]).size).toBe(3);
  });

  it('clamps token counts to non-negative int4 integers, so the ledger never refuses the row', () => {
    const odd = { model: USAGE.model, inputTokens: 1.5, outputTokens: -3, cacheReadTokens: 2 ** 40, cacheWriteTokens: Number.NaN };
    expect(billedAttempt(ok({ usage: odd }), 'm')!.usage).toEqual({
      model: USAGE.model, inputTokens: 2, outputTokens: 0, cacheReadTokens: 2 ** 31 - 1, cacheWriteTokens: 0,
    });
  });

  it('owes nothing for a replay, a refusal or a failure before any reply', () => {
    expect(billedAttempt(ok({ transport: 'recorded' }), 'm')).toBeNull();
    expect(billedAttempt(failed({ transport: 'recorded', billed: true, usage: USAGE, responseId: 'msg_4' }), 'm')).toBeNull();
    expect(billedAttempt(failed({ code: 'zdr_unavailable', zdrReason: 'no_providers_available' }), 'm')).toBeNull();
    expect(billedAttempt(failed({ code: 'timeout' }), 'm')).toBeNull();
    expect(billedAttempt(failed({ code: 'no_key' }), 'm')).toBeNull();
  });
});

function recording(over: Partial<RecordingFile> = {}): RecordingFile {
  const replies = { 'hash-1': { text: '{"milestones":[]}', responseId: 'msg_rec_1' } };
  return {
    format: 'conductia.model-replies/v1',
    purpose: 'milestone_extract',
    promptVersion: 'v1',
    promptHash: PROMPT_HASH,
    model: 'anthropic/claude-sonnet-5',
    provider: 'gateway',
    upstreamModel: 'anthropic/claude-sonnet-5',
    recordedAt: '2026-10-01T00:00:00.000Z',
    corpusDigest: 'sha256:test',
    replies,
    digest: recordingDigest(replies),
    ...over,
  };
}

describe('recordedTransport', () => {
  it('replays a hit with no usage', async () => {
    const result = await callModel(REQ, recordedTransport(recording()));
    expect(result).toEqual({
      ok: true,
      text: '{"milestones":[]}',
      responseId: 'msg_rec_1',
      usage: null,
      transport: 'recorded',
      latencyMs: 0,
    });
  });

  it('misses on an unknown content hash', async () => {
    const result = await callModel({ ...REQ, contentHash: 'other' }, recordedTransport(recording()));
    expect(result).toMatchObject({ ok: false, code: 'recording_miss', transport: 'recorded' });
  });

  it('misses on a model mismatch', async () => {
    const result = await callModel({ ...REQ, model: 'anthropic/claude-haiku-4-5' }, recordedTransport(recording()));
    expect(result).toMatchObject({ ok: false, code: 'recording_miss' });
  });

  it('misses on a purpose mismatch, even when the content hash and model match', async () => {
    const extract = recording({ model: PROPOSAL_MODEL });
    expect(await callModel(PROPOSAL_REQ, recordedTransport(extract))).toMatchObject({ ok: false, code: 'recording_miss' });
    const proposals = recording({ purpose: 'deal_proposal', promptVersion: 'v2', model: PROPOSAL_MODEL });
    expect(await callModel({ ...REQ, model: PROPOSAL_MODEL }, recordedTransport(proposals))).toMatchObject({
      ok: false,
      code: 'recording_miss',
    });
    expect(await callModel(PROPOSAL_REQ, recordedTransport(proposals))).toMatchObject({ ok: true, usage: null, transport: 'recorded' });
  });
});

describe('loadRecording', () => {
  const write = (value: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'replies-')), 'extract.v1.json');
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it('loads a file whose digest matches', () => {
    expect(loadRecording(write(recording())).replies['hash-1'].responseId).toBe('msg_rec_1');
  });

  it('rejects a bad digest', () => {
    expect(() => loadRecording(write(recording({ digest: 'sha256:deadbeef' })))).toThrow(/digest mismatch/);
  });

  it('rejects an edited reply', () => {
    const file = recording();
    file.replies['hash-1'].text = '{"milestones":[{"type":"closed"}]}';
    expect(() => loadRecording(write(file))).toThrow(/digest mismatch/);
  });

  it('rejects an unknown format', () => {
    expect(() => loadRecording(write({ ...recording(), format: 'something-else' }))).toThrow(/unknown format/);
  });

  it('digests the same replies the same way whatever their key order', () => {
    const a = { x: { text: '1', responseId: 'a' }, y: { text: '2', responseId: 'b' } };
    const b = { y: { text: '2', responseId: 'b' }, x: { text: '1', responseId: 'a' } };
    expect(recordingDigest(a)).toBe(recordingDigest(b));
  });
});
