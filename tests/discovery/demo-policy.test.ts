// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { CorpusSelection } from '../../scripts/discovery/lib/corpusSelect';
import {
  assertLoopbackSupabase,
  demoExclusionPolicyFile,
  DEMO_POLICY_REQUESTED_BY,
  demoSeedPreflight,
  ensureDemoExclusionPolicy,
  openSeedDb,
} from '../../scripts/discovery/lib/demoPolicy';

const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' };
const TENANT = '00000000-0000-4000-8000-000000000001';
const scratch = mkdtempSync(join(tmpdir(), 'demo-policy-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A client whose latest policy row is `latest`; it records each table read and RPC. */
function fakeDb(latest?: { version: number; rules: unknown; requested_by: string }) {
  const calls: string[] = [];
  const query = {
    select: () => query, eq: () => query, order: () => query,
    limit: async () => ({ data: latest ? [latest] : [], error: null }),
  };
  const db = {
    from: (table: string) => (calls.push(`from:${table}`), query),
    rpc: async (name: string) => (calls.push(`rpc:${name}`), { data: (latest?.version ?? 0) + 1, error: null }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('assertLoopbackSupabase', () => {
  it('accepts a loopback stack', () => {
    expect(() => assertLoopbackSupabase(LOCAL)).not.toThrow();
    expect(() => assertLoopbackSupabase({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321', SUPABASE_URL: 'http://127.0.0.1:54321' })).not.toThrow();
  });

  it('refuses a hosted URL in either variable, and a missing one', () => {
    expect(() => assertLoopbackSupabase({ NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/not loopback/);
    expect(() => assertLoopbackSupabase({ ...LOCAL, SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/not loopback/);
    expect(() => assertLoopbackSupabase({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1.evil.example:54321' })).toThrow(/not loopback/);
    expect(() => assertLoopbackSupabase({})).toThrow(/needs NEXT_PUBLIC_SUPABASE_URL/);
  });

  it.each([
    ['loopback as userinfo', 'http://127.0.0.1@evil.com'],
    ['localhost as a subdomain', 'http://localhost.evil.com:54321'],
    ['IPv6 loopback (not accepted here)', 'http://[::1]:54321'],
    ['the unspecified address', 'http://0.0.0.0:54321'],
  ])('refuses %s', (_, url) => {
    expect(() => assertLoopbackSupabase({ NEXT_PUBLIC_SUPABASE_URL: url })).toThrow(/NEXT_PUBLIC_SUPABASE_URL is not loopback/);
  });

  it('names the variable that failed: a hosted SUPABASE_URL from a shell profile on a local stack', () => {
    expect(() => assertLoopbackSupabase({ ...LOCAL, SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/: SUPABASE_URL is not loopback$/);
    expect(() => assertLoopbackSupabase({ NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/: NEXT_PUBLIC_SUPABASE_URL is not loopback$/);
  });
});

describe('demoSeedPreflight (the seed refuses before it writes anything)', () => {
  it('exits on a hosted URL before any client exists', async () => {
    const createDb = vi.fn(() => fakeDb().db);
    await expect(
      demoSeedPreflight({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' }, tenantId: TENANT, createDb }),
    ).rejects.toThrow(/not loopback/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it('refuses a stack whose latest policy the demo seed did not write, after one read and no write', async () => {
    const { db, calls } = fakeDb({ version: 2, rules: [], requested_by: 'manual test' });
    await expect(demoSeedPreflight({ env: LOCAL, tenantId: TENANT, createDb: () => db })).rejects.toThrow(/reset the stack/);
    expect(calls).toEqual(['from:discovery_exclusion_policies']);
  });

  it('hands back the client and the committed rules on a fresh local stack', async () => {
    const { db } = fakeDb();
    expect(await demoSeedPreflight({ env: LOCAL, tenantId: TENANT, createDb: () => db })).toEqual({ db, rules: [] });
  });

  it.each([
    ['an invalid rule', '[{"id":"x"}]'],
    ['not JSON', '{'],
  ])('refuses a rules file with %s before any client exists', async (_, content) => {
    const file = join(scratch, 'rules.json');
    writeFileSync(file, content);
    const createDb = vi.fn(() => fakeDb().db);
    await expect(demoSeedPreflight({ env: LOCAL, tenantId: TENANT, createDb, rulesFile: file })).rejects.toThrow();
    expect(createDb).not.toHaveBeenCalled();
  });

  it('reads the committed rules from a path that does not depend on the working directory', () => {
    expect(isAbsolute(demoExclusionPolicyFile())).toBe(true);
    expect(existsSync(demoExclusionPolicyFile())).toBe(true);
  });
});

describe('openSeedDb (the seed opens its one client through the preflight on the demo replay only)', () => {
  const DEMO: CorpusSelection = { corpus: 'demo', phase: 'seeded' };
  const BASE: CorpusSelection = { corpus: 'base', phase: 'seeded' };
  const HOSTED = { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' };
  const open = (argv: string[], selection: CorpusSelection, env: Record<string, string>, db: SupabaseClient) => {
    const createDb = vi.fn(() => db);
    return { createDb, result: openSeedDb({ argv, env, selection, tenantId: TENANT, createDb }) };
  };

  it('never creates a client for the demo replay on a hosted URL', async () => {
    const { createDb, result } = open(['--google-replay', '--corpus', 'demo'], DEMO, HOSTED, fakeDb().db);
    await expect(result).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL is not loopback/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it('runs the preflight on the demo replay: one policy read, and the rules handed on', async () => {
    const { db, calls } = fakeDb();
    const { createDb, result } = open(['--google-replay', '--corpus', 'demo'], DEMO, LOCAL, db);
    expect(await result).toEqual({ db, demoRules: [] });
    expect(createDb).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['from:discovery_exclusion_policies']);
  });

  it.each([
    ['--google wins over --google-replay', ['--google-replay', '--google', 'reg.json', '--corpus', 'demo'], DEMO],
    ['the base replay', ['--google-replay'], BASE],
    ['the Graph demo corpus', ['--corpus', 'demo'], DEMO],
  ])('skips the preflight for %s', async (_, argv, selection) => {
    const { db, calls } = fakeDb();
    const { createDb, result } = open(argv, selection, HOSTED, db);
    expect(await result).toEqual({ db });
    expect(createDb).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

describe('ensureDemoExclusionPolicy refusals', () => {
  it('refuses a non-loopback stack before any read or write', async () => {
    const { db, calls } = fakeDb();
    await expect(ensureDemoExclusionPolicy(db, TENANT, [], { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).rejects.toThrow(/not loopback/);
    expect(calls).toEqual([]);
  });

  it('refuses, and never supersedes, a latest version the demo seed did not write', async () => {
    const { db, calls } = fakeDb({ version: 3, rules: [], requested_by: 'Jordan Ames, CCO, ticket SEC-142' });
    await expect(ensureDemoExclusionPolicy(db, TENANT, [], LOCAL)).rejects.toThrow(/not written by the demo seed; reset the stack/);
    expect(calls.filter((c) => c.startsWith('rpc:'))).toEqual([]);
  });

  it('writes nothing when its own latest version already has the rules', async () => {
    const { db, calls } = fakeDb({ version: 1, rules: [], requested_by: DEMO_POLICY_REQUESTED_BY });
    expect(await ensureDemoExclusionPolicy(db, TENANT, [], LOCAL)).toEqual({ version: 1, written: false });
    expect(calls.filter((c) => c.startsWith('rpc:'))).toEqual([]);
  });
});

describe('seed-discovery opens its service client only through openSeedDb', () => {
  it('passes createDb to openSeedDb and never calls it itself', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'seed-discovery.ts'), 'utf8');
    expect(source.match(/await openSeedDb\(\{[^}]*\bcreateDb\b[^}]*\}\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bcreateDb\(\)/);
    // The other createClient is the owner's own publishable-key session (consent), not the service client.
    expect(source.match(/createClient\(url, key\b/g)).toHaveLength(1);
  });
});
