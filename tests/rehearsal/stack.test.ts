import { describe, expect, it } from 'vitest';

import {
  REHEARSAL_API,
  REHEARSAL_DB,
  REHEARSAL_ENV_NAMES,
  assertRehearsalStack,
  localStatusEnv,
} from '../../scripts/rehearsal/stack';

// #173 phase 1: the rehearsal reaches w9-m365cap (API 127.0.0.1:57321, DB 127.0.0.1:57322) and nothing else.

const DB = 'postgresql://postgres:postgres@127.0.0.1:57322/postgres';
const PINNED = { NEXT_PUBLIC_SUPABASE_URL: REHEARSAL_API, DATABASE_URL: DB };
const check = (env: Record<string, string | undefined>) => () => assertRehearsalStack('probe index', env);

describe('assertRehearsalStack (the TypeScript twin of rehearse.sh\'s pin)', () => {
  it('pins exactly the w9-m365cap ports', () => {
    expect([REHEARSAL_API, REHEARSAL_DB.host, REHEARSAL_DB.port]).toEqual(['http://127.0.0.1:57321', '127.0.0.1', '57322']);
  });

  it.each([
    ['the pinned URL', 'http://127.0.0.1:57321'],
    ['the pinned URL with its root path', 'http://127.0.0.1:57321/'],
  ])('accepts %s', (_, url) => {
    expect(check({ ...PINNED, NEXT_PUBLIC_SUPABASE_URL: url })).not.toThrow();
  });

  it.each([
    ['unset', undefined, 'unset'],
    ['blank', '', 'unset'],
    ['hosted', 'https://abcdefgh.supabase.co', '<scheme>'],
    ['the shared stack on 54321', 'http://127.0.0.1:54321', '127.0.0.1:54321'],
    ['localhost instead of 127.0.0.1', 'http://localhost:57321', 'localhost:57321'],
    ['IPv6 loopback', 'http://[::1]:57321', '[::1]:57321'],
    ['loopback as userinfo', 'http://127.0.0.1:1@evil.example', '<userinfo>'],
    ['the pinned host as userinfo', 'http://127.0.0.1:57321@evil.example:57321', '<userinfo>'],
    ['https on the pinned port', 'https://127.0.0.1:57321', '<scheme>'],
    ['a path', 'http://127.0.0.1:57321/rest/v1', '127.0.0.1:57321 <path, query or fragment>'],
    ['a query', 'http://127.0.0.1:57321?x=1', '127.0.0.1:57321 <path, query or fragment>'],
    ['an empty query', 'http://127.0.0.1:57321/?', '127.0.0.1:57321 <path, query or fragment>'],
    ['a fragment', 'http://127.0.0.1:57321#x', '127.0.0.1:57321 <path, query or fragment>'],
    ['a tab the URL parser would strip', 'http://127.0.0.\t1:57321', '<not a URL>'],
    ['not a URL', 'not-a-url', '<not a URL>'],
  ])('refuses NEXT_PUBLIC_SUPABASE_URL %s', (_, url, detail) => {
    expect(check({ ...PINNED, NEXT_PUBLIC_SUPABASE_URL: url })).toThrow(`probe index: refuses Supabase API ${detail}`);
  });

  it.each([
    ['unset', undefined, 'unset'],
    ['the shared stack on 54322', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', '127.0.0.1:54322'],
    ['hosted', 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres', 'db.abcdefgh.supabase.co:5432'],
    ['localhost instead of 127.0.0.1', 'postgresql://postgres:postgres@localhost:57322/postgres', 'localhost:57322'],
    ['the API port', 'postgresql://postgres:postgres@127.0.0.1:57321/postgres', '127.0.0.1:57321'],
    ['no port', 'postgresql://postgres:postgres@127.0.0.1/postgres', '127.0.0.1:<no port>'],
    ['another user', 'postgresql://supabase_admin:pw@127.0.0.1:57322/postgres', '127.0.0.1:57322 <user>'],
    ['another database', 'postgresql://postgres:postgres@127.0.0.1:57322/other', '127.0.0.1:57322 <database>'],
    ['a query libpq would read as a host', `${DB}?host=evil.example`, '<query or fragment>'],
    ['a query libpq would read as a service', `${DB}?service=prod`, '<query or fragment>'],
    ['even sslmode (the wrapper adds it for the reset alone)', `${DB}?sslmode=disable`, '<query or fragment>'],
    ['a fragment', `${DB}#x`, '<query or fragment>'],
    ['a multi-host authority', 'postgresql://postgres:postgres@127.0.0.1,evil.example:57322/postgres', '127.0.0.1,evil.example:57322'],
    ['a second host:port', 'postgresql://postgres:postgres@127.0.0.1:57322,evil.example:5432/postgres', '<not a URL>'],
    ['an uppercase scheme libpq does not recognise', 'POSTGRESQL://postgres:postgres@127.0.0.1:57322/postgres', '<scheme>'],
    ['a keyword/value conninfo', 'host=127.0.0.1 port=57322 dbname=postgres', '<scheme>'],
    ['a newline', `${DB}\nhost=evil.example`, '<not a URL>'],
  ])('refuses DATABASE_URL %s', (_, url, detail) => {
    expect(check({ ...PINNED, DATABASE_URL: url })).toThrow(`probe index: refuses database ${detail}`);
  });

  it('refuses a hosted SUPABASE_URL or SUPABASE_DB_URL even when the pinned pair is set', () => {
    expect(check({ ...PINNED, SUPABASE_URL: 'https://abcdefgh.supabase.co' })).toThrow('probe index: refuses SUPABASE_URL <scheme>');
    expect(check({ ...PINNED, SUPABASE_DB_URL: 'postgresql://postgres:pw@127.0.0.1:54322/postgres' })).toThrow(
      'probe index: refuses SUPABASE_DB_URL 127.0.0.1:54322',
    );
    expect(check({ ...PINNED, SUPABASE_URL: REHEARSAL_API, SUPABASE_DB_URL: DB })).not.toThrow();
    expect(check({ ...PINNED, SUPABASE_URL: '' })).not.toThrow();
  });

  it('never echoes a password or a key in a refusal', () => {
    const hostile = [
      { ...PINNED, NEXT_PUBLIC_SUPABASE_URL: 'http://s3cret-key:s3cret-pw@127.0.0.1:57321' },
      { ...PINNED, DATABASE_URL: 'postgresql://postgres:s3cret-pw@127.0.0.1:54322/postgres' },
      { ...PINNED, DATABASE_URL: `postgresql://postgres:s3cret-pw@127.0.0.1:57322/postgres?s3cret-pw=1` },
      { ...PINNED, DATABASE_URL: 'postgresql://other:s3cret-pw@127.0.0.1:57322/postgres' },
    ];
    for (const env of hostile) {
      let message = '';
      try {
        assertRehearsalStack('probe index', env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/^probe index: refuses /);
      expect(message).not.toContain('s3cret');
    }
  });
});

describe('localStatusEnv (a child environment built from scratch)', () => {
  const SHELL = {
    ...PINNED,
    PATH: '/usr/bin',
    HOME: '/home/someone',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-anon',
    SUPABASE_SECRET_KEY: 'local-service',
    SEED_PASSWORD: 'local-password',
    NEXT_PUBLIC_APP_ENV: 'dev',
    REHEARSAL_STACK: 'w9-m365cap',
    // What a shell profile exports and no child may receive.
    AI_GATEWAY_API_KEY: 'gateway-key',
    SUPABASE_ACCESS_TOKEN: 'hosted-token',
    GOOGLE_APPLICATION_CREDENTIALS: '/secrets/google.json',
    BOX_DEV_TOKEN: 'box',
  };

  it('copies only the wrapper\'s allow-list, and adds the fixture reader\'s names', () => {
    const env = localStatusEnv(SHELL, { DISCOVERY_READER_MODE: 'fixture', DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded' });
    expect(Object.keys(env).sort()).toEqual(
      [
        'DATABASE_URL',
        'DISCOVERY_GMAIL_REPLAY_PHASE',
        'DISCOVERY_READER_MODE',
        'HOME',
        'NEXT_PUBLIC_APP_ENV',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL',
        'PATH',
        'REHEARSAL_STACK',
        'SEED_PASSWORD',
        'SUPABASE_SECRET_KEY',
      ].sort(),
    );
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(REHEARSAL_ENV_NAMES).not.toContain('AI_GATEWAY_API_KEY');
  });

  it('asserts the stack before it builds anything', () => {
    expect(() => localStatusEnv({ ...SHELL, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).toThrow(
      'localStatusEnv: refuses Supabase API 127.0.0.1:54321',
    );
  });

  it('refuses an extra name that is not the fixture reader\'s', () => {
    const sneak = { AI_GATEWAY_API_KEY: 'x' } as unknown as Parameters<typeof localStatusEnv>[1];
    expect(() => localStatusEnv(SHELL, sneak)).toThrow('localStatusEnv: refuses AI_GATEWAY_API_KEY');
  });
});
