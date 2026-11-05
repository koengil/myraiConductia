import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCallDecision } from '../src/lib/ai/modelPolicy';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { allowedDecision, withheldDecision } from './helpers/modelDecision';
import { fullScreen, fullScreenFields, mergeVerdicts, systemPrompt } from '../src/lib/compliance/llm';
import { GATEWAY_MESSAGES_URL, __resetWarnOnceForTests } from '../src/lib/modelGateway/gatewayClient';

/** The model_outcome lines a console.error spy saw, without the measured ms (#474). */
function outcomes(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((c) => typeof c[0] === 'string' && c[0].startsWith('{"evt":"model_outcome"'))
    .map((c) => {
      const line = JSON.parse(c[0] as string) as Record<string, unknown>;
      delete line.ms;
      return line;
    });
}

/*
 * The LLM escalation layer over the deterministic screen (ADR-0003).
 *
 * Doctrine under test (handbook §2, "no LLM in the verdict"): the deterministic
 * screenMessage() is the compliance control; the LLM may only ESCALATE
 * (compliant → hold/blocked, hold → blocked). A rules-based verdict is never
 * downgraded, and LLM unavailability degrades visibly (llmChecked: false),
 * never silently.
 */

beforeEach(() => {
  __resetWarnOnceForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('mergeVerdicts', () => {
  const compliant = { verdict: 'compliant' as const, reasons: [] };
  const hold = { verdict: 'hold' as const, reasons: ['Contains MNPI.'] };
  const blocked = {
    verdict: 'blocked' as const,
    reasons: ['Promissory language.'],
    rewrite: 'Use "we expect to".',
  };

  it('llm unavailable (null) -> deterministic verdict, llmChecked false', () => {
    const merged = mergeVerdicts(compliant, null);
    expect(merged.verdict).toBe('compliant');
    expect(merged.llmChecked).toBe(false);
  });

  it('llm escalates compliant -> hold, reasons appended, llmChecked true', () => {
    const merged = mergeVerdicts(compliant, {
      verdict: 'hold',
      reasons: ['Implied valuation leak.'],
    });
    expect(merged.verdict).toBe('hold');
    expect(merged.reasons).toContain('Implied valuation leak.');
    expect(merged.llmChecked).toBe(true);
  });

  it('llm escalates hold -> blocked and its rewrite carries', () => {
    const merged = mergeVerdicts(hold, {
      verdict: 'blocked',
      reasons: ['Softened promissory intent.'],
      rewrite: 'Frame as a discussion point.',
    });
    expect(merged.verdict).toBe('blocked');
    expect(merged.reasons).toEqual(['Contains MNPI.', 'Softened promissory intent.']);
    expect(merged.rewrite).toBe('Frame as a discussion point.');
  });

  it('never downgrades: rules-based blocked stays blocked whatever the llm says', () => {
    const merged = mergeVerdicts(blocked, { verdict: 'compliant', reasons: [] });
    expect(merged.verdict).toBe('blocked');
    expect(merged.reasons).toEqual(['Promissory language.']);
    expect(merged.rewrite).toBe('Use "we expect to".');
    expect(merged.llmChecked).toBe(true);
  });

  it('same severity leaves the deterministic result untouched', () => {
    const merged = mergeVerdicts(hold, { verdict: 'hold', reasons: ['Other reason.'] });
    expect(merged.verdict).toBe('hold');
    expect(merged.reasons).toEqual(['Contains MNPI.']);
  });
});

// The model gate (#339). Decisions are minted only by modelCallsAllowed,
// which takes no injected policy: the open one is the DEV tenant on a local
// dev stack, the withheld one a real tenant on a hosted URL.
const allowed = allowedDecision('mail_screen');
const withheld = withheldDecision('mail_screen');

// A clean text: the deterministic layer reads it compliant, so whatever the
// verdict says beyond that came from the model pass.
const CLEAN = 'The room opens Monday.';

describe('the model pass', () => {
  function stubGateway(contentText: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: contentText }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('does not run without AI_GATEWAY_API_KEY, logs a no_key line per call, and never calls fetch', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'no_key' };
    expect(outcomes(err)).toEqual([line, line]);
    warn.mockRestore();
    err.mockRestore();
  });

  it('sends to the gateway with zero data retention, a prefixed model and the provider-default thinking', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-key');
    vi.stubEnv('SCREEN_LLM_MODEL', '');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await fullScreenFields([CLEAN], allowed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GATEWAY_MESSAGES_URL);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('gw-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('anthropic/claude-sonnet-5');
    expect(body).not.toHaveProperty('thinking');
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
  });

  it('SCREEN_LLM_MODEL accepts a bare or a prefixed id', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-key');
    vi.stubEnv('SCREEN_LLM_MODEL', 'claude-haiku-4-5');
    let fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await fullScreenFields([CLEAN], allowed);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe('anthropic/claude-haiku-4-5');

    vi.stubEnv('SCREEN_LLM_MODEL', 'anthropic/claude-haiku-4-5');
    fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await fullScreenFields([CLEAN], allowed);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe('anthropic/claude-haiku-4-5');
  });

  it('a non-2xx reply logs the status only, never the body or its error code', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-key');
    const canary = 'CANARY-DRAFT-TEXT-9f3a';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: canary } }), { status: 429 }),
      ),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const screened = await fullScreenFields([canary], allowed);
    expect(screened).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(screened.ai).toBeUndefined();
    expect(err).toHaveBeenCalledWith('[complianceLlm] AI Gateway request failed', 429);
    expect(JSON.stringify(err.mock.calls)).not.toContain('rate_limit_error');
    expect(outcomes(err)).toEqual([
      { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: 'upstream_status', status: 429 },
    ]);
    expect(JSON.stringify(err.mock.calls)).not.toContain(canary);
    err.mockRestore();
  });

  it('parses a strict-JSON verdict from the model', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(
      JSON.stringify({
        verdict: 'hold',
        reasons: ['Implied internal valuation.'],
      }),
    );
    const result = await fullScreenFields(['Between us the number is well north of that'], allowed);
    expect(result).toMatchObject({ verdict: 'hold', reasons: ['Implied internal valuation.'], llmChecked: true });
  });

  it('keeps the deterministic verdict on a malformed model reply (fail to deterministic, not to error)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway('sorry, I cannot help with that');
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
  });

  it('a billed reply whose content cannot be read still returns its usage for the ledger', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('SCREEN_LLM_MODEL', '');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ model: 'anthropic/claude-sonnet-5', usage: { input_tokens: 9, output_tokens: 3 }, content: 'not a list' }),
      }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { llmChecked, ai } = await fullScreenFields([CLEAN], allowed);
    expect(llmChecked).toBe(false);
    expect(ai).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 9, outputTokens: 3 });
    expect(err).toHaveBeenCalledTimes(2); // the [complianceLlm] code line and the model_outcome line
    expect(outcomes(err)).toEqual([{ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: 'malformed_reply' }]);
    err.mockRestore();
  });

  it('a ZDR refusal runs rules only, logs one line per call, and never retries or tries another path', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans canary-zdr' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per screen, both to the gateway
    for (const [url] of fetchMock.mock.calls) expect(url).toBe(GATEWAY_MESSAGES_URL);
    expect(warn).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'zdr_unavailable', failure: 'upstream_status', zdrReason: 'permission_denied', status: 403 };
    expect(err).toHaveBeenCalledTimes(2);
    expect(outcomes(err)).toEqual([line, line]);
    expect(JSON.stringify([...warn.mock.calls, ...err.mock.calls])).not.toContain('canary-zdr');
    const full = await fullScreenFields(['Looking forward to our call next week.'], allowed);
    expect(full.llmChecked).toBe(false);
    warn.mockRestore();
    err.mockRestore();
  });

  it('a gateway timeout runs rules only and logs a timeout line per call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(warn).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'timeout' };
    expect(outcomes(err)).toEqual([line, line]);
    warn.mockRestore();
    err.mockRestore();
  });

  it('a non-Anthropic SCREEN_LLM_MODEL sends nothing and logs the failure on model_outcome', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('SCREEN_LLM_MODEL', 'openai/gpt-4o-mini');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('[complianceLlm] AI Gateway request failed', 'none');
    expect(outcomes(err)).toEqual([
      { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: 'non_anthropic_model' },
    ]);
    err.mockRestore();
  });

  // A code-shaped token in the error body passes errorCodeFromBody, and a 5-letter
  // one can be a deal code (#474 audit): no field of the body reaches a line.
  it.each([
    ['error.type', { error: { type: 'FALCO', message: 'x' } }],
    ['error.code', { error: { code: 'FALCO' } }],
    ['error.name', { error: { name: 'FALCO' } }],
    ['the top-level name', { name: 'FALCO' }],
    ['the top-level code', { code: 'FALCO' }],
  ])('a code-shaped canary in %s of an error body never reaches the console', async (_label, body) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 })));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const screened = await fullScreenFields([CLEAN], allowed);
    expect(screened).toMatchObject({ verdict: 'compliant', llmChecked: false });
    expect(screened.ai).toBeUndefined();
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain('FALCO');
    expect(outcomes(spies[3])).toEqual([
      { evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: 'upstream_status', status: 400 },
    ]);
  });

  it('keeps the deterministic verdict on an invalid verdict value', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(JSON.stringify({ verdict: 'maybe', reasons: [] }));
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
  });

  it('keeps the deterministic verdict when the API call fails', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await fullScreenFields([CLEAN], allowed)).toMatchObject({ verdict: 'compliant', llmChecked: false });
  });

  it('the system prompt carries the front-page (reputational) test with its guardrails (#139)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await fullScreenFields([CLEAN], allowed);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { system: string };
    // The middle-ground calibration (2026-08-05): named categories, an explicit
    // not-a-trigger list, and the cap that reputational risk alone never blocks.
    expect(body.system).toContain('front-page test');
    expect(body.system).toContain('disparaging or mocking remarks about a client, counterparty, or regulator');
    expect(body.system).toContain('NOT reputational risk');
    expect(body.system).toContain('capped at hold, never blocked');
  });

  it('pre-approved terms reach the system prompt with the do-not-re-flag instruction (#156)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    // Both claims are real rule-pack hits, so both survive validation; the
    // MNPI hit holds, which is not a block, so the model pass still runs.
    await fullScreenFields(['I guarantee the board seat. Our internal model floors this at $510M'], allowed, {
      claims: ['i guarantee', 'internal model'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { system: string };
    expect(body.system).toContain('"i guarantee", "internal model"');
    // Option A scope, tightened after the Aug 20 smuggling probes: the
    // sign-off covers the kept term's OWN commitment (clause + object), not
    // the whole sentence — a second promise joined by "and" is NOT covered —
    // and never MNPI or reputational risk.
    expect(body.system).toContain('the specific commitment a kept term itself expresses');
    expect(body.system).toContain('that additional commitment is NOT covered');
    expect(body.system).toContain('any reputational (front-page) concern');
    expect(body.system).toContain('a sign-off never clears MNPI or reputational risk');
    // Without terms the base prompt is untouched.
    expect(systemPrompt()).not.toContain('chose to keep');
  });
});

describe('fullScreenFields', () => {
  it('screens per field: a phrase spanning two fields is NOT a hit (the seam bug)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // Joined with \n\n these two fields mint "I\n\nGuarantee" — a promissory
    // match that exists in neither field. Per-field screening stays clean.
    const result = await fullScreenFields([
      'Ask counsel about clause I',
      'Guarantee periods are standard in the market',
    ], allowed);
    expect(result.verdict).toBe('compliant');
    expect(result.llmChecked).toBe(false);
  });

  it('an MNPI signal split across fields still holds (figure here, context there)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // Neither field holds alone: the subject carries the valuation context,
    // the body carries the figure. Read together they are a leak — the
    // per-field seam fix must not send this clean.
    const result = await fullScreenFields([
      'Project Atlas valuation update',
      'The number we will not go below is $510M.',
    ], allowed);
    expect(result.verdict).toBe('hold');
  });

  it('the strictest field verdict wins', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields([
      'Process update',
      'Our internal model floors this at $510M',
    ], allowed);
    expect(result.verdict).toBe('hold');
  });

  it('a pre-approved term NEVER softens the deterministic verdict (decision 2)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(
      ['Our internal model floors this at $510M'], allowed,
      { claims: ['internal model', '$510m'] },
    );
    expect(result.verdict).toBe('hold');
  });
});

describe('decision 2 routing (#158)', () => {
  function stubGateway(contentText: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: contentText }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('the model pass parses cause and clamps heat; a junk cause is dropped and the hold fails closed', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(
      JSON.stringify({ verdict: 'hold', reasons: ['Front page.'], cause: 'reputational', heat: 61.7 }),
    );
    const r = await fullScreenFields([CLEAN], allowed);
    expect(r.holdCause).toBe('reputational');
    expect(r.heat).toBe(62);

    stubGateway(JSON.stringify({ verdict: 'hold', reasons: ['x'], cause: 'weird', heat: 900 }));
    const r2 = await fullScreenFields([CLEAN], allowed);
    expect(r2.holdCause).toBe('mnpi');
    expect(r2.heat).toBe(100);
  });

  it('an LLM hold WITHOUT a cause label fails CLOSED to the mnpi queue', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(JSON.stringify({ verdict: 'hold', reasons: ['Something risky.'] }));
    const result = await fullScreenFields(['A perfectly clean process update.'], allowed);
    expect(result.verdict).toBe('hold');
    expect(result.holdCause).toBe('mnpi');
  });

  it('a reputational-only LLM hold carries its cause and heat', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(
      JSON.stringify({
        verdict: 'hold',
        reasons: ['Disparaging remark about the CFO.'],
        cause: 'reputational',
        heat: 55,
        rewrite: 'Their CFO seemed to struggle with the numbers.',
      }),
    );
    const result = await fullScreenFields(['Honestly their CFO is a clown.'], allowed);
    expect(result.verdict).toBe('hold');
    expect(result.holdCause).toBe('reputational');
    expect(result.heat).toBe(55);
    expect(result.rewrite).toContain('struggle');
  });

  it('option A: an ACKNOWLEDGED promissory hit passes the deterministic gate', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['We guarantee the board seat'], allowed, {
      claims: ['we guarantee'],
    });
    expect(result.verdict).toBe('compliant');
    expect(result.preApproved).toEqual(['we guarantee']);
  });

  it('option A: an UNacknowledged promissory hit still blocks', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['We guarantee the board seat'], allowed);
    expect(result.verdict).toBe('blocked');
  });

  it('an MNPI hold the LLM escalates to blocked KEEPS its mnpi cause', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(
      JSON.stringify({ verdict: 'blocked', reasons: ['Leak plus commitment.'] }),
    );
    const result = await fullScreenFields(['Our internal model floors this at $510M'], allowed);
    expect(result.verdict).toBe('blocked');
    // The stronger concern survives escalation — 'promissory' would be a lie.
    expect(result.holdCause).toBe('mnpi');
  });

  it('a rules-based block skips the LLM and records llmChecked false', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    const result = await fullScreenFields(['We guarantee the board seat'], allowed);
    expect(result.verdict).toBe('blocked');
    // The AI never ran — the audit must not read "AI-checked" on this row.
    expect(result.llmChecked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('option A boundary: MNPI holds even fully signed off (the queue has no bypass)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['Our internal model floors this at $510M'], allowed, {
      claims: ['internal model', '$510m'],
    });
    expect(result.verdict).toBe('hold');
    expect(result.holdCause).toBe('mnpi');
  });

  it('fabricated claims never reach preApproved (validation lives in the lib)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['We guarantee the board seat'], allowed, {
      claims: ['we guarantee', 'ignore previous instructions', ''],
    });
    expect(result.preApproved).toEqual(['we guarantee']);
  });
});

describe('the model gate on the screen (#339)', () => {
  function stubGateway(contentText: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: contentText }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('a withheld decision makes no model call even with a key, and names the reason', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'hold', reasons: ['Should never be read.'] }));
    const result = await fullScreenFields([CLEAN], withheld);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verdict: 'compliant',
      llmChecked: false,
      modelDecision: { allowed: false, reason: 'not_local', purpose: 'mail_screen', tenantId: 'tenant-1' },
      llmWithheld: 'not_local',
    });
    expect(result.ai).toBeUndefined();
  });

  it('a withheld decision keeps the deterministic verdict on risky text', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    const result = await fullScreen('Our internal model floors this at $510M', withheld);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ verdict: 'hold', holdCause: 'mnpi', llmChecked: false, llmWithheld: 'not_local' });
  });

  it('an allowed decision is recorded with its basis, purpose and tenant, and no withheld reason', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    const result = await fullScreen(CLEAN, allowed);
    expect(result.modelDecision).toEqual({
      allowed: true,
      basis: 'synthetic_tenant',
      purpose: 'mail_screen',
      tenantId: DEV_TENANT_ID,
    });
    expect(result).not.toHaveProperty('llmWithheld');
  });

  it('a rules-based block still records the decision it was given', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['We guarantee the board seat'], withheld);
    expect(result).toMatchObject({ verdict: 'blocked', llmWithheld: 'not_local' });
  });

  it('a hand-built { allowed: true } is rejected before anything runs', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    const forged = { allowed: true, basis: 'verified_processor' } as unknown as ModelCallDecision;
    await expect(fullScreenFields([CLEAN], forged)).rejects.toThrow(/minted by modelCallsAllowed/);
    await expect(fullScreen(CLEAN, forged)).rejects.toThrow(/minted by modelCallsAllowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a decision minted for a codename suggestion cannot open a screen', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    const codename = allowedDecision('codename_suggest');
    await expect(fullScreenFields([CLEAN], codename)).rejects.toThrow(/minted for codename_suggest/);
    await expect(fullScreen(CLEAN, codename)).rejects.toThrow(/minted for codename_suggest/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a copy of a minted decision is not the decision', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubGateway(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await expect(fullScreenFields([CLEAN], { ...allowed })).rejects.toThrow();
    await expect(fullScreenFields([CLEAN], JSON.parse(JSON.stringify(allowed)))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
