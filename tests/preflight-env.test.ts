import { describe, expect, it } from 'vitest';
import { checkIgnatiousEnv, checkMailEnv } from '../scripts/preflight-env';

const failures = (env: Parameters<typeof checkMailEnv>[0]) =>
  checkMailEnv(env)
    .filter((c) => !c.ok)
    .map((c) => c.problem ?? c.label)
    .join('\n');

const deliverable = {
  NEXT_PUBLIC_APP_ENV: 'prod',
  NEXT_PUBLIC_APP_URL: 'https://app.conductia.com',
  RESEND_FROM: 'Conductia <info@conductia.com>',
  EMAIL_FROM: 'Conductia <info@conductia.com>',
  RESEND_API_KEY: 're_live',
  EMAIL_PROVIDER: 'resend',
};

describe('mail preflight', () => {
  it('passes an environment that can reach real recipients', () => {
    expect(checkMailEnv(deliverable).every((c) => c.ok)).toBe(true);
  });

  it('fails when RESEND_FROM is unset', () => {
    expect(failures({ ...deliverable, RESEND_FROM: '' })).toMatch(/RESEND_FROM is not set/);
  });

  it('fails when EMAIL_FROM is still the resend.dev sandbox sender', () => {
    expect(
      failures({ ...deliverable, EMAIL_FROM: 'Conductia <onboarding@resend.dev>' }),
    ).toMatch(/EMAIL_FROM is the onboarding@resend\.dev sandbox sender/);
  });

  it('fails when the API key is missing and noop was never opted into', () => {
    expect(failures({ ...deliverable, RESEND_API_KEY: '', EMAIL_PROVIDER: '' })).toMatch(
      /RESEND_API_KEY is not set/,
    );
  });

  it('accepts a missing API key when EMAIL_PROVIDER=noop declares the simulation', () => {
    expect(failures({ ...deliverable, RESEND_API_KEY: '', EMAIL_PROVIDER: 'noop' })).toBe('');
  });

  it('fails when the deployed invite origin is unset', () => {
    expect(failures({ ...deliverable, NEXT_PUBLIC_APP_URL: '' })).toMatch(
      /NEXT_PUBLIC_APP_URL is not set/,
    );
  });

  it('tolerates an unset origin in dev, where the request origin is correct', () => {
    expect(
      failures({ ...deliverable, NEXT_PUBLIC_APP_ENV: 'dev', NEXT_PUBLIC_APP_URL: '' }),
    ).toBe('');
  });

  it('fails on an origin that is not an absolute URL', () => {
    expect(failures({ ...deliverable, NEXT_PUBLIC_APP_URL: 'app.conductia.com' })).toMatch(
      /not an absolute URL/,
    );
  });
});

const ignatiousFailures = (env: Parameters<typeof checkIgnatiousEnv>[0]) =>
  checkIgnatiousEnv(env)
    .filter((c) => !c.ok)
    .map((c) => c.problem ?? c.label)
    .join('\n');

const productionAgents = {
  VERCEL_ENV: 'production',
  NEXT_PUBLIC_APP_ENV: 'prod',
  IGNATIOUS_API_URL: 'https://api.conductia-prototype.com',
  IGNATIOUS_CONTROL_PLANE_URL: 'https://api.conductia-prototype.com',
  IGNATIOUS_TENANT_ID: 'tn_demo',
  CONDUCTIA_PUBLIC_URL: 'https://app.conductia.com',
};

describe('Ignatious preflight', () => {
  it('passes the production configuration with the tenant set explicitly', () => {
    expect(ignatiousFailures(productionAgents)).toBe('');
  });

  it('fails a base URL that already ends in /v1', () => {
    expect(
      ignatiousFailures({
        ...productionAgents,
        IGNATIOUS_CONTROL_PLANE_URL: 'https://api.conductia-prototype.com/v1/',
      }),
    ).toMatch(/IGNATIOUS_CONTROL_PLANE_URL .* ends in \/v1/);
  });

  it('fails a callback origin that ends in /v1', () => {
    expect(
      ignatiousFailures({ ...productionAgents, CONDUCTIA_PUBLIC_URL: 'https://app.conductia.com/v1' }),
    ).toMatch(/CONDUCTIA_PUBLIC_URL .* ends in \/v1/);
  });

  it('fails a URL that is not absolute', () => {
    expect(
      ignatiousFailures({ ...productionAgents, IGNATIOUS_API_URL: 'api.conductia-prototype.com' }),
    ).toMatch(/IGNATIOUS_API_URL .* is not an absolute URL/);
  });

  it('fails plain http to a remote host', () => {
    expect(
      ignatiousFailures({
        ...productionAgents,
        IGNATIOUS_SKILL_BENCH_URL: 'http://bench.conductia-prototype.com',
      }),
    ).toMatch(/IGNATIOUS_SKILL_BENCH_URL .* is not https/);
  });

  it('fails a URL that carries a query string', () => {
    expect(
      ignatiousFailures({
        ...productionAgents,
        IGNATIOUS_API_URL: 'https://api.conductia-prototype.com?tenant=tn_demo',
      }),
    ).toMatch(/IGNATIOUS_API_URL .* carries credentials, a query or a fragment/);
  });

  it('accepts plain http to the local services', () => {
    expect(
      ignatiousFailures({
        NEXT_PUBLIC_APP_ENV: 'dev',
        IGNATIOUS_CONTROL_PLANE_URL: 'http://localhost:4111',
        IGNATIOUS_SKILL_BENCH_URL: 'http://127.0.0.1:4212',
        CONDUCTIA_PUBLIC_URL: 'http://localhost:3000',
      }),
    ).toBe('');
  });

  it('fails production when the tenant is not set', () => {
    expect(ignatiousFailures({ ...productionAgents, IGNATIOUS_TENANT_ID: '' })).toMatch(
      /IGNATIOUS_TENANT_ID is not set in production/,
    );
  });

  it('treats NEXT_PUBLIC_APP_ENV=prod as production when VERCEL_ENV is absent', () => {
    expect(
      ignatiousFailures({ ...productionAgents, VERCEL_ENV: '', IGNATIOUS_TENANT_ID: '' }),
    ).toMatch(/IGNATIOUS_TENANT_ID is not set in production/);
  });

  it('treats VERCEL_ENV=production as production whatever NEXT_PUBLIC_APP_ENV says', () => {
    expect(
      ignatiousFailures({ ...productionAgents, NEXT_PUBLIC_APP_ENV: 'dev', IGNATIOUS_TENANT_ID: '' }),
    ).toMatch(/IGNATIOUS_TENANT_ID is not set in production/);
  });

  it('fails production when IGNATIOUS_LEAD_ID is set', () => {
    expect(ignatiousFailures({ ...productionAgents, IGNATIOUS_LEAD_ID: 'lead_halyard_demo' })).toMatch(
      /IGNATIOUS_LEAD_ID is set in production/,
    );
  });

  it('allows a missing tenant and a lead override on a preview deploy', () => {
    expect(
      ignatiousFailures({
        ...productionAgents,
        VERCEL_ENV: 'preview',
        NEXT_PUBLIC_APP_ENV: 'dev',
        IGNATIOUS_TENANT_ID: '',
        IGNATIOUS_LEAD_ID: 'lead_halyard_demo',
      }),
    ).toBe('');
  });

  it('does not require a tenant when production runs no agents', () => {
    expect(
      ignatiousFailures({ VERCEL_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'prod' }),
    ).toBe('');
  });

  it('fails when the publication token is set without an explicit skill bench URL', () => {
    expect(
      ignatiousFailures({ ...productionAgents, IGNATIOUS_PUBLICATION_SERVICE_TOKEN: 'token' }),
    ).toContain('IGNATIOUS_SKILL_BENCH_URL is not set');
    expect(
      ignatiousFailures({
        ...productionAgents,
        IGNATIOUS_PUBLICATION_SERVICE_TOKEN: 'token',
        IGNATIOUS_SKILL_BENCH_URL: 'https://api.conductia-prototype.com',
      }),
    ).toBe('');
  });
});
