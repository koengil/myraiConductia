// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GATEWAY_EVALUATE_URL } from '../src/lib/ai/jev';
import { fullScreenFields } from '../src/lib/compliance/llm';
import { riskBandFor } from '../src/lib/compliance/riskBand';
import { MNPI_FLAG, PROMISSORY_FLAG } from '../src/lib/compliance/screen';
import {
  jevCallAllowed,
  readSecondOpinionPolicy,
  type SecondOpinionPolicy,
} from '../src/lib/compliance/secondOpinion';
import type { FlagSource } from '../src/lib/flags/source';
import { allowedDecision, withheldDecision } from './helpers/modelDecision';

/*
 * Jev as a second opinion on a send-time rule flag (D82, off by default).
 * Every Jev and Claude reply here is a mocked fetch: no test reaches a network.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const PROMISSORY = { subject: 'Project Birch', body: 'We guarantee the deal closes by March.' };
const MNPI = { subject: 'Project Birch', body: 'Our internal model floors this at $510M.' };
const CLEAN = { subject: 'Project Birch', body: 'The data room opens Monday.' };
// The send screen's model gate (#339), open: these tests are about Jev.
const model = allowedDecision('mail_send_screen');
// Jev's own decision (#339): the DEV tenant on a local dev stack.
const jev = allowedDecision('mail_send_second_opinion');
const DEFAULT_POLICY: SecondOpinionPolicy = { threshold: 0.05, clears: 'promissory_and_mnpi' };

type JevAnswer = { promissory: number; mnpi: number } | 'http' | 'timeout' | 'garbage';

/** Route fetch by URL: Jev on the evaluate endpoint, Claude on the Messages endpoint (compliant, unless told otherwise). */
function stubNetwork(
  jev: JevAnswer,
  claude: Record<string, unknown> | 'fail' | 'zdr' = { verdict: 'compliant', reasons: [], heat: 10 },
) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url === GATEWAY_EVALUATE_URL) {
      if (jev === 'http') return new Response('{}', { status: 502 });
      if (jev === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (jev === 'garbage') return new Response('<html>', { status: 200 });
      return new Response(
        JSON.stringify({
          answers: { promissory: { probability: jev.promissory }, mnpi: { probability: jev.mnpi } },
          providerMetadata: { gateway: { cost: '0.00002' } },
        }),
        { status: 200 },
      );
    }
    if (claude === 'fail') return new Response('{}', { status: 529 });
    if (claude === 'zdr') {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans' } }), { status: 403 });
    }
    return new Response(
      JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: JSON.stringify(claude) }],
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  // One key for both: Jev and the Claude pass both go through the AI Gateway (#462).
  vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-test-key');
  return {
    fetchMock,
    jevCalls: () => fetchMock.mock.calls.filter(([url]) => url === GATEWAY_EVALUATE_URL).length,
    claudeCalls: () => fetchMock.mock.calls.filter(([url]) => url !== GATEWAY_EVALUATE_URL).length,
  };
}

function request(email: { subject: string; body: string }, policy: SecondOpinionPolicy | null = DEFAULT_POLICY) {
  const gate = vi.fn(async () => policy);
  return { gate, secondOpinion: { subject: email.subject, body: email.body, model: jev, gate } };
}

describe('fullScreenFields with a second opinion', () => {
  it('a promissory flag Jev rates below the threshold is cleared, Claude still runs, the band floors at Sampled', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.02 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('compliant');
    expect(screened.reasons).toEqual([]);
    expect(screened.holdCause).toBeUndefined();
    expect(screened.secondOpinion).toEqual({ outcome: 'cleared', threshold: 0.05, clearedReasons: [PROMISSORY_FLAG] });
    expect(screened.secondOpinionAi).toEqual({ model: 'typesafe-ai/jev', costUsd: 0.00002 });
    expect(net.jevCalls()).toBe(1);
    expect(net.claudeCalls()).toBe(1);
    expect(screened.llmChecked).toBe(true);
    // Heat 10 alone would be Routine: the clear is what floors it.
    expect(riskBandFor(screened)).toBe('sampled');
    // No probability rides on the result.
    expect(JSON.stringify(screened.secondOpinion)).not.toMatch(/0\.01|0\.02/);
  });

  it('Jev reads only the subject and body, with zero retention', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    await fullScreenFields([PROMISSORY.subject, PROMISSORY.body, 'deck.pdf'], model, { secondOpinion });
    const init = net.fetchMock.mock.calls.find(([url]) => url === GATEWAY_EVALUATE_URL)?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.state).toEqual(PROMISSORY);
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } });
  });

  it('Claude can still escalate after a clear', async () => {
    stubNetwork({ promissory: 0.01, mnpi: 0.01 }, { verdict: 'blocked', reasons: ['Implied guarantee.'] });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion?.outcome).toBe('cleared');
  });

  it('a probability at or above the threshold keeps the flag, and Claude is skipped as before', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.05 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened.reasons).toEqual([PROMISSORY_FLAG]);
    expect(screened.secondOpinion).toEqual({ outcome: 'kept', threshold: 0.05, clearedReasons: [] });
    expect(screened.secondOpinionAi?.model).toBe('typesafe-ai/jev');
    expect(net.claudeCalls()).toBe(0);
  });

  it.each(['http', 'timeout', 'garbage'] as const)('Jev failing (%s) keeps the flag', async (failure) => {
    stubNetwork(failure);
    const { secondOpinion } = request(MNPI);
    const screened = await fullScreenFields([MNPI.subject, MNPI.body], model, { secondOpinion });
    expect(screened.verdict).toBe('hold');
    expect(screened.holdCause).toBe('mnpi');
    expect(screened.secondOpinion).toEqual({ outcome: 'error', threshold: 0.05, clearedReasons: [] });
    // An unreadable reply was still a call: an unknown cost, never free. A
    // timeout or HTTP error bills nothing.
    expect(screened.secondOpinionAi).toEqual(failure === 'garbage' ? { model: 'typesafe-ai/jev', costUsd: null } : undefined);
  });

  it('keeps the flag when the API key is missing at call time', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion?.outcome).toBe('error');
    expect(net.jevCalls()).toBe(0);
  });

  it('off (the gate says no): Jev is never called and nothing is recorded', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { gate, secondOpinion } = request(PROMISSORY, null);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(net.jevCalls()).toBe(0);
    expect(screened.verdict).toBe('blocked');
    expect(screened).not.toHaveProperty('secondOpinion');
    expect(screened).not.toHaveProperty('secondOpinionAi');
  });

  it('a gate that throws counts as off', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const gate = vi.fn(async () => {
      throw new Error('flag store down');
    });
    const screened = await fullScreenFields([MNPI.subject, MNPI.body], model, {
      secondOpinion: { subject: MNPI.subject, body: MNPI.body, model: jev, gate },
    });
    expect(screened.verdict).toBe('hold');
    expect(net.jevCalls()).toBe(0);
  });

  it('clean mail never consults the gate or Jev', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { gate, secondOpinion } = request(CLEAN);
    const screened = await fullScreenFields([CLEAN.subject, CLEAN.body], model, { secondOpinion });
    expect(screened.verdict).toBe('compliant');
    expect(gate).not.toHaveBeenCalled();
    expect(net.jevCalls()).toBe(0);
    expect(screened).not.toHaveProperty('secondOpinion');
  });

  it('a fully signed-off promissory set is no flag: Jev is not asked', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { gate, secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, {
      claims: ['we guarantee'],
      secondOpinion,
    });
    expect(screened.preApproved).toEqual(['we guarantee']);
    expect(gate).not.toHaveBeenCalled();
    expect(net.jevCalls()).toBe(0);
  });

  it('a hit only in an attachment name keeps the flag: Jev never saw it', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(CLEAN);
    const screened = await fullScreenFields([CLEAN.subject, CLEAN.body, 'we guarantee the close.pdf'], model, {
      secondOpinion,
    });
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion).toEqual({ outcome: 'skipped', threshold: 0.05, clearedReasons: [] });
    expect(net.jevCalls()).toBe(0);
  });

  it.each([
    ['attachment text', 'Separately, we guarantee you the board seat.'],
    ['HTML-only text', 'We guarantee the deal closes by March. We guarantee you the board seat.'],
    ['an attachment name', 'we guarantee the board seat.pdf'],
  ])('the same term in the body and in %s: skipped, the flag kept (keys are terms, not occurrences)', async (_where, other) => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body, other], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion).toEqual({ outcome: 'skipped', threshold: 0.05, clearedReasons: [] });
    expect(net.jevCalls()).toBe(0);
  });

  it('an HTML text that reads as the body (whitespace aside) does not block a clear', async () => {
    stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    const htmlText = `  ${PROMISSORY.body.replace(' ', '\n')}  `;
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body, htmlText, 'deck.pdf'], model, { secondOpinion });
    expect(screened.verdict).toBe('compliant');
  });

  // With one gateway key for both, "Jev ran but the Claude pass had no key" cannot happen; the gateway
  // refusing zero data retention for the Claude pass is the case where Jev answered and Claude did not.
  it.each([
    ['the Claude pass fails', 'fail' as const],
    ['the gateway refuses ZDR for the Claude pass', 'zdr' as const],
  ])('a clear is undone when %s: rules verdict back, outcome error', async (_why, claude) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNetwork({ promissory: 0.01, mnpi: 0.01 }, claude);
    const { secondOpinion } = request(MNPI);
    const screened = await fullScreenFields([MNPI.subject, MNPI.body], model, { secondOpinion });
    expect(screened.verdict).toBe('hold');
    expect(screened.reasons).toEqual([MNPI_FLAG]);
    expect(screened.holdCause).toBe('mnpi');
    expect(screened.llmChecked).toBe(false);
    expect(screened.secondOpinion).toEqual({ outcome: 'error', threshold: 0.05, clearedReasons: [] });
    expect(riskBandFor(screened)).toBe('queued');
  });

  it('a promissory clear the Claude pass cannot confirm is blocked again', async () => {
    stubNetwork({ promissory: 0.01, mnpi: 0.01 }, 'fail');
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened.reasons).toEqual([PROMISSORY_FLAG]);
    expect(screened.rewrite).toBeTruthy();
    expect(screened.secondOpinion?.outcome).toBe('error');
  });

  it('a clear is undone when the model gate withholds the Claude pass (#339): Claude is never called', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields(
      [PROMISSORY.subject, PROMISSORY.body],
      withheldDecision('mail_send_screen'),
      { secondOpinion },
    );
    expect(screened.verdict).toBe('blocked');
    expect(screened.reasons).toEqual([PROMISSORY_FLAG]);
    expect(screened.llmChecked).toBe(false);
    expect(screened.llmWithheld).toBe('not_local');
    expect(screened.modelDecision.allowed).toBe(false);
    expect(screened.secondOpinion?.outcome).toBe('error');
    expect(net.claudeCalls()).toBe(0);
  });

  it('a forged Jev decision keeps the flag: the gate throws, Jev is never called (#339)', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const forged = { allowed: true, basis: 'verified_processor' } as never;
    const secondOpinion = {
      subject: PROMISSORY.subject,
      body: PROMISSORY.body,
      model: forged,
      gate: () => jevCallAllowed(forged, { getEnabled: async () => true }, { AI_GATEWAY_API_KEY: 'k' }),
    };
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('blocked');
    expect(screened).not.toHaveProperty('secondOpinion');
    expect(net.jevCalls()).toBe(0);
  });

  it('a forged decision past an open gate still never reaches Jev: the call asserts it (#339)', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, {
      secondOpinion: { ...secondOpinion, model: allowedDecision('mail_send_screen') },
    });
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion?.outcome).toBe('error');
    expect(net.jevCalls()).toBe(0);
  });

  it('a hit in the body AND only-elsewhere hit together keep the flag', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY);
    const screened = await fullScreenFields(
      [PROMISSORY.subject, PROMISSORY.body, 'Our internal model floors this at $510M.'], model,
      { secondOpinion },
    );
    expect(screened.verdict).toBe('blocked');
    expect(screened.secondOpinion?.outcome).toBe('skipped');
    expect(net.jevCalls()).toBe(0);
  });

  it('option A (default): an MNPI flag Jev clears sends, floored at Sampled', async () => {
    stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(MNPI);
    const screened = await fullScreenFields([MNPI.subject, MNPI.body], model, { secondOpinion });
    expect(screened.verdict).toBe('compliant');
    expect(screened.secondOpinion).toEqual({ outcome: 'cleared', threshold: 0.05, clearedReasons: [MNPI_FLAG] });
    expect(riskBandFor(screened)).toBe('sampled');
  });

  it('promissory_only keeps an MNPI flag without asking Jev', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(MNPI, { threshold: 0.05, clears: 'promissory_only' });
    const screened = await fullScreenFields([MNPI.subject, MNPI.body], model, { secondOpinion });
    expect(screened.verdict).toBe('hold');
    expect(screened.holdCause).toBe('mnpi');
    expect(screened.secondOpinion?.outcome).toBe('skipped');
    expect(net.jevCalls()).toBe(0);
  });

  it('promissory_only still clears a promissory flag', async () => {
    stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const { secondOpinion } = request(PROMISSORY, { threshold: 0.05, clears: 'promissory_only' });
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model, { secondOpinion });
    expect(screened.verdict).toBe('compliant');
  });

  it('without the option (the /api/v1/screen route, the eval) nothing changes', async () => {
    const net = stubNetwork({ promissory: 0.01, mnpi: 0.01 });
    const screened = await fullScreenFields([PROMISSORY.subject, PROMISSORY.body], model);
    expect(screened.verdict).toBe('blocked');
    expect(net.jevCalls()).toBe(0);
  });
});

describe('readSecondOpinionPolicy', () => {
  it('defaults to 0.05 and option B, so MNPI is never cleared by default', () => {
    expect(readSecondOpinionPolicy({})).toEqual({ threshold: 0.05, clears: 'promissory_only' });
  });

  it('reads option A only when it is set', () => {
    expect(readSecondOpinionPolicy({ JEV_SECOND_OPINION_CLEARS: 'promissory_and_mnpi' })).toEqual({
      threshold: 0.05,
      clears: 'promissory_and_mnpi',
    });
  });

  it('reads a valid threshold and option', () => {
    expect(
      readSecondOpinionPolicy({ JEV_SECOND_OPINION_THRESHOLD: ' 0.1 ', JEV_SECOND_OPINION_CLEARS: 'promissory_only' }),
    ).toEqual({ threshold: 0.1, clears: 'promissory_only' });
  });

  it.each(['abc', '0', '-0.1', '0.5', '1', 'NaN', 'Infinity', '1e-2', '0.05x'])(
    'turns the feature off for threshold %s',
    (value) => {
      expect(readSecondOpinionPolicy({ JEV_SECOND_OPINION_THRESHOLD: value })).toBeNull();
    },
  );

  it('turns the feature off for an unknown option', () => {
    expect(readSecondOpinionPolicy({ JEV_SECOND_OPINION_CLEARS: 'everything' })).toBeNull();
  });
});

describe('jevCallAllowed', () => {
  const flags = (enabled: boolean | null): FlagSource & { getEnabled: ReturnType<typeof vi.fn> } => ({
    getEnabled: vi.fn(async () => enabled),
  });

  it('allows a call only with the flag on and the key set', async () => {
    expect(await jevCallAllowed(jev, flags(true), { AI_GATEWAY_API_KEY: 'k' })).toEqual({
      threshold: 0.05,
      clears: 'promissory_only',
    });
  });

  it.each([
    { NEXT_PUBLIC_APP_ENV: 'prod' },
    { NEXT_PUBLIC_APP_ENV: ' Production ' },
    { VERCEL_ENV: 'production' },
  ])('is off in production even with the flag on and the key set (%o), and does not read the flag', async (prod) => {
    const source = flags(true);
    expect(await jevCallAllowed(jev, source, { AI_GATEWAY_API_KEY: 'k', ...prod })).toBeNull();
    expect(source.getEnabled).not.toHaveBeenCalled();
  });

  it('is off for a tenant the model gate withholds, and does not read the flag (#339)', async () => {
    const source = flags(true);
    expect(await jevCallAllowed(withheldDecision('mail_send_second_opinion'), source, { AI_GATEWAY_API_KEY: 'k' })).toBeNull();
    expect(source.getEnabled).not.toHaveBeenCalled();
  });

  it('refuses a hand-built decision or one minted for the screen, and does not read the flag (#339)', async () => {
    const source = flags(true);
    await expect(
      jevCallAllowed({ allowed: true, basis: 'verified_processor' } as never, source, { AI_GATEWAY_API_KEY: 'k' }),
    ).rejects.toThrow(/minted by modelCallsAllowed/);
    await expect(jevCallAllowed(model, source, { AI_GATEWAY_API_KEY: 'k' })).rejects.toThrow(/minted for mail_send_screen/);
    expect(source.getEnabled).not.toHaveBeenCalled();
  });

  it('is off when the flag is off or has no row', async () => {
    expect(await jevCallAllowed(jev, flags(false), { AI_GATEWAY_API_KEY: 'k' })).toBeNull();
    expect(await jevCallAllowed(jev, flags(null), { AI_GATEWAY_API_KEY: 'k' })).toBeNull();
  });

  it('is off without a key, and does not read the flag', async () => {
    const source = flags(true);
    expect(await jevCallAllowed(jev, source, {})).toBeNull();
    expect(source.getEnabled).not.toHaveBeenCalled();
  });

  it('is off with an invalid policy even when the flag is on', async () => {
    expect(
      await jevCallAllowed(jev, flags(true), { AI_GATEWAY_API_KEY: 'k', JEV_SECOND_OPINION_THRESHOLD: '0.9' }),
    ).toBeNull();
  });

  it('is off when the flag store fails', async () => {
    const source: FlagSource = {
      getEnabled: async () => {
        throw new Error('down');
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await jevCallAllowed(jev, source, { AI_GATEWAY_API_KEY: 'k' })).toBeNull();
  });
});
