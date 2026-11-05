import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMissingSupabaseEnvVars } from '@/lib/supabase/config';
import { GET } from '@/app/api/health/supabase/route';
import { __resetWarnOnceForTests } from '@/lib/modelGateway/gatewayClient';
import {
  SUPABASE_TEST_PROJECT,
  clearSupabaseEnv,
  setSupabaseEnv,
} from './helpers/supabase-env';

describe('GET /api/health/supabase', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearSupabaseEnv();
  });

  it('returns 503 when Supabase is not configured', async () => {
    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      configured: false,
      missing: getMissingSupabaseEnvVars(),
    });
  });

  it('returns auth health when Supabase is configured', async () => {
    setSupabaseEnv({
      url: SUPABASE_TEST_PROJECT.url,
      publishableKey: SUPABASE_TEST_PROJECT.publishableKey,
      environment: 'dev',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { name: 'GoTrue', version: SUPABASE_TEST_PROJECT.authHealthVersion },
          { status: 200 },
        ),
      ),
    );

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      environment: 'dev',
      projectUrl: SUPABASE_TEST_PROJECT.url,
      checks: {
        auth: {
          ok: true,
          status: 200,
          version: SUPABASE_TEST_PROJECT.authHealthVersion,
        },
        admin: {
          ok: false,
          error: 'SUPABASE_SECRET_KEY is not set',
        },
      },
      secretKeyConfigured: false,
      secretKeyValid: false,
    });
  });

  it('reports when the secret key is present but PostgREST rejects it', async () => {
    setSupabaseEnv({
      url: SUPABASE_TEST_PROJECT.url,
      publishableKey: SUPABASE_TEST_PROJECT.publishableKey,
      secretKey: SUPABASE_TEST_PROJECT.secretKey,
      environment: 'dev',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/v1/health')) {
          return Response.json(
            { name: 'GoTrue', version: SUPABASE_TEST_PROJECT.authHealthVersion },
            { status: 200 },
          );
        }
        return Response.json({ message: 'Invalid API key' }, { status: 401 });
      }),
    );

    const body = await (await GET()).json();
    expect(body).toMatchObject({
      ok: true,
      secretKeyConfigured: true,
      secretKeyValid: false,
      checks: {
        admin: { ok: false, error: 'Invalid API key' },
      },
    });
  });

  describe('the AI Gateway key (#505-2)', () => {
    const authUp = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ name: 'GoTrue', version: SUPABASE_TEST_PROJECT.authHealthVersion }, { status: 200 })),
      );
    const configure = (environment: 'dev' | 'staging' | 'prod', key: string) => {
      setSupabaseEnv({ url: SUPABASE_TEST_PROJECT.url, publishableKey: SUPABASE_TEST_PROJECT.publishableKey, environment });
      vi.stubEnv('AI_GATEWAY_API_KEY', key);
      authUp();
      __resetWarnOnceForTests();
    };

    it('fails production readiness without the key, and says why once in the log', async () => {
      configure('prod', '');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
      await GET();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('AI_GATEWAY_API_KEY is missing in prod');
      warn.mockRestore();
    });

    it('treats a blank key as missing in production', async () => {
      configure('prod', '   ');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await GET()).status).toBe(503);
    });

    it('is ready in production with the key', async () => {
      configure('prod', 'gw-key');
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it.each(['staging', 'dev'] as const)('stays ready on %s without the key (the rules-only fallback)', async (environment) => {
      configure(environment, '');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await GET();
      expect(res.status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
      if (environment === 'dev') expect(await res.json()).toMatchObject({ ok: true, aiGatewayKeyConfigured: false });
      warn.mockRestore();
    });
  });
});
