import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEAL_CODE_SHAPE, mintDealCode, resolveDealRef } from '@/lib/api/v1/http';
import { resolveDealRefLenient } from '@/lib/api/v1/dealRef';
import { DEFAULT_PROJECT_ID } from '@/lib/project/resolveProjectId';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SEED_DEALS } from '../scripts/seed-data';

const access = vi.hoisted(() => ({ userCanAccessDeal: vi.fn() }));
vi.mock('@/lib/api/v1/access', () => access);

/*
 * Project URLs address deals by human-readable code (GUNNE-2026-558), while
 * memberships/documents key on the UUID. resolveDealRef is the one seam that
 * translates; a route skipping it reads code-addressed requests as Forbidden
 * (the live regression this guards against).
 */

function adminReturning(row: { id: string; code: string } | null) {
  const eqCalls: Array<[string, string]> = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      eqCalls.push([col, val]);
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return { admin: { from: () => builder } as unknown as SupabaseClient, eqCalls };
}

const ROW = { id: 'a0000000-0000-4000-8000-000000000001', code: 'GUNNE-2026-558' };

describe('resolveDealRef', () => {
  it('looks up a UUID segment by primary key', async () => {
    const { admin, eqCalls } = adminReturning(ROW);
    const ref = await resolveDealRef(admin, ROW.id);
    expect(ref).toEqual(ROW);
    expect(eqCalls).toEqual([['id', ROW.id]]);
  });

  it('looks up a human-readable code by the code column', async () => {
    const { admin, eqCalls } = adminReturning(ROW);
    const ref = await resolveDealRef(admin, 'GUNNE-2026-558');
    expect(ref).toEqual(ROW);
    expect(eqCalls).toEqual([['code', 'GUNNE-2026-558']]);
  });

  it('returns null for a deal that does not exist', async () => {
    const { admin } = adminReturning(null);
    expect(await resolveDealRef(admin, 'NOPE-2026-000')).toBeNull();
  });
});

it('throws on a lookup failure instead of reading it as a missing deal', async () => {
  // A DB/permission fault must surface as a server failure (500), never a
  // misleading 404 (review 6bdabd9 finding 3).
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () =>
      Promise.resolve({
        data: null,
        error: { code: '22P02', message: 'invalid input syntax for type uuid: "GUNNE-2026-558"' },
      }),
  };
  const admin = { from: () => builder } as unknown as SupabaseClient;
  // V9: the code, never the database's own text (it can quote the input).
  const failure = await resolveDealRef(admin, 'GUNNE-2026-558').catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Deal lookup failed (22P02)');
});

it('the lenient resolver carries the code too, never the database text (V9)', async () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () =>
      Promise.resolve({
        data: null,
        error: { code: '22P02', message: 'invalid input syntax for type uuid: "GUNNE-2026-558"' },
      }),
  };
  const admin = { from: () => builder } as unknown as SupabaseClient;
  const failure = await resolveDealRefLenient(admin, CALLER, 'GUNNE-2026-558').catch((e: unknown) => e);
  expect((failure as Error).message).toBe('Deal lookup failed (22P02)');
});

/*
 * The lenient mail resolver has three outcomes (D65, #245). Every ref is
 * looked up whatever its shape; the shape only decides what a MISS, or a deal
 * the caller cannot see, means. So a made-up deal code answers exactly like a
 * real deal the caller cannot see, a real deal with an unusual code answers
 * exactly like a slug, and a sandbox slug still sends untagged.
 */
const CALLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('resolveDealRefLenient', () => {
  beforeEach(() => {
    access.userCanAccessDeal.mockReset();
  });

  it('a code the caller can see resolves to the deal, looked up by its uppercase', async () => {
    access.userCanAccessDeal.mockResolvedValue(true);
    const { admin, eqCalls } = adminReturning(ROW);
    expect(await resolveDealRefLenient(admin, CALLER, 'gunne-2026-558')).toEqual({ kind: 'deal', id: ROW.id });
    expect(eqCalls).toEqual([['code', 'GUNNE-2026-558']]);
    expect(access.userCanAccessDeal).toHaveBeenCalledWith(admin, CALLER, ROW.id);
  });

  it('a UUID is looked up too, never passed through unchecked', async () => {
    access.userCanAccessDeal.mockResolvedValue(true);
    const { admin, eqCalls } = adminReturning(ROW);
    expect(await resolveDealRefLenient(admin, CALLER, ROW.id)).toEqual({ kind: 'deal', id: ROW.id });
    expect(eqCalls).toEqual([['id', ROW.id]]);
  });

  it('a real deal the caller cannot see is hidden', async () => {
    access.userCanAccessDeal.mockResolvedValue(false);
    const { admin } = adminReturning(ROW);
    expect(await resolveDealRefLenient(admin, CALLER, ROW.code)).toEqual({ kind: 'hidden' });
    expect(await resolveDealRefLenient(admin, CALLER, ROW.id)).toEqual({ kind: 'hidden' });
  });

  it('a deal-shaped ref that matches nothing is hidden, like a deal the caller cannot see', async () => {
    const { admin } = adminReturning(null);
    expect(await resolveDealRefLenient(admin, CALLER, 'GUNNE-2026-999')).toEqual({ kind: 'hidden' });
    expect(await resolveDealRefLenient(admin, CALLER, 'summit-2026-999')).toEqual({ kind: 'hidden' });
    expect(await resolveDealRefLenient(admin, CALLER, 'b0000000-0000-4000-8000-000000000999')).toEqual({
      kind: 'hidden',
    });
    expect(access.userCanAccessDeal).not.toHaveBeenCalled();
  });

  it('a sandbox slug that matches nothing stays a slug (untagged mail)', async () => {
    const { admin } = adminReturning(null);
    expect(await resolveDealRefLenient(admin, CALLER, DEFAULT_PROJECT_ID)).toEqual({ kind: 'slug' });
    expect(await resolveDealRefLenient(admin, CALLER, 'project-atlas')).toEqual({ kind: 'slug' });
  });

  it('no ref is the untagged path, with no lookup', async () => {
    const { admin, eqCalls } = adminReturning(ROW);
    expect(await resolveDealRefLenient(admin, CALLER, null)).toEqual({ kind: 'slug' });
    expect(await resolveDealRefLenient(admin, CALLER, '')).toEqual({ kind: 'slug' });
    expect(await resolveDealRefLenient(admin, CALLER, 42)).toEqual({ kind: 'slug' });
    expect(eqCalls).toEqual([]);
  });

  it('a real deal whose code is not deal-shaped still resolves and is tagged', async () => {
    access.userCanAccessDeal.mockResolvedValue(true);
    const offShape = { id: ROW.id, code: 'LEGACY-DEAL' };
    expect(DEAL_CODE_SHAPE.test(offShape.code)).toBe(false);
    const { admin } = adminReturning(offShape);
    expect(await resolveDealRefLenient(admin, CALLER, 'legacy-deal')).toEqual({ kind: 'deal', id: ROW.id });
  });

  it('a real deal with an unusual code the caller cannot see answers like a miss of that shape', async () => {
    access.userCanAccessDeal.mockResolvedValue(false);
    const { admin: real } = adminReturning({ id: ROW.id, code: 'LEGACY-DEAL' });
    const { admin: missing } = adminReturning(null);
    const hidden = await resolveDealRefLenient(real, CALLER, 'legacy-deal');
    expect(hidden).toEqual({ kind: 'slug' });
    expect(hidden).toEqual(await resolveDealRefLenient(missing, CALLER, 'legacy-deax'));
  });
});

describe('DEAL_CODE_SHAPE', () => {
  it('matches every minted code', () => {
    for (const codename of ['Project Falcon', 'Atlas', 'X', 'Project 42 Holdings', '!!!']) {
      const code = mintDealCode(codename);
      expect(code, code).toMatch(DEAL_CODE_SHAPE);
    }
  });

  it('matches every seeded deal code, whatever its prefix length', () => {
    expect(SEED_DEALS.length).toBeGreaterThan(0);
    for (const { code } of SEED_DEALS) expect(code, code).toMatch(DEAL_CODE_SHAPE);
  });

  it('does not match the sandbox project id', () => {
    expect(DEFAULT_PROJECT_ID).not.toMatch(DEAL_CODE_SHAPE);
  });
});
