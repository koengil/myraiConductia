// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SourceArchivedError } from '@/lib/discovery/persist';
import { firstReadClaim } from '../../worker/sync';

// The first read's claim (#353, audit r1 item 1): one UPDATE ... RETURNING that marks the read started and reads the
// window back, so discovery_set_mailbox_source_window() either lands before it or is refused with window_locked.
const SOURCE = { id: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' };

function claimDb(rows: Array<{ backfill_since: string | null }>, error: { message: string } | null = null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {
    update: (patch) => (calls.push(['update', patch]), builder),
    eq: (column, value) => (calls.push(['eq', column, value]), builder),
    is: (column, value) => (calls.push(['is', column, value]), builder),
    select: (columns) => {
      calls.push(['select', columns]);
      return Promise.resolve({ data: error ? null : rows, error });
    },
  };
  const db = { from: (table: string) => (calls.push(['from', table]), builder) } as unknown as SupabaseClient;
  return { db, calls };
}

describe('firstReadClaim (#353)', () => {
  it('marks the read started on the live source of its tenant and returns the window it holds, in one statement', async () => {
    const { db, calls } = claimDb([{ backfill_since: '2026-07-17' }]);
    const before = Date.now();
    expect(await firstReadClaim(db, SOURCE)()).toBe('2026-07-17');
    expect(calls.map(([op]) => op)).toEqual(['from', 'update', 'eq', 'eq', 'is', 'select']);
    expect(calls[0]).toEqual(['from', 'content_sources']);
    const patch = calls[1][1] as Record<string, string>;
    expect(Object.keys(patch)).toEqual(['backfill_started_at']);
    expect(Date.parse(patch.backfill_started_at)).toBeGreaterThanOrEqual(before);
    expect(calls.slice(2)).toEqual([
      ['eq', 'id', SOURCE.id],
      ['eq', 'tenant_id', SOURCE.tenantId],
      ['is', 'archived_at', null],
      ['select', 'backfill_since'],
    ]);
  });

  it('returns null for a source that reads the whole mailbox', async () => {
    const { db } = claimDb([{ backfill_since: null }]);
    expect(await firstReadClaim(db, SOURCE)()).toBeNull();
  });

  it('stops as an archived source when no live row matches, having written nothing (#262)', async () => {
    const { db } = claimDb([]);
    await expect(firstReadClaim(db, SOURCE)()).rejects.toBeInstanceOf(SourceArchivedError);
  });

  it('fails the read on a database error rather than reading an unclaimed window', async () => {
    const { db } = claimDb([], { message: 'boom' });
    await expect(firstReadClaim(db, SOURCE)()).rejects.toThrow(/first read claim/);
  });
});
