// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  evaluateModelPolicy,
  GATEWAY_PROCESSOR,
  modelCallsAllowed,
  type ModelPolicy,
  type ModelPurpose,
} from '@/lib/ai/modelPolicy';
import {
  grantFor,
  httpsOriginHostOf,
  SYNTHETIC_MODEL_TENANT_IDS,
  VERIFIED_MODEL_GRANTS,
  VERIFIED_MODEL_PROCESSORS,
} from '@/lib/ai/processorRules';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { proposalGate } from '@/lib/discovery/propose/gate';
import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import {
  assertProcessorAllowed,
  DISCOVERY_OUTPUT_PLACEMENT_APPROVED,
  resolveExtractModel,
} from '@/lib/modelGateway/processorGate';

const SANDBOX = 'd8803681-440f-4d35-be12-9d2ae7ac5ebb';
const STAGING_HOST = 'sfiqfmqecormenlfoklc.supabase.co';
const PROD_HOST = 'fsaucpwponmzajupvsey.supabase.co';
const DEV_HOST = 'sqyjqdjazefceixkjtdp.supabase.co';
const OTHER = '99999999-8888-4777-8666-555555555555';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stagingEnv = (over: Record<string, string | undefined> = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_HOST}`,
  NEXT_PUBLIC_APP_ENV: 'staging',
  DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
  DISCOVERY_PROPOSE_TRANSPORT: 'gateway',
  ...over,
});

const SHIPPED: ModelPolicy = { verifiedProcessors: VERIFIED_MODEL_PROCESSORS, syntheticTenantIds: SYNTHETIC_MODEL_TENANT_IDS };

/** Verdicts for tenants with no grant must match develop's closed gate. */
const UNGRANTED_CASES: [string, Record<string, string | undefined>, ModelPurpose][] = [
  ['DEV on local dev', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'dev' }, 'mail_screen'],
  ['DEV on hosted', { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co', NEXT_PUBLIC_APP_ENV: 'dev' }, 'mail_screen'],
  ['OTHER on local dev', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'dev' }, 'mail_screen'],
  ['OTHER on hosted', { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' }, 'codename_suggest'],
  ['DEV on staging host', stagingEnv(), 'mail_screen'],
  ['OTHER on staging host', stagingEnv(), 'codename_suggest'],
];

describe('VERIFIED_MODEL_GRANTS ship closed by default', () => {
  it('keeps global verified constants empty and placement unapproved', () => {
    expect(VERIFIED_MODEL_PROCESSORS).toEqual([]);
    expect(DISCOVERY_OUTPUT_PLACEMENT_APPROVED).toBe(false);
    expect(Object.isFrozen(VERIFIED_MODEL_GRANTS)).toBe(true);
  });

  it('lists every grant tenant as a uuid and never names the prod Supabase host', () => {
    for (const grant of VERIFIED_MODEL_GRANTS) {
      expect(grant.tenantId).toMatch(UUID_RE);
      expect(grant.host).not.toBe(PROD_HOST);
    }
  });

  it('rejects a prod host in the grant table at test time', () => {
    expect(VERIFIED_MODEL_GRANTS.some((g) => g.host === PROD_HOST)).toBe(false);
  });
});

describe('grantFor matches the sandbox tenant on staging only', () => {
  const surfaces = ['extract', 'propose', 'screen', 'codename'] as const;

  it.each(surfaces)('opens %s on the exact staging origin with app env staging', (surface) => {
    expect(grantFor(SANDBOX, stagingEnv(), surface)?.label).toBe('sandbox-staging');
  });

  it.each([
    ['prod project url', { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_HOST}`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['dev project url', { NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_HOST}`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['loopback with staging app env', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['staging host with prod app env', { NEXT_PUBLIC_APP_ENV: 'prod' }],
    ['staging host with missing app env', { NEXT_PUBLIC_APP_ENV: undefined }],
    ['http scheme', { NEXT_PUBLIC_SUPABASE_URL: `http://${STAGING_HOST}`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['non-default port', { NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_HOST}:8443`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['userinfo', { NEXT_PUBLIC_SUPABASE_URL: `https://user:pass@${STAGING_HOST}`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['lookalike suffix', { NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_HOST}.evil.example`, NEXT_PUBLIC_APP_ENV: 'staging' }],
    ['missing url', { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_APP_ENV: 'staging' }],
  ])('closes extract when %s', (_label, over) => {
    expect(grantFor(SANDBOX, stagingEnv(over), 'extract')).toBeNull();
  });

  it('httpsOriginHostOf enforces exact https origins', () => {
    expect(httpsOriginHostOf(`https://${STAGING_HOST}`)).toBe(STAGING_HOST);
    expect(httpsOriginHostOf(`http://${STAGING_HOST}`)).toBeNull();
    expect(httpsOriginHostOf(`https://${STAGING_HOST}:8443`)).toBeNull();
    expect(httpsOriginHostOf(`https://x@${STAGING_HOST}`)).toBeNull();
  });
});

describe('gates honor pair grants before the synthetic refusal', () => {
  it('extracts on the verified path for the sandbox tenant on staging', () => {
    expect(assertProcessorAllowed(SANDBOX, 'gateway', stagingEnv())).toBe('verified');
    expect(resolveExtractModel(stagingEnv(), 'verified')).toBe('anthropic/claude-sonnet-5');
  });

  it('proposes when every lock including grant propose is open', () => {
    expect(proposalGate({ tenantId: SANDBOX, transportKind: 'gateway', flagOn: true, env: stagingEnv() })).toEqual({
      ok: true,
      path: 'verified',
      model: PROPOSAL_MODEL,
    });
  });

  it('screens and suggests codenames through verified_tenant on staging', () => {
    for (const purpose of ['mail_screen', 'codename_suggest'] as const) {
      expect(evaluateModelPolicy(SANDBOX, stagingEnv(), SHIPPED, purpose)).toEqual({
        allowed: true,
        basis: 'verified_tenant',
      });
    }
  });

  it('refuses every other tenant on the staging host with the same codes as today', () => {
    for (const tenant of [DEV_TENANT_ID, OTHER]) {
      expect(() => assertProcessorAllowed(tenant, 'gateway', stagingEnv())).toThrow(/processor_not_verified: not_local/);
      expect(proposalGate({ tenantId: tenant, transportKind: 'gateway', flagOn: true, env: stagingEnv() })).toEqual({
        ok: false,
        code: 'not_local',
      });
      expect(evaluateModelPolicy(tenant, stagingEnv(), SHIPPED, 'mail_screen')).toEqual({
        allowed: false,
        reason: 'not_local',
      });
    }
  });

  it('refuses every tenant on the prod host, sandbox included', () => {
    const prod = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_HOST}`,
      NEXT_PUBLIC_APP_ENV: 'prod',
      DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
      DISCOVERY_PROPOSE_TRANSPORT: 'gateway',
    };
    for (const tenant of [SANDBOX, DEV_TENANT_ID, OTHER]) {
      expect(() => assertProcessorAllowed(tenant, 'gateway', prod)).toThrow(/processor_not_verified: not_local/);
      expect(evaluateModelPolicy(tenant, prod, SHIPPED, 'mail_screen')).toEqual({ allowed: false, reason: 'not_local' });
    }
  });
});

describe('ungranted tenants keep develop modelPolicy verdicts', () => {
  it.each(UNGRANTED_CASES)('%s', (_label, env, purpose) => {
    const tenant = _label.startsWith('OTHER') ? OTHER : DEV_TENANT_ID;
    const expected =
      purpose === 'codename_suggest' && _label.includes('hosted')
        ? { allowed: false, reason: 'not_local' as const }
        : _label.includes('OTHER on local')
          ? { allowed: false, reason: 'tenant_not_synthetic' as const }
          : _label.includes('hosted') || _label.includes('staging host')
            ? { allowed: false, reason: 'not_local' as const }
            : { allowed: true, basis: 'synthetic_tenant' as const };
    expect(evaluateModelPolicy(tenant, env, SHIPPED, purpose)).toEqual(expected);
  });

  it('does not open verified_processor on the shipped lists alone', () => {
    expect(SHIPPED.verifiedProcessors.includes(GATEWAY_PROCESSOR)).toBe(false);
    expect(modelCallsAllowed.length).toBe(2);
  });
});
