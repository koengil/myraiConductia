// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assertSupabaseTarget } from '../../scripts/m365/cassette/target';

describe('assertSupabaseTarget: a local Supabase, or a named https host', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321', 'http://LOCALHOST:54321/', 'https://localhost:54321'])(
    'accepts %s',
    (url) => {
      expect(() => assertSupabaseTarget(url, null)).not.toThrow();
    },
  );

  it('refuses a hosted project, naming the host and the flag', () => {
    expect(() => assertSupabaseTarget('https://example.supabase.co', null)).toThrow(
      'Refusing example.supabase.co: this script works against a local Supabase only (pass --allow-remote-supabase example.supabase.co to name a remote https host)',
    );
  });

  it('refuses a look-alike of a loopback name', () => {
    expect(() => assertSupabaseTarget('https://localhost.example.com', null)).toThrow(/Refusing/);
    expect(() => assertSupabaseTarget('http://127.0.0.1.nip.io', null)).toThrow(/Refusing/);
  });

  it('accepts a remote host only when --allow-remote-supabase names that exact hostname', () => {
    expect(() => assertSupabaseTarget('https://t3.supabase.co', 't3.supabase.co')).not.toThrow();
    expect(() => assertSupabaseTarget('https://T3.supabase.co', 't3.SUPABASE.co')).not.toThrow();
    expect(() => assertSupabaseTarget('https://t3.supabase.co', 'other.supabase.co')).toThrow(/Refusing/);
    expect(() => assertSupabaseTarget('https://t3.supabase.co', 'supabase.co')).toThrow(/Refusing/);
  });

  it('refuses a named remote host over http: a remote database is never reached in the clear', () => {
    expect(() => assertSupabaseTarget('http://t3.supabase.co', 't3.supabase.co')).toThrow('a remote Supabase must be reached over https');
    expect(() => assertSupabaseTarget('ftp://t3.supabase.co', 't3.supabase.co')).toThrow(/over https/);
  });

  it('refuses a value that is not a URL', () => {
    expect(() => assertSupabaseTarget('not a url', null)).toThrow('not a URL');
  });
});

describe('the replay script', () => {
  it('loads no .env.local: that file names a hosted project', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts['m365:replay-discovery']).toBeDefined();
    expect(scripts['m365:replay-discovery']).not.toMatch(/env-file|\.env/);
  });
});
