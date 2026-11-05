// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { GATEWAY_MESSAGES_URL } from '@/lib/modelGateway/gatewayClient';

import { DEFAULT_NON_ZDR_MODEL, runZdrProbe } from '../scripts/ai/zdr-probe';

/*
 * The live ZDR probe (#462), run offline: the requests it builds, the decision
 * it prints and its exit verdict, against a stubbed gateway. The owner runs the
 * real thing with the production key; CI has no key and never sends.
 */

const KEY = 'sk-probe-canary-key';
const SCREEN = 'anthropic/claude-sonnet-5';
const ok = () => new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'OK' }] }), { status: 200 });
const refuse = (status: number, type: string, message: string) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status });
const PLAN = refuse(403, 'permission_denied', 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans');
const NO_PROVIDER = refuse(400, 'no_providers_available', 'No ZDR (Zero Data Retention) providers available for model x');
const BAD_REQUEST = refuse(400, 'invalid_request_error', 'model not found');

function gateway(byModel: Record<string, () => Response>) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    return byModel[model]();
  });
}

async function probe(byModel: Record<string, () => Response>, apiKey = KEY) {
  const fetchImpl = gateway(byModel);
  const outcome = await runZdrProbe({ apiKey, env: {}, fetchImpl });
  return { outcome, fetchImpl };
}

const bodyOf = (fetchImpl: ReturnType<typeof gateway>, i: number) => JSON.parse(String(fetchImpl.mock.calls[i][1]?.body));

describe('npm run ai:zdr-probe', () => {
  it('passes when the screen model answers 200 and the non-ZDR model answers 400 no_providers_available', async () => {
    const { outcome, fetchImpl } = await probe({ [SCREEN]: ok, [DEFAULT_NON_ZDR_MODEL]: NO_PROVIDER });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines[0]).toMatch(/^PASS \(a\) screen model anthropic\/claude-sonnet-5 with ZDR: 200/);
    expect(outcome.lines[1]).toBe(
      'PASS (b) zai/glm-4.6 with ZDR, no provider restriction: 400 no_providers_available; expected 400 no_providers_available',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(GATEWAY_MESSAGES_URL);
      expect(init?.headers).toEqual({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    }
  });

  it('(a) carries the client body; (b) carries ZDR with no provider restriction, so it proves the flag', async () => {
    const { fetchImpl } = await probe({ [SCREEN]: ok, [DEFAULT_NON_ZDR_MODEL]: NO_PROVIDER });
    const a = bodyOf(fetchImpl, 0);
    const b = bodyOf(fetchImpl, 1);
    expect(a).toMatchObject({ model: SCREEN, max_tokens: 5 });
    expect(a.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
    expect(b).toMatchObject({ model: DEFAULT_NON_ZDR_MODEL, max_tokens: 5 });
    expect(b.providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
  });

  it('honours --non-zdr-model', async () => {
    const fetchImpl = gateway({ [SCREEN]: ok, 'other/model': NO_PROVIDER });
    const outcome = await runZdrProbe({ apiKey: KEY, env: {}, nonZdrModel: 'other/model', fetchImpl });
    expect(outcome.ok).toBe(true);
    expect(bodyOf(fetchImpl, 1).model).toBe('other/model');
  });

  it("fails when the key's plan has no ZDR (today's Hobby-plan refusal), and says so", async () => {
    const { outcome } = await probe({ [SCREEN]: PLAN, [DEFAULT_NON_ZDR_MODEL]: PLAN });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toMatch(/^FAIL \(a\) .* 403 permission_denied \(zdr_unavailable\)/);
    expect(outcome.lines[1]).toMatch(/^FAIL \(b\) .*: 403 permission_denied;/);
    expect(outcome.lines[2]).toBe("The gateway refused ZDR: key's team plan has no ZDR (Pro or Enterprise needed).");
  });

  it.each([
    ['answered, not refused', ok],
    ['refused for another reason', BAD_REQUEST],
    ['refused for the plan', PLAN],
  ])('(b) fails when the non-ZDR model is %s', async (_label, reply) => {
    const { outcome } = await probe({ [SCREEN]: ok, [DEFAULT_NON_ZDR_MODEL]: reply });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[1]).toMatch(/^FAIL \(b\)/);
  });

  it('(b) fails on no response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (JSON.parse(String(init?.body)).model === SCREEN) return ok();
      throw new TypeError('fetch failed');
    });
    const outcome = await runZdrProbe({ apiKey: KEY, env: {}, fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[1]).toMatch(/^FAIL \(b\) .*: no response;/);
  });

  it('sends nothing without a key', async () => {
    const { outcome, fetchImpl } = await probe({}, '');
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never prints the key or a reply body', async () => {
    const { outcome } = await probe({ [SCREEN]: PLAN, [DEFAULT_NON_ZDR_MODEL]: NO_PROVIDER });
    const printed = outcome.lines.join('\n');
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain('only available for');
    expect(printed).not.toContain('providers available for model');
  });
});
