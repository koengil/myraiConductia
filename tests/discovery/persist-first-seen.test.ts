// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { dedupeObservations, normalizeMessage } from '@/lib/discovery/normalize';
import { persistItems } from '@/lib/discovery/persist';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';
import type { MailMessage } from '@/lib/discovery/source/types';

// persistItems says which of a page's items the ledger had never seen: the
// insert that skips conflicts returns only the rows it wrote. The rows it did
// not write are upserted as before, and a reply without rows counts every row
// as new (screening errs toward counting, never toward skipping).

const SOURCE = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

const mail = (id: string) =>
  ({
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject: 'Lunch',
    body: { contentType: 'text', content: 'See you at noon.' },
    from: { emailAddress: { address: 'someone@outside.example', name: 'Someone' } },
    toRecipients: [{ emailAddress: { address: 'banker@bank.example', name: 'Banker' } }],
    ccRecipients: [],
    sentDateTime: '2026-10-07T10:00:00Z',
  }) as unknown as MailMessage;

const routedPage = (ids: string[]) =>
  routeByFirmRules(
    dedupeObservations(ids.map((id) => ({ sourceId: SOURCE, providerItemId: id, item: normalizeMessage(mail(id)) }))).items,
    { scope: 'unscoped' },
  );

type Row = { source_id: string; provider_item_id: string };

/** Records the ledger writes; the conflict-skipping insert answers `inserted` (the provider item ids it wrote), or null. */
function recorder(inserted: (rows: Row[]) => Row[] | null) {
  const writes: Array<{ ignoreDuplicates: boolean; ids: string[] }> = [];
  const db = {
    from: () => ({
      upsert: (rows: Row[], options?: { ignoreDuplicates?: boolean }) => {
        writes.push({ ignoreDuplicates: options?.ignoreDuplicates === true, ids: rows.map((row) => row.provider_item_id) });
        return Object.assign(Promise.resolve({ data: null, error: null }), {
          select: async () => ({ data: inserted(rows), error: null }),
        });
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { db, writes };
}

describe('persistItems: the items the ledger sees first', () => {
  it('names every item on a first read, and writes the ledger once', async () => {
    const { db, writes } = recorder((rows) => rows);
    const out = await persistItems(db, { tenantId: 't', runId: RUN, routed: routedPage(['a', 'b']) });
    expect(out.firstSeenKeys).toEqual(['<a@bank.example>', '<b@bank.example>']);
    expect(writes).toEqual([{ ignoreDuplicates: true, ids: ['a', 'b'] }]);
  });

  it('names only the new items, and upserts the rows already held as before', async () => {
    const { db, writes } = recorder((rows) => rows.filter((row) => row.provider_item_id !== 'a'));
    const out = await persistItems(db, { tenantId: 't', runId: RUN, routed: routedPage(['a', 'b']) });
    expect(out.firstSeenKeys).toEqual(['<b@bank.example>']);
    expect(writes).toEqual([
      { ignoreDuplicates: true, ids: ['a', 'b'] },
      { ignoreDuplicates: false, ids: ['a'] },
    ]);
  });

  it('names nothing when every row was held', async () => {
    const { db } = recorder(() => []);
    const out = await persistItems(db, { tenantId: 't', runId: RUN, routed: routedPage(['a', 'b']) });
    expect(out.firstSeenKeys).toEqual([]);
  });

  it('counts every item as new, and upserts every row, when the insert returns no rows at all', async () => {
    const { db, writes } = recorder(() => null);
    const out = await persistItems(db, { tenantId: 't', runId: RUN, routed: routedPage(['a', 'b']) });
    expect(out.firstSeenKeys).toEqual(['<a@bank.example>', '<b@bank.example>']);
    expect(writes[1]).toEqual({ ignoreDuplicates: false, ids: ['a', 'b'] });
  });
});
