// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GATEWAY_PROCESSOR,
  JEV_PROCESSOR,
  SYNTHETIC_MODEL_TENANT_IDS,
  VERIFIED_MODEL_PROCESSORS,
  assertModelDecision,
  evaluateModelPolicy,
  modelCallsAllowed,
  modelDecisionRecord,
  processorFor,
  type ModelPolicy,
} from '@/lib/ai/modelPolicy';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

/*
 * The model gate for the screen and code-name model calls (#339 phase 1, design R11). Rules in
 * order: null tenant first, then a verified processor, then the local and dev
 * checks, then the synthetic list. The rules are exercised through the pure
 * evaluator with injected envs and lists (the injected policy stands in for
 * the PR that would open them); the minter takes neither, so the tests of
 * modelCallsAllowed drive it through process.env alone.
 */

const LOCAL_DEV = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'dev' };
const HOSTED = { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' };
const SHIPPED: ModelPolicy = { verifiedProcessors: VERIFIED_MODEL_PROCESSORS, syntheticTenantIds: SYNTHETIC_MODEL_TENANT_IDS };
const VERIFIED: ModelPolicy = { verifiedProcessors: [GATEWAY_PROCESSOR], syntheticTenantIds: [DEV_TENANT_ID] };
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the shipped constants', () => {
  it('ship the verified list empty and only the DEV tenant as synthetic', () => {
    expect(VERIFIED_MODEL_PROCESSORS).toEqual([]);
    expect(SYNTHETIC_MODEL_TENANT_IDS).toEqual([DEV_TENANT_ID]);
    expect(GATEWAY_PROCESSOR).toBe('vercel-ai-gateway:anthropic');
  });

  it('are frozen, so no module can widen them at run time', () => {
    expect(Object.isFrozen(VERIFIED_MODEL_PROCESSORS)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_MODEL_TENANT_IDS)).toBe(true);
    expect(() => (VERIFIED_MODEL_PROCESSORS as string[]).push(GATEWAY_PROCESSOR)).toThrow();
    expect(() => (SYNTHETIC_MODEL_TENANT_IDS as string[]).push(OTHER_TENANT)).toThrow();
  });
});

describe('evaluateModelPolicy (the rules)', () => {
  it('withholds a null or empty tenant even when the injected policy verifies the processor', () => {
    for (const tenant of [null, '']) {
      expect(evaluateModelPolicy(tenant, LOCAL_DEV, VERIFIED, 'mail_screen')).toEqual({ allowed: false, reason: 'tenant_unresolved' });
    }
  });

  it('a verified processor allows a non-synthetic tenant on a hosted URL, prod included', () => {
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, VERIFIED, 'mail_screen')).toEqual({ allowed: true, basis: 'verified_processor' });
    expect(evaluateModelPolicy(OTHER_TENANT, { ...HOSTED, NEXT_PUBLIC_APP_ENV: 'prod' }, VERIFIED, 'mail_screen').allowed).toBe(true);
  });

  it('a different processor id on the verified list does not open the gateway path', () => {
    const jevOnly: ModelPolicy = { verifiedProcessors: [JEV_PROCESSOR], syntheticTenantIds: [] };
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, jevOnly, 'mail_screen')).toEqual({ allowed: false, reason: 'not_local' });
    // The retired direct id (#505) opens nothing.
    const retired: ModelPolicy = { verifiedProcessors: ['anthropic'], syntheticTenantIds: [] };
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, retired, 'codename_suggest')).toEqual({ allowed: false, reason: 'not_local' });
  });

  it("Jev's second opinion has its own processor id: verifying the gateway's Anthropic path alone withholds it (D87)", () => {
    expect(processorFor('mail_send_second_opinion')).toBe(JEV_PROCESSOR);
    expect(JEV_PROCESSOR).not.toBe(GATEWAY_PROCESSOR);
    for (const purpose of ['mail_send_screen', 'mail_screen', 'codename_suggest', 'screening_eval'] as const) {
      expect(processorFor(purpose), purpose).toBe(GATEWAY_PROCESSOR);
    }
    // VERIFIED lists the gateway's Anthropic path only: every other purpose opens, Jev does not.
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, VERIFIED, 'mail_screen').allowed).toBe(true);
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, VERIFIED, 'mail_send_second_opinion')).toEqual({
      allowed: false,
      reason: 'not_local',
    });
  });

  it("Jev opens on the verified path only with its own id, and that id opens nothing else", () => {
    const jevOnly: ModelPolicy = { verifiedProcessors: [JEV_PROCESSOR], syntheticTenantIds: [] };
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, jevOnly, 'mail_send_second_opinion')).toEqual({
      allowed: true,
      basis: 'verified_processor',
    });
    expect(evaluateModelPolicy(OTHER_TENANT, HOSTED, jevOnly, 'mail_send_screen')).toEqual({
      allowed: false,
      reason: 'not_local',
    });
  });

  it("Jev follows the same synthetic rule as the screen and code-name calls: the DEV tenant on a local dev stack only", () => {
    expect(evaluateModelPolicy(DEV_TENANT_ID, LOCAL_DEV, SHIPPED, 'mail_send_second_opinion')).toEqual({
      allowed: true,
      basis: 'synthetic_tenant',
    });
    expect(evaluateModelPolicy(OTHER_TENANT, LOCAL_DEV, SHIPPED, 'mail_send_second_opinion').allowed).toBe(false);
    expect(evaluateModelPolicy(DEV_TENANT_ID, HOSTED, SHIPPED, 'mail_send_second_opinion').allowed).toBe(false);
  });

  it('allows the DEV tenant on a local stack that says dev', () => {
    for (const url of ['http://127.0.0.1:54321', 'http://localhost:54321']) {
      expect(evaluateModelPolicy(DEV_TENANT_ID, { ...LOCAL_DEV, NEXT_PUBLIC_SUPABASE_URL: url }, SHIPPED, 'mail_screen')).toEqual({
        allowed: true,
        basis: 'synthetic_tenant',
      });
    }
  });

  it('withholds the DEV tenant on a hosted URL, a missing URL and a malformed URL', () => {
    for (const url of [HOSTED.NEXT_PUBLIC_SUPABASE_URL, undefined, 'not a url', 'http://127.0.0.1.example.com']) {
      expect(evaluateModelPolicy(DEV_TENANT_ID, { NEXT_PUBLIC_APP_ENV: 'dev', NEXT_PUBLIC_SUPABASE_URL: url }, SHIPPED, 'mail_screen')).toEqual({
        allowed: false,
        reason: 'not_local',
      });
    }
  });

  it('accepts dev or local in any case and with surrounding whitespace', () => {
    for (const appEnv of ['dev', 'DEV', 'Dev', ' dev ', 'dev\n', 'local', 'LOCAL', ' local ']) {
      expect(evaluateModelPolicy(DEV_TENANT_ID, { ...LOCAL_DEV, NEXT_PUBLIC_APP_ENV: appEnv }, SHIPPED, 'mail_screen'), appEnv).toEqual({
        allowed: true,
        basis: 'synthetic_tenant',
      });
    }
  });

  it('withholds the DEV tenant under prod in any spelling, even on a local URL', () => {
    for (const appEnv of ['prod', 'Prod', 'PROD', 'prod ', ' production', 'Production']) {
      expect(evaluateModelPolicy(DEV_TENANT_ID, { ...LOCAL_DEV, NEXT_PUBLIC_APP_ENV: appEnv }, SHIPPED, 'mail_screen'), appEnv).toEqual({
        allowed: false,
        reason: 'prod',
      });
    }
  });

  it('fails closed when the app env is unset, empty, staging or unrecognized', () => {
    for (const appEnv of [undefined, '', '   ', 'staging', 'test', 'development', 'devel']) {
      expect(evaluateModelPolicy(DEV_TENANT_ID, { ...LOCAL_DEV, NEXT_PUBLIC_APP_ENV: appEnv }, SHIPPED, 'mail_screen'), String(appEnv)).toEqual({
        allowed: false,
        reason: 'not_dev',
      });
    }
  });

  it('withholds an unlisted tenant on a local dev stack', () => {
    expect(evaluateModelPolicy(OTHER_TENANT, LOCAL_DEV, SHIPPED, 'mail_screen')).toEqual({ allowed: false, reason: 'tenant_not_synthetic' });
  });

  it('returns a plain verdict that no entry point accepts', () => {
    const verdict = evaluateModelPolicy(OTHER_TENANT, HOSTED, VERIFIED, 'mail_screen');
    expect(verdict.allowed).toBe(true);
    expect(() => assertModelDecision(verdict, ['mail_screen'])).toThrow(/minted by modelCallsAllowed/);
    expect(() => modelDecisionRecord(verdict as never)).toThrow(/minted by modelCallsAllowed/);
  });
});

describe('modelCallsAllowed (the only minter)', () => {
  it('takes the tenant and the purpose only', () => {
    expect(modelCallsAllowed.length).toBe(2);
  });

  it('reads process.env and the shipped lists', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_DEV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    expect(modelCallsAllowed(DEV_TENANT_ID, 'mail_screen').allowed).toBe(true);
    expect(modelDecisionRecord(modelCallsAllowed(OTHER_TENANT, 'mail_screen'))).toMatchObject({
      allowed: false,
      reason: 'tenant_not_synthetic',
    });
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    expect(modelDecisionRecord(modelCallsAllowed(DEV_TENANT_ID, 'mail_screen'))).toMatchObject({ reason: 'prod' });
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', HOSTED.NEXT_PUBLIC_SUPABASE_URL);
    expect(modelCallsAllowed(DEV_TENANT_ID, 'mail_screen').allowed).toBe(false);
  });

  it('ignores a smuggled env or policy: a caller cannot widen the gate', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', HOSTED.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    const smuggle = modelCallsAllowed as unknown as (...args: unknown[]) => ReturnType<typeof modelCallsAllowed>;
    for (const tenant of [OTHER_TENANT, DEV_TENANT_ID]) {
      const decision = smuggle(tenant, 'mail_send_screen', LOCAL_DEV, VERIFIED);
      expect(decision.allowed, tenant).toBe(false);
      expect(modelDecisionRecord(decision)).toMatchObject({ allowed: false, reason: 'not_local' });
    }
  });

  it('withholds an unresolved tenant first, and records it as null', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_DEV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    for (const tenant of [null, '']) {
      expect(modelDecisionRecord(modelCallsAllowed(tenant, 'mail_send_screen'))).toEqual({
        allowed: false,
        reason: 'tenant_unresolved',
        purpose: 'mail_send_screen',
        tenantId: null,
      });
    }
  });

  it('binds the decision to its purpose and tenant, and the audit record carries both', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_DEV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    expect(modelDecisionRecord(modelCallsAllowed(DEV_TENANT_ID, 'codename_suggest'))).toEqual({
      allowed: true,
      basis: 'synthetic_tenant',
      purpose: 'codename_suggest',
      tenantId: DEV_TENANT_ID,
    });
    expect(modelDecisionRecord(modelCallsAllowed(OTHER_TENANT, 'mail_screen'))).toEqual({
      allowed: false,
      reason: 'tenant_not_synthetic',
      purpose: 'mail_screen',
      tenantId: OTHER_TENANT,
    });
  });
});

describe('a decision is minted only by modelCallsAllowed, for one purpose', () => {
  const mintLocal = (purpose: Parameters<typeof modelCallsAllowed>[1]) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_DEV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    return modelCallsAllowed(DEV_TENANT_ID, purpose);
  };

  it('accepts a minted decision for its own purpose, and the decision is frozen', () => {
    const decision = mintLocal('mail_screen');
    expect(assertModelDecision(decision, ['mail_screen'])).toBe(decision);
    expect(assertModelDecision(decision, ['mail_send_screen', 'mail_screen'])).toBe(decision);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("refuses a second-opinion decision on a screen, and a screen decision on Jev", () => {
    expect(() =>
      assertModelDecision(mintLocal('mail_send_second_opinion'), ['mail_send_screen', 'mail_screen', 'screening_eval']),
    ).toThrow(/minted for mail_send_second_opinion/);
    expect(() => assertModelDecision(mintLocal('mail_send_screen'), ['mail_send_second_opinion'])).toThrow(
      /minted for mail_send_screen/,
    );
    const jev = mintLocal('mail_send_second_opinion');
    expect(assertModelDecision(jev, ['mail_send_second_opinion'])).toBe(jev);
  });

  it('refuses a decision minted for another purpose', () => {
    const codename = mintLocal('codename_suggest');
    expect(() => assertModelDecision(codename, ['mail_send_screen', 'mail_screen', 'screening_eval'])).toThrow(
      /minted for codename_suggest/,
    );
    expect(() => assertModelDecision(mintLocal('mail_screen'), ['codename_suggest'])).toThrow(/minted for mail_screen/);
  });

  it('rejects a hand-built { allowed: true } literal', () => {
    expect(() => assertModelDecision({ allowed: true, basis: 'verified_processor' }, ['mail_screen'])).toThrow(
      /minted by modelCallsAllowed/,
    );
    expect(() => assertModelDecision({ allowed: false, reason: 'tenant_not_synthetic' }, ['mail_screen'])).toThrow();
  });

  it('rejects a spread copy, a JSON round trip and a structured clone of a minted decision', () => {
    const decision = mintLocal('mail_screen');
    expect(() => assertModelDecision({ ...decision }, ['mail_screen'])).toThrow();
    expect(() => assertModelDecision(JSON.parse(JSON.stringify(decision)), ['mail_screen'])).toThrow();
    expect(() => assertModelDecision(structuredClone(decision), ['mail_screen'])).toThrow();
  });

  it('rejects null, undefined and primitives', () => {
    for (const value of [null, undefined, true, 'allowed', 1]) {
      expect(() => assertModelDecision(value, ['mail_screen'])).toThrow();
    }
  });
});
