import { getSupabaseAdminCredentials, getSupabaseConfig } from './config';

export type SupabaseHealthCheck = {
  ok: boolean;
  status: number;
  latencyMs: number;
  version?: string;
  error?: string;
};

type GoTrueHealthResponse = {
  name?: string;
  version?: string;
};

export async function checkSupabaseAuthHealth(): Promise<SupabaseHealthCheck> {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      ok: false,
      status: 503,
      latencyMs: 0,
      error: 'Supabase is not configured',
    };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(`${config.url}/auth/v1/health`, {
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${config.publishableKey}`,
      },
      cache: 'no-store',
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: `Auth health returned ${response.status}`,
      };
    }

    const body = (await response.json()) as GoTrueHealthResponse;

    return {
      ok: true,
      status: response.status,
      latencyMs,
      version: body.version,
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown Supabase health error',
    };
  }
}

/** Can the server secret actually talk to PostgREST? Presence alone is not enough. */
export async function checkSupabaseSecretHealth(): Promise<SupabaseHealthCheck> {
  const creds = getSupabaseAdminCredentials();
  if (!creds) {
    return {
      ok: false,
      status: 503,
      latencyMs: 0,
      error: 'SUPABASE_SECRET_KEY is not set',
    };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(`${creds.url}/rest/v1/users?select=id&limit=0`, {
      headers: {
        apikey: creds.secretKey,
        Authorization: `Bearer ${creds.secretKey}`,
      },
      cache: 'no-store',
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: body?.message || `Secret key probe returned ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      latencyMs,
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown Supabase secret-key error',
    };
  }
}
