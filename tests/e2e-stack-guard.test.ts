import { describe, expect, it } from 'vitest';

import { assertLoopbackStack, childEnv } from '../e2e/support/discoveryProcess';
import { REHEARSAL_API } from '../scripts/rehearsal/stack';

// #173 slice 2: the e2e discovery helpers' stack guard. It parses the Supabase URL instead of matching its prefix, and
// under the rehearsal (REHEARSAL_STACK set by scripts/rehearsal/rehearse.sh) it admits w9-m365cap only. Unset, the CI
// workflows keep their own local stack on 54321.

const CI_STACK = 'http://127.0.0.1:54321';
const PINNED_DB = 'postgresql://postgres:postgres@127.0.0.1:57322/postgres';
const REHEARSAL = { REHEARSAL_STACK: 'w9-m365cap', NEXT_PUBLIC_SUPABASE_URL: REHEARSAL_API, DATABASE_URL: PINNED_DB };
const guard = (env: Record<string, string | undefined>) => () => assertLoopbackStack('extractDemoMail', env);

describe('assertLoopbackStack without REHEARSAL_STACK (CI)', () => {
  it.each([
    ['127.0.0.1 on the CI port', CI_STACK],
    ['localhost on the CI port', 'http://localhost:54321'],
    ['the rehearsal stack', REHEARSAL_API],
  ])('accepts %s', (_, url) => {
    expect(guard({ NEXT_PUBLIC_SUPABASE_URL: url })).not.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['hosted', 'https://abcdefgh.supabase.co'],
    ['loopback as userinfo', 'http://127.0.0.1:1@evil.example'],
    ['loopback with a password', 'http://127.0.0.1:x@127.0.0.1:54321'],
    ['loopback as a subdomain', 'http://127.0.0.1.evil.example:54321'],
    ['https on loopback', 'https://127.0.0.1:54321'],
    ['the unspecified address', 'http://0.0.0.0:54321'],
    ['a newline the parser would strip', 'http://127.0.0.1:54321\n'],
    ['not a URL', 'not-a-url'],
  ])('refuses %s', (_, url) => {
    expect(guard({ NEXT_PUBLIC_SUPABASE_URL: url })).toThrow(/^extractDemoMail refuses a non-local Supabase URL$/);
  });

  it('never echoes the URL it refuses', () => {
    let message = '';
    try {
      guard({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1@secret-project.example' })();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('extractDemoMail refuses a non-local Supabase URL');
  });
});

describe('assertLoopbackStack with REHEARSAL_STACK (the #173 rehearsal)', () => {
  it('accepts w9-m365cap', () => {
    expect(guard(REHEARSAL)).not.toThrow();
  });

  it('refuses the shared stack on 54321', () => {
    expect(guard({ ...REHEARSAL, NEXT_PUBLIC_SUPABASE_URL: CI_STACK })).toThrow(/refuses Supabase API 127\.0\.0\.1:54321/);
  });

  it('refuses the shared database on 54322', () => {
    expect(guard({ ...REHEARSAL, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })).toThrow(
      /refuses database 127\.0\.0\.1:54322/,
    );
  });

  it('refuses a rehearsal with no database URL', () => {
    expect(guard({ ...REHEARSAL, DATABASE_URL: undefined })).toThrow(/refuses database unset/);
  });

  it.each([['another stack id', 'w9-other'], ['blank', '']])('refuses REHEARSAL_STACK %s', (_, id) => {
    expect(guard({ ...REHEARSAL, REHEARSAL_STACK: id })).toThrow(/refuses an unknown REHEARSAL_STACK/);
  });
});

describe('childEnv (a spawned script gets an env built from scratch)', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    NEXT_PUBLIC_SUPABASE_URL: CI_STACK,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SECRET_KEY: 'secret',
    NEXT_PUBLIC_APP_ENV: 'dev',
    AI_GATEWAY_API_KEY: 'from-the-shell',
    SUPABASE_ACCESS_TOKEN: 'from-the-shell',
    GOOGLE_APPLICATION_CREDENTIALS: 'from-the-shell',
  };

  it('copies the allow-listed names and the fixture reader, and nothing else the parent holds', () => {
    const env = childEnv('runWorkerPass', { DISCOVERY_READER_MODE: 'fixture' }, parent);
    expect(Object.keys(env).sort()).toEqual([
      'DISCOVERY_READER_MODE',
      'HOME',
      'NEXT_PUBLIC_APP_ENV',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
      'PATH',
      'SUPABASE_SECRET_KEY',
    ]);
  });

  it('guards before it builds anything', () => {
    expect(() => childEnv('runWorkerPass', {}, { ...parent, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' })).toThrow(
      /^runWorkerPass refuses a non-local Supabase URL$/,
    );
    expect(() => childEnv('runWorkerPass', {}, { ...parent, REHEARSAL_STACK: 'w9-m365cap' })).toThrow(/refuses Supabase API 127\.0\.0\.1:54321/);
  });

  it('under the rehearsal, pins the stack and keeps the gateway key out', () => {
    const env = childEnv('verify-audit-chain', {}, { ...parent, ...REHEARSAL });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(REHEARSAL_API);
    expect(env.REHEARSAL_STACK).toBe('w9-m365cap');
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  });
});
