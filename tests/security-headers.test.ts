// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CSP is built when next.config.ts is evaluated, so each case stubs the
 * environment and re-imports the config the way Next does, then reads the
 * headers() it would serve. The exact value is pinned on purpose: widening the
 * policy has to show up as a failing test (docs/04-operations/csp-runbook.md,
 * "Changing the policy").
 */
async function headersFor(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(name, '');
    else vi.stubEnv(name, value);
  }
  const { default: config } = await import('../next.config');
  const rules = await config.headers!();
  const rule = rules.find((r) => r.source === '/:path*');
  if (!rule) throw new Error('no /:path* header rule');
  return new Map(rule.headers.map((h) => [h.key, h.value]));
}

const SUPABASE = 'http://127.0.0.1:54321';

const csp = (connectSrc: string, scriptSrc = "script-src 'self' 'unsafe-inline'") =>
  [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    connectSrc,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

describe('security headers (next.config.ts)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('serves the exact enforced policy with the Supabase origin and keeps the existing headers', async () => {
    const headers = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: undefined });
    expect(headers.get('Content-Security-Policy')).toBe(csp(`connect-src 'self' ${SUPABASE}`));
    expect(headers.has('Content-Security-Policy-Report-Only')).toBe(false);
    expect(headers.get('X-DNS-Prefetch-Control')).toBe('off');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('keeps only the origin of the Supabase URL, port included, and drops any path', async () => {
    const headers = await headersFor({
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co/rest/v1?x=1',
      CSP_REPORT_ONLY: undefined,
    });
    expect(headers.get('Content-Security-Policy')).toContain("connect-src 'self' https://abcd.supabase.co;");
  });

  it('switches to the report-only header name with the same value when CSP_REPORT_ONLY=1', async () => {
    const enforced = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: undefined });
    const reportOnly = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: '1' });
    expect(reportOnly.has('Content-Security-Policy')).toBe(false);
    expect(reportOnly.get('Content-Security-Policy-Report-Only')).toBe(enforced.get('Content-Security-Policy'));
  });

  it('enforces for any other CSP_REPORT_ONLY value', async () => {
    const headers = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: '0' });
    expect(headers.has('Content-Security-Policy')).toBe(true);
    expect(headers.has('Content-Security-Policy-Report-Only')).toBe(false);
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['not a URL', 'not-a-url'],
  ])("limits connect-src to 'self' when the Supabase URL is %s", async (_, url) => {
    const headers = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: url, CSP_REPORT_ONLY: undefined });
    expect(headers.get('Content-Security-Policy')).toBe(csp("connect-src 'self'"));
  });

  it("adds 'unsafe-eval' to script-src in development only", async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const dev = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: undefined });
    expect(dev.get('Content-Security-Policy')).toBe(
      csp(`connect-src 'self' ${SUPABASE}`, "script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
    );
    vi.stubEnv('NODE_ENV', 'production');
    const prod = await headersFor({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE, CSP_REPORT_ONLY: undefined });
    expect(prod.get('Content-Security-Policy')).not.toContain('unsafe-eval');
  });
});
