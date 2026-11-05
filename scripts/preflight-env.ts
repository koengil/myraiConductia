import { execFileSync } from 'node:child_process';

import { SENDER_REMEDY, senderProblem, type SenderVariable } from '../src/lib/email/sender';

const MAIL_VARS = [
  'NEXT_PUBLIC_APP_ENV',
  'NEXT_PUBLIC_APP_URL',
  'RESEND_FROM',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'EMAIL_PROVIDER',
] as const;

const IGNATIOUS_URL_VARS = [
  'IGNATIOUS_CONTROL_PLANE_URL',
  'IGNATIOUS_API_URL',
  'IGNATIOUS_SKILL_BENCH_URL',
  'CONDUCTIA_PUBLIC_URL',
] as const;

const IGNATIOUS_VARS = [
  ...IGNATIOUS_URL_VARS,
  'IGNATIOUS_TENANT_ID',
  'IGNATIOUS_LEAD_ID',
  'IGNATIOUS_PUBLICATION_SERVICE_TOKEN',
  'NEXT_PUBLIC_APP_ENV',
  'VERCEL_ENV',
] as const;

const READ_VARS = [...new Set([...MAIL_VARS, ...IGNATIOUS_VARS])];

type MailEnv = Partial<Record<(typeof MAIL_VARS)[number], string>>;
type IgnatiousEnv = Partial<Record<(typeof IGNATIOUS_VARS)[number], string>>;
type PreflightEnv = MailEnv & IgnatiousEnv;

export type Check = { ok: boolean; label: string; problem?: string };

function senderCheck(variable: SenderVariable, env: MailEnv): Check {
  const problem = senderProblem(variable, env[variable]);
  return problem
    ? { ok: false, label: `${variable} — ${problem}`, problem: `${problem}. ${SENDER_REMEDY}` }
    : { ok: true, label: `${variable} — ${env[variable]?.trim()}` };
}

export function checkMailEnv(env: MailEnv): Check[] {
  const checks: Check[] = [senderCheck('RESEND_FROM', env), senderCheck('EMAIL_FROM', env)];

  const provider = env.EMAIL_PROVIDER?.trim();
  const apiKey = env.RESEND_API_KEY?.trim();
  if (provider === 'noop') {
    checks.push({ ok: true, label: 'EMAIL_PROVIDER — noop, the outbox is deliberately simulated' });
  } else if (!apiKey) {
    const problem =
      'RESEND_API_KEY is not set and EMAIL_PROVIDER is not the explicit opt-in \'noop\'';
    checks.push({
      ok: false,
      label: `RESEND_API_KEY — ${problem}`,
      problem: `${problem}, so the transport silently resolves to noop: send() returns a simulated receipt while the audit row reads as sent. Set RESEND_API_KEY, or set EMAIL_PROVIDER=noop to declare the simulation on purpose.`,
    });
  } else {
    checks.push({ ok: true, label: `RESEND_API_KEY — set, provider ${provider ?? 'resend'}` });
  }

  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim();
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) {
    try {
      checks.push({ ok: true, label: `NEXT_PUBLIC_APP_URL — ${new URL(appUrl).origin}` });
    } catch {
      checks.push({
        ok: false,
        label: `NEXT_PUBLIC_APP_URL — ${appUrl} is not an absolute URL`,
        problem: `NEXT_PUBLIC_APP_URL (${appUrl}) is not an absolute URL, so every invite link build throws. Use a full origin, e.g. https://app.conductia.com.`,
      });
    }
  } else if (appEnv === 'dev') {
    checks.push({ ok: true, label: 'NEXT_PUBLIC_APP_URL — unset, dev falls back to the request origin' });
  } else {
    checks.push({
      ok: false,
      label: 'NEXT_PUBLIC_APP_URL — is not set',
      problem:
        'NEXT_PUBLIC_APP_URL is not set, so the invite link origin falls back to the origin of the incoming request. A script or proxy calling the API on a different host mints links pointing at that host. Set it to the deployment origin, and allowlist that origin in Supabase Authentication -> URL Configuration.',
    });
  }

  return checks;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function ignatiousUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return 'is not https';
  }
  if (url.username || url.password || url.search || url.hash) {
    return 'carries credentials, a query or a fragment';
  }
  if (/\/v1$/i.test(url.pathname.replace(/\/+$/, ''))) {
    return 'ends in /v1, and every client path already starts with /v1, so requests reach /v1/v1';
  }
  return null;
}

function isProduction(env: IgnatiousEnv): boolean {
  return env.VERCEL_ENV?.trim() === 'production' || env.NEXT_PUBLIC_APP_ENV?.trim() === 'prod';
}

export function checkIgnatiousEnv(env: IgnatiousEnv): Check[] {
  const checks: Check[] = [];

  for (const variable of IGNATIOUS_URL_VARS) {
    const value = env[variable]?.trim();
    if (!value) continue;
    const problem = ignatiousUrlProblem(value);
    checks.push(
      problem
        ? {
            ok: false,
            label: `${variable} — ${problem}`,
            problem: `${variable} (${value}) ${problem}. Use an absolute https origin with no trailing /v1.`,
          }
        : { ok: true, label: `${variable} — ${value}` },
    );
  }

  const configured = Boolean(
    env.IGNATIOUS_CONTROL_PLANE_URL?.trim() || env.IGNATIOUS_API_URL?.trim(),
  );
  if (!configured) {
    checks.push({ ok: true, label: 'Ignatious — no control plane URL, agent runs are off' });
  }

  // Skill publication reads IGNATIOUS_SKILL_BENCH_URL only and never falls
  // back to the control-plane host, so a token without it disables
  // publication silently. Only presence is checked; the token is not printed.
  if (env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN?.trim() && !env.IGNATIOUS_SKILL_BENCH_URL?.trim()) {
    const problem = 'IGNATIOUS_SKILL_BENCH_URL is not set';
    checks.push({
      ok: false,
      label: `IGNATIOUS_SKILL_BENCH_URL — ${problem}`,
      problem: `${problem} while IGNATIOUS_PUBLICATION_SERVICE_TOKEN is, so skill publication is off. Set it explicitly to the host serving /v1/conductia/skill-publications (deployed, the same origin as IGNATIOUS_CONTROL_PLANE_URL).`,
    });
  }

  if (!isProduction(env)) return checks;

  const tenantId = env.IGNATIOUS_TENANT_ID?.trim();
  if (configured && !tenantId) {
    const problem = 'IGNATIOUS_TENANT_ID is not set in production';
    checks.push({
      ok: false,
      label: `IGNATIOUS_TENANT_ID — ${problem}`,
      problem: `${problem}, so the app refuses agent runs rather than fall back to the tn_demo workspace. Set it to the Ignatious tenant this deployment uses (tn_demo is accepted when set explicitly).`,
    });
  } else if (configured) {
    checks.push({ ok: true, label: `IGNATIOUS_TENANT_ID — ${tenantId}` });
  }

  if (env.IGNATIOUS_LEAD_ID?.trim()) {
    const problem = 'IGNATIOUS_LEAD_ID is set in production';
    checks.push({
      ok: false,
      label: `IGNATIOUS_LEAD_ID — ${problem}`,
      problem: `${problem}. It points every firm's agent runs at one lead, so the app refuses agent runs while it is set. Remove it from the production environment.`,
    });
  }

  return checks;
}

function report(source: string, checks: Check[]): void {
  for (const check of checks) console.log(`${check.ok ? '✅' : '❌'} ${check.label}`);

  const problems = checks.filter((c) => !c.ok);
  console.log('');
  if (problems.length === 0) {
    console.log(`✅ ${source} passed the preflight.`);
    return;
  }

  console.log(`❌ ${source} has ${problems.length} configuration problem(s):\n`);
  for (const p of problems) console.log(`   - ${p.problem}\n`);
  process.exitCode = 1;
}

function readEnv(envFile: string): PreflightEnv {
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
    READ_VARS,
  )}.map((k) => [k, process.env[k] ?? '']))))`;
  const raw = execFileSync('node', [`--env-file=${envFile}`, '-e', script], { encoding: 'utf8' });
  return JSON.parse(raw) as PreflightEnv;
}

function main(): void {
  if (process.argv[2] === '--build') {
    console.log(`Build preflight: ${process.env.VERCEL_ENV || 'local'}\n`);
    const env = Object.fromEntries(IGNATIOUS_VARS.map((k) => [k, process.env[k]])) as IgnatiousEnv;
    report('This deployment', checkIgnatiousEnv(env));
    return;
  }

  const envFile = process.argv[2] ?? '.env.local';
  const env = readEnv(envFile);
  console.log(`Preflight target: ${env.NEXT_PUBLIC_APP_ENV || 'unset'} (from ${envFile})\n`);
  report(envFile, [...checkMailEnv(env), ...checkIgnatiousEnv(env)]);
}

if (process.argv[1]?.endsWith('preflight-env.ts')) main();
