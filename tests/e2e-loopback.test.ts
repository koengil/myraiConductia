import { afterEach, describe, expect, it, vi } from 'vitest';

import { hermeticSupabaseRefusal } from '../e2e/support/loopback';

const LOCAL = 'http://127.0.0.1:54321';
const RUN = ['node', 'playwright', 'test'];

describe('hermeticSupabaseRefusal (the hermetic tier runs on a local Supabase stack only)', () => {
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['hosted', 'https://example.invalid'],
    ['not a URL', 'not-a-url'],
    ['loopback as a subdomain', 'http://127.0.0.1.evil.example'],
    ['loopback as userinfo', 'http://127.0.0.1@evil.example'],
    ['localhost as a subdomain', 'http://localhost.evil.example'],
    ['the unspecified address', 'http://0.0.0.0:54321'],
    ['a non-http scheme', 'ftp://127.0.0.1:54321'],
  ])('refuses NEXT_PUBLIC_SUPABASE_URL %s', (_, url) => {
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: url }, RUN)).toMatch(/^Hermetic e2e refused: NEXT_PUBLIC_SUPABASE_URL /);
  });

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:54321'],
    ['localhost', 'http://localhost:57321'],
    ['[::1]', 'http://[::1]:54321'],
    ['LOCALHOST', 'http://LOCALHOST:54321'],
  ])('accepts %s on any port', (_, url) => {
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: url }, RUN)).toBeNull();
  });

  it('refuses a hosted SUPABASE_URL even when NEXT_PUBLIC_SUPABASE_URL is local', () => {
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: LOCAL, SUPABASE_URL: 'https://example.invalid' }, RUN)).toMatch(
      /^Hermetic e2e refused: SUPABASE_URL is not a loopback URL/,
    );
  });

  it('accepts an unset or blank SUPABASE_URL (Next then reads only NEXT_PUBLIC_SUPABASE_URL)', () => {
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: LOCAL }, RUN)).toBeNull();
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: LOCAL, SUPABASE_URL: '' }, RUN)).toBeNull();
  });

  it('lets `playwright test --list` load without a stack: listing starts no webServer', () => {
    expect(hermeticSupabaseRefusal({}, [...RUN, '--list'])).toBeNull();
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid' }, [...RUN, '--list'])).toBeNull();
    expect(hermeticSupabaseRefusal({}, [...RUN, '--project=hermetic'])).not.toBeNull();
  });

  it('never prints the URL it refuses', () => {
    expect(hermeticSupabaseRefusal({ NEXT_PUBLIC_SUPABASE_URL: 'https://secret-project.example' }, RUN)).not.toContain('secret-project');
  });
});

const PINNED = {
  REHEARSAL_STACK: 'w9-m365cap',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:57321',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:57322/postgres',
};

describe('hermeticSupabaseRefusal under the #173 rehearsal (REHEARSAL_STACK set; audit item 6)', () => {
  it('accepts w9-m365cap', () => {
    expect(hermeticSupabaseRefusal(PINNED, RUN)).toBeNull();
  });

  it.each([
    ['the shared stack\'s API', { ...PINNED, NEXT_PUBLIC_SUPABASE_URL: LOCAL }, /refuses Supabase API 127\.0\.0\.1:54321/],
    ['the shared stack\'s database', { ...PINNED, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' }, /refuses database 127\.0\.0\.1:54322/],
    ['no database URL', { ...PINNED, DATABASE_URL: undefined }, /refuses database unset/],
    ['another stack id', { ...PINNED, REHEARSAL_STACK: 'w9-other' }, /unknown REHEARSAL_STACK/],
  ])('refuses %s, before any project or webServer starts', (_, env, why) => {
    const refusal = hermeticSupabaseRefusal(env, RUN);
    expect(refusal).toMatch(/^Hermetic e2e refused: /);
    expect(refusal).toMatch(why);
  });
});

describe('playwright.config.ts refuses before anything runs (audit item 6)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses the rehearsal on the shared stack at load', async () => {
    vi.stubEnv('E2E_BASE_URL', '');
    vi.stubEnv('REHEARSAL_STACK', 'w9-m365cap');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL);
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    await expect(import('../playwright.config')).rejects.toThrow(/refuses Supabase API 127\.0\.0\.1:54321/);
  });

  it('refuses the rehearsal against a live target', async () => {
    vi.stubEnv('E2E_BASE_URL', 'https://preview.example');
    vi.stubEnv('REHEARSAL_STACK', 'w9-m365cap');
    for (const [name, value] of Object.entries(PINNED)) vi.stubEnv(name, value);
    await expect(import('../playwright.config')).rejects.toThrow(/the rehearsal runs the hermetic tier only/);
  });

  it('loads for CI on 54321 without REHEARSAL_STACK', async () => {
    vi.stubEnv('E2E_BASE_URL', '');
    vi.stubEnv('REHEARSAL_STACK', undefined as unknown as string);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL);
    await expect(import('../playwright.config')).resolves.toBeDefined();
  });
});

describe('the hermetic webServer env pins third-party credentials to unconfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('blanks Box, Microsoft Graph, Google, Ignatious and the AI Gateway', async () => {
    vi.stubEnv('E2E_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL);
    for (const name of ['BOX_DEV_TOKEN', 'BOX_CLIENT_ID', 'MS_CLIENT_ID', 'GOOGLE_APPLICATION_CREDENTIALS']) vi.stubEnv(name, 'from-the-shell');
    const config = (await import('../playwright.config')).default;
    const servers = Array.isArray(config.webServer) ? config.webServer : [];
    const app = servers.find((server) => server.command.includes('npm run start'));
    expect(app?.env).toBeDefined();
    for (const name of [
      'BOX_CLIENT_ID',
      'BOX_CLIENT_SECRET',
      'BOX_DEV_TOKEN',
      'BOX_ENTERPRISE_ID',
      'BOX_SECRET',
      'MS_CLIENT_ID',
      'MS_CLIENT_SECRET',
      'MS_REDIRECT_URI',
      'MAILBOX_TOKEN_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'IGNATIOUS_CONTROL_PLANE_URL',
      'IGNATIOUS_API_URL',
      'IGNATIOUS_API_KEY',
      'AI_GATEWAY_API_KEY',
    ]) {
      expect(app?.env?.[name], name).toBe('');
    }
  });
});
