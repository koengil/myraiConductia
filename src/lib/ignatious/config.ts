// Server-only env for the Ignatious control plane. The browser never sees
// the inbound key — every call goes through /api/v1/deals/.../ignatious.

export const MD_BRIEFING_AGENT = 'md-briefing';
export const MD_BRIEFING_STEP_ID = 'p1-s9';
export const PRESEARCH_AGENT = 'presearch';
export const SOURCE_INTELLIGENCE_AGENT = 'source-intelligence';
export const DIGITAL_TWIN_BUILDER_AGENT = 'digital-twin-builder';
export const DIGITAL_TWIN_AGENT = 'digital-twin';
export const SKILL_STEP_RUN_AGENT = 'skill-step-run';
export const SKILL_RUN_REVISION_AGENT = 'skill-run-revision';

export type IgnatiousConfig = {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  /** When set, every deal maps onto this Conductia lead instead of the deal code. */
  leadIdOverride: string | null;
  /**
   * Skill bench (`/v1/bench`). Locally a second process; on the public API
   * the same hostname as `baseUrl` (ALB splits `/v1` vs `/v1/bench`).
   */
  benchUrl: string;
  /**
   * Public origin Ignatious should call back into (`/v1/leads/...`).
   * Null means we omit `conductiaBaseUrl` and their deployment default wins.
   */
  conductiaBaseUrl: string | null;
};

/**
 * Read a server env var at request time. Next inlines `process.env.FOO` at
 * build; Vercel Sensitive vars (and vars added after a build started) exist
 * only at runtime, so a static read would stay empty on preview.
 */
export function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}

function trimUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function httpsOrigin(value: string | undefined): string | null {
  const host = value?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return host ? `https://${host}` : null;
}

/**
 * Origin Ignatious should call back into.
 *
 * Their allowlist is exact-match (`CONDUCTIA_ALLOWED_BASE_URLS`). A preview
 * `*.vercel.app` host is never on it, and sending one 403s the whole skill.
 * So we only name a target they can actually allow once:
 *
 * 1. `CONDUCTIA_PUBLIC_URL` if set.
 * 2. On a Vercel production deploy, `VERCEL_PROJECT_PRODUCTION_URL`.
 * 3. Otherwise omit the field — they use their deployment default.
 */
export function resolveConductiaPublicUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = trimUrl(env.CONDUCTIA_PUBLIC_URL);
  if (explicit) return explicit;
  if (env.VERCEL_ENV === 'production') {
    return httpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
  }
  return null;
}

export function readIgnatiousConfig(): IgnatiousConfig | null {
  const apiUrl = trimUrl(runtimeEnv('IGNATIOUS_API_URL'));
  const controlUrl = trimUrl(runtimeEnv('IGNATIOUS_CONTROL_PLANE_URL'));
  const benchOverride = trimUrl(runtimeEnv('IGNATIOUS_SKILL_BENCH_URL'));
  const apiKey = runtimeEnv('IGNATIOUS_API_KEY')?.trim();
  const baseUrl = controlUrl || apiUrl;
  if (!baseUrl || !apiKey) return null;
  const leadIdOverride = runtimeEnv('IGNATIOUS_LEAD_ID')?.trim() || null;
  const tenantId = runtimeEnv('IGNATIOUS_TENANT_ID')?.trim() || null;
  const production = runtimeEnv('VERCEL_ENV') === 'production';
  // A global override points every firm's runs at one lead. Refuse it in
  // production rather than let it cross tenants; a preview/dev deploy may
  // still use it to pin a demo run.
  if (leadIdOverride && production) {
    console.error(
      '[ignatious] IGNATIOUS_LEAD_ID is set in production; refusing agent runs (PL-02)',
    );
    return null;
  }
  if (!tenantId && production) {
    console.error(
      '[ignatious] IGNATIOUS_TENANT_ID is not set in production; refusing agent runs (PL-26)',
    );
    return null;
  }
  return {
    baseUrl,
    apiKey,
    tenantId: tenantId ?? 'tn_demo',
    leadIdOverride,
    benchUrl: benchOverride || apiUrl || baseUrl,
    conductiaBaseUrl: resolveConductiaPublicUrl({
      CONDUCTIA_PUBLIC_URL: runtimeEnv('CONDUCTIA_PUBLIC_URL'),
      VERCEL_ENV: runtimeEnv('VERCEL_ENV'),
      VERCEL_PROJECT_PRODUCTION_URL: runtimeEnv('VERCEL_PROJECT_PRODUCTION_URL'),
      VERCEL_URL: runtimeEnv('VERCEL_URL'),
    }),
  };
}

export function leadIdForDeal(config: IgnatiousConfig, deal: { id: string; code: string }): string {
  return config.leadIdOverride ?? deal.code;
}
