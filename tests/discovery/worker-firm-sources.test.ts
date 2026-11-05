// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { FIRM_SOURCES_PAGE, firmSources, type FirmSource } from '../../worker/sync';

// The tenant's sources decide which are shared (#173 G-09, audit G5). A short read would take a team inbox for a
// person's mailbox, so firmSources reads page by page against the exact count and throws on anything incomplete.

const TENANT = '11111111-1111-4111-8111-111111111111';
const row = (i: number): FirmSource => ({
  id: `s${String(i).padStart(5, '0')}`,
  address: `m${i}@bank.example`,
  kind: 'mailbox',
  team_mailbox_id: i % 7 === 0 ? `tm${i}` : null,
  owner_user_id: i % 7 === 0 ? null : `u${i}`,
});

/** A client over `rows` whose server returns at most `maxRows` per request (PostgREST's max_rows), with an exact count. */
function fakeDb(rows: FirmSource[], o: { maxRows?: number; count?: number | null; failAt?: number } = {}) {
  const ranges: Array<[number, number]> = [];
  const db = {
    from: () => {
      let from = 0;
      let to = Infinity;
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: (a: number, b: number) => {
          from = a;
          to = b;
          ranges.push([a, b]);
          if (o.failAt === ranges.length) return Promise.resolve({ data: null, error: { message: 'boom', code: '57014' }, count: null });
          const end = Math.min(to + 1, from + (o.maxRows ?? 1000));
          return Promise.resolve({ data: rows.slice(from, end), error: null, count: o.count === undefined ? rows.length : o.count });
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, ranges };
}

describe('firmSources', () => {
  it('reads every source across pages, in id order', async () => {
    const rows = Array.from({ length: FIRM_SOURCES_PAGE * 2 + 5 }, (_, i) => row(i));
    const { db, ranges } = fakeDb(rows);
    const read = await firmSources(db, TENANT);
    expect(read).toHaveLength(rows.length);
    expect(ranges).toEqual([
      [0, FIRM_SOURCES_PAGE - 1],
      [FIRM_SOURCES_PAGE, FIRM_SOURCES_PAGE * 2 - 1],
      [FIRM_SOURCES_PAGE * 2, FIRM_SOURCES_PAGE * 3 - 1],
    ]);
  });

  it('throws when the server caps a page below the page size, so the set comes back short', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i));
    await expect(firmSources(fakeDb(rows, { maxRows: 500 }).db, TENANT)).rejects.toThrow(/incomplete/);
  });

  it('throws on a read error part-way, and on an answer without a count', async () => {
    const rows = Array.from({ length: FIRM_SOURCES_PAGE + 1 }, (_, i) => row(i));
    await expect(firmSources(fakeDb(rows, { failAt: 2 }).db, TENANT)).rejects.toThrow(/content source read failed/);
    await expect(firmSources(fakeDb(rows, { count: null }).db, TENANT)).rejects.toThrow(/no count/);
  });

  it('reads a tenant with no sources as an empty set', async () => {
    expect(await firmSources(fakeDb([]).db, TENANT)).toEqual([]);
  });
});
