import { describe, expect, it } from 'vitest';

import { SUMMIT_ASSIGNMENTS } from '../scripts/demo-book-data';
import { assertLocalSupabase } from '../scripts/lib/localOnly';

describe('assertLocalSupabase (demo book seed guard)', () => {
  it('accepts a local stack on 127.0.0.1 or localhost', () => {
    expect(assertLocalSupabase('http://127.0.0.1:54321')).toBe('127.0.0.1');
    expect(assertLocalSupabase('http://localhost:54321', 'dev')).toBe('localhost');
  });

  it('refuses a hosted project, with no override', () => {
    expect(() => assertLocalSupabase('https://abcdefgh.supabase.co')).toThrow(/non-local Supabase host "abcdefgh.supabase.co"/);
    expect(() => assertLocalSupabase('http://127.0.0.1.example.com:54321')).toThrow(/non-local/);
  });

  it('refuses prod, a missing URL and a malformed URL', () => {
    expect(() => assertLocalSupabase('http://127.0.0.1:54321', 'prod')).toThrow(/prod/);
    expect(() => assertLocalSupabase(undefined)).toThrow(/must be set/);
    expect(() => assertLocalSupabase('not a url')).toThrow(/not a URL/);
  });
});

describe('Project Summit demo assignments', () => {
  it('spread steps across the three seated people', () => {
    expect(new Set(SUMMIT_ASSIGNMENTS.map((a) => a.to))).toEqual(new Set(['md', 'deal-team', 'ib-director']));
    expect(new Set(SUMMIT_ASSIGNMENTS.map((a) => a.seq)).size).toBe(SUMMIT_ASSIGNMENTS.length);
  });
});
