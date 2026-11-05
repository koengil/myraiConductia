// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSupabaseTarget } from '../scripts/lib/supabaseTarget';

describe('assertSupabaseTarget (#316)', () => {
  it('passes a hosted URL whose ref equals the expected ref', () => {
    expect(assertSupabaseTarget('https://devref.supabase.co', 'devref')).toEqual({ ref: 'devref', loopback: false });
    expect(assertSupabaseTarget('https://devref.supabase.co', ' devref ')).toEqual({ ref: 'devref', loopback: false });
  });

  it('refuses a hosted URL without an expected ref', () => {
    expect(() => assertSupabaseTarget('https://prodref.supabase.co', undefined)).toThrow(/EXPECT_SUPABASE_REF must be set/);
    expect(() => assertSupabaseTarget('https://prodref.supabase.co', '  ')).toThrow(/EXPECT_SUPABASE_REF must be set/);
  });

  it('refuses a hosted URL whose ref differs, naming both refs', () => {
    expect(() => assertSupabaseTarget('https://prodref.supabase.co', 'devref')).toThrow(
      'Target is supabase prodref, but EXPECT_SUPABASE_REF is devref; nothing was changed',
    );
  });

  it('passes a loopback URL with no expected ref, and still compares one that is given', () => {
    expect(assertSupabaseTarget('http://127.0.0.1:54321', undefined).loopback).toBe(true);
    expect(assertSupabaseTarget('http://localhost:54321', undefined).loopback).toBe(true);
    expect(assertSupabaseTarget('http://[::1]:54321', undefined).loopback).toBe(true);
    expect(() => assertSupabaseTarget('http://127.0.0.1:54321', 'devref')).toThrow(/EXPECT_SUPABASE_REF is devref/);
  });
});

describe('the operator scripts check the target before any call', () => {
  for (const script of ['scripts/set-firm-identity-provider.ts', 'scripts/revoke-work-identity-invites.ts']) {
    it(script, () => {
      const source = readFileSync(join(process.cwd(), script), 'utf8');
      const guard = source.indexOf('assertSupabaseTarget(url, process.env.EXPECT_SUPABASE_REF)');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(source.indexOf('createClient(url'));
      expect(guard).toBeLessThan(source.indexOf('console.log(`Target:'));
    });
  }
});
