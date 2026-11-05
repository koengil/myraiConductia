// @vitest-environment node
import { execFile, type ExecFileException } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/csp-smoke.sh against a local server whose CSP header each case sets.
 * The script is the deployed-environment check from the CSP runbook, so a build
 * carrying the wrong Supabase origin in connect-src must fail it, not pass.
 */

const SUPABASE = 'https://right-ref.supabase.co';

const policy = (connectSrc: string, imgSrc = "img-src 'self' data:") =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    imgSrc,
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
  ].join('; ');

let header: { name: string; value: string } | null = null;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    if (header) res.setHeader(header.name, header.value);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Runs the script with a scrubbed env, so a profile's Supabase URL never leaks in. */
function smoke(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      'bash',
      ['scripts/csp-smoke.sh', ...args],
      { encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env } },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

describe('csp-smoke.sh', () => {
  it('passes when connect-src is exactly self plus the expected origin', async () => {
    header = { name: 'Content-Security-Policy', value: policy(`'self' ${SUPABASE}`) };
    const { code, out } = await smoke([base, SUPABASE]);
    expect(out).toContain('result: enforced');
    expect(code).toBe(0);
  });

  it('normalizes the expected origin (path, trailing slash, case)', async () => {
    header = { name: 'Content-Security-Policy', value: policy(`'self' ${SUPABASE}`) };
    const { code } = await smoke([base, 'HTTPS://Right-Ref.supabase.co/rest/v1/']);
    expect(code).toBe(0);
  });

  it(`fails when connect-src carries another environment's Supabase origin`, async () => {
    header = { name: 'Content-Security-Policy', value: policy("'self' https://wrong-ref.supabase.co") };
    const { code, out } = await smoke([base, SUPABASE]);
    expect(out).toContain('result: FAIL');
    expect(out).toContain('wrong-ref.supabase.co');
    expect(code).toBe(1);
  });

  it('fails when connect-src has an extra origin or none besides self', async () => {
    header = {
      name: 'Content-Security-Policy',
      value: policy(`'self' ${SUPABASE} https://extra.example`),
    };
    expect((await smoke([base, SUPABASE])).code).toBe(1);
    header = { name: 'Content-Security-Policy', value: policy("'self'") };
    expect((await smoke([base, SUPABASE])).code).toBe(1);
  });

  it('falls back to NEXT_PUBLIC_SUPABASE_URL and says so', async () => {
    header = { name: 'Content-Security-Policy', value: policy("'self' https://wrong-ref.supabase.co") };
    const { code, out } = await smoke([base], { NEXT_PUBLIC_SUPABASE_URL: SUPABASE });
    expect(out).toContain('from NEXT_PUBLIC_SUPABASE_URL');
    expect(code).toBe(1);
  });

  it('reports report-only, and exits 0 when its policy is right', async () => {
    header = { name: 'Content-Security-Policy-Report-Only', value: policy(`'self' ${SUPABASE}`) };
    const { code, out } = await smoke([base, SUPABASE]);
    expect(out).toContain('result: report-only');
    expect(code).toBe(0);
  });

  it('fails when the header is missing or a key directive is weak', async () => {
    header = null;
    expect((await smoke([base, SUPABASE])).out).toContain('MISSING');
    header = { name: 'Content-Security-Policy', value: policy(`'self' ${SUPABASE}`, 'img-src *') };
    expect((await smoke([base, SUPABASE])).code).toBe(1);
  });

  it('skips the origin comparison on a loopback target with no expected origin', async () => {
    header = { name: 'Content-Security-Policy', value: policy("'self' http://127.0.0.1:54321") };
    const { code, out } = await smoke([base]);
    expect(out).toContain('not checked (loopback target');
    expect(code).toBe(0);
  });
});
