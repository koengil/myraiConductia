import { describe, expect, it } from 'vitest';

import { costForUsage } from '@/lib/ai/pricing';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import {
  assertProcessorAllowed,
  DEFAULT_EXTRACT_MODEL,
  DISCOVERY_OUTPUT_PLACEMENT_APPROVED,
  GATEWAY_PROCESSOR,
  isSyntheticItem,
  ProcessorRefusedError,
  resolveExtractModel,
  SYNTHETIC_MODEL_TENANT_IDS,
  VERIFIED_MODEL_GRANTS,
  VERIFIED_MODEL_PROCESSORS,
  VERIFIED_MODEL_TENANT_IDS,
} from '@/lib/modelGateway/processorGate';

const LOCAL_SYNTHETIC: Record<string, string | undefined> = {
  DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521',
  NEXT_PUBLIC_APP_ENV: 'local',
};
const PILOT = '11111111-2222-4333-8444-555555555555'; // fake: no real tenant id in any fixture
const OTHER = '99999999-8888-4777-8666-555555555555';
const HOSTED_PROD = {
  DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_APP_ENV: 'prod',
};
const policy = (processor: boolean, placement: boolean, tenant: boolean) => ({
  verifiedProcessors: processor ? [GATEWAY_PROCESSOR] : [],
  outputPlacementApproved: placement,
  verifiedTenantIds: tenant ? [PILOT] : [],
});
const OPEN = policy(true, true, true);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProcessorRefusedError);
    return (err as ProcessorRefusedError).why;
  }
  throw new Error('expected a ProcessorRefusedError');
};

describe('assertProcessorAllowed', () => {
  it('passes a recorded transport for any tenant on loopback, whatever else the environment says', () => {
    for (const tenant of [DEV_TENANT_ID, PILOT, 'any-tenant']) {
      expect(assertProcessorAllowed(tenant, 'recorded', LOCAL_SYNTHETIC), tenant).toBe('recorded');
      expect(assertProcessorAllowed(tenant, 'recorded', { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321', NEXT_PUBLIC_APP_ENV: 'prod' }), tenant).toBe(
        'recorded',
      );
    }
  });

  it('passes a recorded transport off loopback only for a synthetic tenant, even on an open policy', () => {
    expect(assertProcessorAllowed(DEV_TENANT_ID, 'recorded', HOSTED_PROD)).toBe('recorded');
    expect(assertProcessorAllowed(DEV_TENANT_ID, 'recorded', {})).toBe('recorded');
    // A replay misses every real item, and three failures retire it before a verified run could read it.
    for (const env of [HOSTED_PROD, {}]) {
      expect(refusal(() => assertProcessorAllowed(PILOT, 'recorded', env))).toBe('recorded_not_synthetic');
      expect(refusal(() => assertProcessorAllowed(PILOT, 'recorded', env, OPEN))).toBe('recorded_not_synthetic');
    }
  });

  it('refuses a gateway call unless the transport was selected', () => {
    expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, DISCOVERY_EXTRACT_TRANSPORT: undefined }))).toBe(
      'transport_not_selected',
    );
    expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, DISCOVERY_EXTRACT_TRANSPORT: 'recorded' }))).toBe(
      'transport_not_selected',
    );
  });

  it('refuses a hosted database URL, a missing one and a malformed one', () => {
    for (const url of ['https://abc.supabase.co', undefined, 'not a url', 'http://127.0.0.1.evil.example']) {
      expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_SUPABASE_URL: url }))).toBe('not_local');
    }
  });

  it('refuses prod even against a loopback URL', () => {
    expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_APP_ENV: 'prod' }))).toBe('prod');
    for (const appEnv of ['production', 'PROD', ' prod ']) {
      expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_APP_ENV: appEnv })), appEnv).toBe('prod');
    }
    // The shared rule (src/lib/ai/processorRules.ts): an app env that is not dev or local is withheld.
    for (const appEnv of [undefined, '', 'staging', 'test']) {
      expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_APP_ENV: appEnv })), String(appEnv)).toBe('not_dev');
    }
  });

  it('refuses a tenant that is not on the synthetic list', () => {
    expect(refusal(() => assertProcessorAllowed('11111111-1111-4111-8111-111111111111', 'gateway', LOCAL_SYNTHETIC))).toBe(
      'tenant_not_synthetic',
    );
  });

  it('passes the synthetic path on 127.0.0.1 for the dev tenant, and on localhost', () => {
    expect(assertProcessorAllowed(DEV_TENANT_ID, 'gateway', LOCAL_SYNTHETIC)).toBe('synthetic');
    expect(assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' })).toBe('synthetic');
  });

  it('ships the verified path closed on all three counts', () => {
    expect(VERIFIED_MODEL_PROCESSORS).toEqual([]);
    expect(DISCOVERY_OUTPUT_PLACEMENT_APPROVED).toBe(false);
    expect(VERIFIED_MODEL_TENANT_IDS).toEqual([]);
    expect(SYNTHETIC_MODEL_TENANT_IDS).toEqual([DEV_TENANT_ID]);
    expect(Object.isFrozen(VERIFIED_MODEL_GRANTS)).toBe(true);
    expect(refusal(() => assertProcessorAllowed(PILOT, 'gateway', HOSTED_PROD))).toBe('not_local');
  });

  it('opens the sandbox tenant on staging through pair grants without flipping global verified constants', () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://sfiqfmqecormenlfoklc.supabase.co',
      NEXT_PUBLIC_APP_ENV: 'staging',
      DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
    };
    expect(assertProcessorAllowed('d8803681-440f-4d35-be12-9d2ae7ac5ebb', 'gateway', env)).toBe('verified');
    expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', env))).toBe('not_local');
  });

  it('verifies a listed tenant on a hosted prod env only when processor, placement and tenant all hold', () => {
    for (const p of [false, true])
      for (const pl of [false, true])
        for (const t of [false, true]) {
          const label = `processor=${p} placement=${pl} tenant=${t}`;
          if (p && pl && t) expect(assertProcessorAllowed(PILOT, 'gateway', HOSTED_PROD, policy(p, pl, t)), label).toBe('verified');
          else
            expect(refusal(() => assertProcessorAllowed(PILOT, 'gateway', HOSTED_PROD, policy(p, pl, t))), label).toBe(
              p && pl ? 'tenant_not_verified' : 'not_local',
            );
        }
  });

  it('refuses every other tenant once the path is open, and keeps the local synthetic path', () => {
    expect(refusal(() => assertProcessorAllowed(OTHER, 'gateway', HOSTED_PROD, OPEN))).toBe('tenant_not_verified');
    expect(refusal(() => assertProcessorAllowed(DEV_TENANT_ID, 'gateway', HOSTED_PROD, OPEN))).toBe('tenant_not_verified');
    expect(assertProcessorAllowed(DEV_TENANT_ID, 'gateway', LOCAL_SYNTHETIC, OPEN)).toBe('synthetic');
    expect(refusal(() => assertProcessorAllowed(PILOT, 'gateway', { ...HOSTED_PROD, DISCOVERY_EXTRACT_TRANSPORT: 'recorded' }, OPEN))).toBe(
      'transport_not_selected',
    );
  });

  it('sends a listed tenant down the verified path on a local stack too, before the loopback and prod checks', () => {
    // Intended: the verified path is decided by the policy and the tenant, not by where the database runs.
    expect(assertProcessorAllowed(PILOT, 'gateway', LOCAL_SYNTHETIC, OPEN)).toBe('verified');
    expect(assertProcessorAllowed(PILOT, 'gateway', { ...LOCAL_SYNTHETIC, NEXT_PUBLIC_APP_ENV: 'prod' }, OPEN)).toBe('verified');
    // Closed, the same tenant on the same stack is not synthetic.
    expect(refusal(() => assertProcessorAllowed(PILOT, 'gateway', LOCAL_SYNTHETIC))).toBe('tenant_not_synthetic');
  });

  it('refusal reasons are fixed codes, never an id or a URL', () => {
    expect(refusal(() => assertProcessorAllowed(OTHER, 'gateway', HOSTED_PROD, OPEN))).toMatch(/^[a-z_]+$/);
    expect(refusal(() => assertProcessorAllowed(OTHER, 'recorded', HOSTED_PROD))).toMatch(/^[a-z_]+$/);
  });
});

describe('resolveExtractModel', () => {
  it('pins the default', () => {
    expect(resolveExtractModel({})).toBe(DEFAULT_EXTRACT_MODEL);
    expect(DEFAULT_EXTRACT_MODEL).toBe('anthropic/claude-sonnet-5');
  });

  it('accepts an override and trims it', () => {
    expect(resolveExtractModel({ DISCOVERY_EXTRACT_MODEL: ' anthropic/claude-haiku-4-5 ' })).toBe('anthropic/claude-haiku-4-5');
  });

  it('refuses a Fable or Mythos id, whatever its case', () => {
    for (const id of ['anthropic/claude-fable-5-1', 'anthropic/Claude-Mythos-1', 'FABLE']) {
      expect(refusal(() => resolveExtractModel({ DISCOVERY_EXTRACT_MODEL: id }))).toBe('covered_model');
    }
  });

  it('pins the model on the verified path, and checks Covered Models first', () => {
    expect(resolveExtractModel({}, 'verified')).toBe(DEFAULT_EXTRACT_MODEL);
    expect(refusal(() => resolveExtractModel({ DISCOVERY_EXTRACT_MODEL: 'anthropic/claude-haiku-4-5' }, 'verified'))).toBe('model_not_verified');
    expect(refusal(() => resolveExtractModel({ DISCOVERY_EXTRACT_MODEL: 'anthropic/claude-fable-5-1' }, 'verified'))).toBe('covered_model');
    expect(resolveExtractModel({ DISCOVERY_EXTRACT_MODEL: 'anthropic/claude-haiku-4-5' }, 'synthetic')).toBe('anthropic/claude-haiku-4-5');
  });

  it('prices the pinned model, so its usage is never unpriced', () => {
    expect(costForUsage(DEFAULT_EXTRACT_MODEL.replace(/^anthropic\//, ''), { inputTokens: 1, outputTokens: 1 })).not.toBeNull();
  });
});

describe('isSyntheticItem', () => {
  it('knows committed corpus mail and nothing else', () => {
    expect(isSyntheticItem('<kestrel-013@bank.example>')).toBe(true);
    expect(isSyntheticItem('<falcon-001@bank.example>')).toBe(true);
    expect(isSyntheticItem('<invented-001@bank.example>')).toBe(false);
    expect(isSyntheticItem('')).toBe(false);
  });
});
