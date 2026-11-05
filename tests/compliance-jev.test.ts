// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { GATEWAY_EVALUATE_URL, JEV_MODEL, jevAllowedHere, jevRiskRead } from '../src/lib/ai/jev';
import { allowedDecision, withheldDecision } from './helpers/modelDecision';

// The model gate's decision for Jev (#339): the DEV tenant on a local dev stack.
const jev = allowedDecision('mail_send_second_opinion');

const email = { subject: 'Project Birch: Thursday call', body: 'We promise to keep it to 30 minutes.' };

function reply(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const ANSWERED = {
  model: JEV_MODEL,
  answers: {
    promissory: { type: 'boolean', probability: 0.04 },
    mnpi: { type: 'boolean', probability: 0.01 },
  },
  providerMetadata: { gateway: { cost: '0.00001155' } },
};

describe('jevRiskRead', () => {
  it('asks Jev both questions through the Gateway, zero retention, TypeSafe only', async () => {
    const fetchImpl = reply(ANSWERED);
    await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(GATEWAY_EVALUATE_URL);
    expect(init.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('typesafe-ai/jev');
    expect(body.state).toEqual(email);
    expect(Object.keys(body.questions).sort()).toEqual(['mnpi', 'promissory']);
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } });
  });

  it('returns both probabilities and the cost', async () => {
    const read = await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: reply(ANSWERED) });
    expect(read).toMatchObject({ ok: true, promissory: 0.04, mnpi: 0.01, costUsd: 0.00001155 });
  });

  it('caps a huge field before it leaves the process', async () => {
    const fetchImpl = reply(ANSWERED);
    await jevRiskRead({ subject: 's', body: 'x'.repeat(100_000) }, jev, { apiKey: 'k', fetchImpl });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.parse(init.body).state.body).toHaveLength(32 * 1024);
  });

  it('never calls out without a key', async () => {
    const fetchImpl = reply(ANSWERED);
    const read = await jevRiskRead(email, jev, { apiKey: '', fetchImpl });
    expect(read).toMatchObject({ ok: false, code: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an HTTP error, a missing answer, a network failure and a non-JSON body as failures', async () => {
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: reply({}, 500) })).toMatchObject({ ok: false, code: 'http' });
    const partial = { answers: { promissory: { probability: 0.2 } } };
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: reply(partial) })).toMatchObject({
      ok: false,
      code: 'unreadable',
    });
    const outOfRange = { answers: { promissory: { probability: 2 }, mnpi: { probability: 0 } } };
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: reply(outOfRange) })).toMatchObject({
      ok: false,
      code: 'unreadable',
    });
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: broken })).toMatchObject({ ok: false, code: 'http' });
    const notJson = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: notJson })).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('reports a timeout as a timeout', async () => {
    const slow = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    expect(await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: slow })).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('reports an absent or blank cost as unknown, not free', async () => {
    for (const cost of [undefined, '', '  ']) {
      const answered = { ...ANSWERED, providerMetadata: { gateway: { cost } } };
      const read = await jevRiskRead(email, jev, { apiKey: 'k', fetchImpl: reply(answered) });
      expect(read).toMatchObject({ ok: true, costUsd: null });
    }
  });
});

describe('jevRiskRead needs a minted decision for the second opinion (#339)', () => {
  it('refuses a hand-built decision before any fetch', async () => {
    const fetchImpl = reply(ANSWERED);
    await expect(jevRiskRead(email, { allowed: true, basis: 'verified_processor' } as never, { apiKey: 'k', fetchImpl })).rejects.toThrow(
      /minted by modelCallsAllowed/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a decision minted for another purpose before any fetch', async () => {
    const fetchImpl = reply(ANSWERED);
    for (const purpose of ['mail_send_screen', 'screening_eval'] as const) {
      await expect(jevRiskRead(email, allowedDecision(purpose), { apiKey: 'k', fetchImpl })).rejects.toThrow(
        new RegExp(`minted for ${purpose}`),
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a withheld decision makes no call', async () => {
    const fetchImpl = reply(ANSWERED);
    const read = await jevRiskRead(email, withheldDecision('mail_send_second_opinion'), { apiKey: 'k', fetchImpl });
    expect(read).toMatchObject({ ok: false, code: 'withheld' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('jevAllowedHere', () => {
  it('allows only a dev stack', () => {
    expect(jevAllowedHere({ NEXT_PUBLIC_APP_ENV: 'dev' })).toBe(true);
    expect(jevAllowedHere({ NEXT_PUBLIC_APP_ENV: ' Dev ' })).toBe(true);
    for (const value of ['prod', 'production', 'staging', 'preview', '', undefined]) {
      expect(jevAllowedHere({ NEXT_PUBLIC_APP_ENV: value })).toBe(false);
    }
  });
});
