// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PR #300 round 4 (Codex 3): a page a worker read for the earlier holder can land after the source was archived.
// The database refuses it (source_archived, P0001). What is under test is what the worker does with that refusal:
// it becomes a typed SourceArchivedError for that page; it is not recorded as a sync failure on the archived row,
// it does not crash the pass, and any other database error is still an error.
const persist = vi.hoisted(() => ({ persistItems: vi.fn() }));
vi.mock('@/lib/discovery/persist', async () => {
  const actual = await vi.importActual<typeof import('@/lib/discovery/persist')>('@/lib/discovery/persist');
  return { ...actual, persistItems: persist.persistItems };
});

import { SourceArchivedError } from '@/lib/discovery/persist';
import type { ContentSource, SourceItemPage } from '@/lib/graph/reader';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';

const ARCHIVED = { code: 'P0001', message: 'source_archived' };
const SOURCE: SyncSource = {
  id: '33333333-3333-4333-8333-333333333331',
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: 'mailbox',
  provider: 'microsoft',
  address: 'a@bank.example~k3x',
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
};

describe('persistItems maps the database refusal of an archived source', async () => {
  // The module's own persistItems: the mock above stands in for it in the syncSource tests below.
  const { persistItems: realPersistItems } = await vi.importActual<typeof import('@/lib/discovery/persist')>('@/lib/discovery/persist');
  /** A db whose reads and writes succeed, except the provenance upsert, which answers `linkError`. */
  function db(linkError: { code?: string; message: string } | null, ledgerError: { code?: string; message: string } | null = null) {
    const answer = (table: string, op: string) => {
      if (table === 'source_item_sources' && op === 'upsert') return { data: null, error: linkError };
      if (table === 'routing_ledger' && op === 'upsert') return { data: null, error: ledgerError };
      if (table === 'source_items' && op === 'select') {
        return { data: [{ id: 'item-1', internet_message_id: '<m1@x>', subject: 's', content_hash: 'h' }], error: null };
      }
      return { data: [], error: null };
    };
    return {
      from: (table: string) => {
        const make = (op: string) => {
          const builder: Record<string, unknown> = {};
          for (const method of ['eq', 'in', 'order', 'range', 'select']) builder[method] = () => builder;
          builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(answer(table, op)).then(resolve, reject);
          return builder;
        };
        return { select: () => make('select'), upsert: () => make('upsert'), insert: () => make('insert') };
      },
    } as unknown as SupabaseClient;
  }
  const page = {
    tenantId: SOURCE.tenantId,
    runId: 'run-1',
    routed: [
      {
        item: {
          internetMessageId: '<m1@x>',
          conversationId: null,
          subject: 's',
          threadSubject: 's',
          sentAt: null,
          participants: [],
          bodyText: 'b',
          contentHash: 'h',
        },
        observations: [{ sourceId: SOURCE.id, providerItemId: 'p1' }],
        routes: [{ codenameKey: 'falcon', codename: 'Project Falcon', method: 'codename_subject', confidence: 0.95 }],
      },
    ],
  } as unknown as Parameters<typeof realPersistItems>[1];

  it('a source_archived answer to the provenance write is a SourceArchivedError', async () => {
    await expect(realPersistItems(db(ARCHIVED), page)).rejects.toBeInstanceOf(SourceArchivedError);
  });

  it('any other error from that write is still the plain database error', async () => {
    const error = await realPersistItems(db({ code: '23503', message: 'foreign key violation' }), page).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SourceArchivedError);
    expect((error as Error).message).toBe('discovery persist: source_item_sources upsert failed (23503)');
  });

  // #519 review: a purge that deletes the source mid-page reaches the ledger as its foreign key (23503).
  it('the ledger write refused by its source key is a SourceArchivedError', async () => {
    const gone = { code: '23503', message: 'insert or update on table "routing_ledger" violates foreign key constraint "routing_ledger_source_id_fkey"' };
    await expect(realPersistItems(db(null, gone), page)).rejects.toBeInstanceOf(SourceArchivedError);
  });

  it('any other ledger error, another key included, is still the plain database error', async () => {
    const other = { code: '23503', message: 'violates foreign key constraint "routing_ledger_run_id_fkey"' };
    const error = await realPersistItems(db(null, other), page).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SourceArchivedError);
    expect((error as Error).message).toBe('discovery persist: routing_ledger insert failed (23503)');
  });
});

describe('syncSource and an archived source', () => {
  const pages: SourceItemPage[] = [{ items: [], nextCheckpoint: 'c1' }, { items: [], nextCheckpoint: 'c2' }];
  const reader: ContentSource = {
    kind: 'mailbox',
    backfill: async function* () {
      yield* pages;
    },
    delta: async function* () {},
  };
  let writes: Array<Record<string, unknown>>;
  /** A db recording the content_sources writes; `refuse` names the write the database refuses as archived. */
  function db(refuse?: (patch: Record<string, unknown>) => boolean) {
    return {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            writes.push(patch);
            return { error: refuse?.(patch) ? ARCHIVED : null };
          },
        }),
      }),
    } as unknown as SupabaseClient;
  }
  const options = () => ({ source: { ...SOURCE }, reader, runId: 'run-1', context: new RoutingContext() });

  beforeEach(() => {
    writes = [];
    persist.persistItems.mockReset();
    persist.persistItems.mockResolvedValue({ itemsRead: 0, storedKeys: [], itemIds: new Map(), collisions: [] });
  });

  it('a page whose provenance is refused stops the source as SourceArchivedError, recording nothing on the archived row', async () => {
    persist.persistItems.mockRejectedValueOnce(new SourceArchivedError());
    await expect(syncSource(db(), options())).rejects.toBeInstanceOf(SourceArchivedError);
    expect(writes).toEqual([]);   // no checkpoint, and no last_error either
    expect(persist.persistItems).toHaveBeenCalledTimes(1);
  });

  it('a checkpoint the database refuses as archived is the same error, with no error record', async () => {
    await expect(syncSource(db((patch) => 'delta_checkpoint' in patch), options())).rejects.toBeInstanceOf(SourceArchivedError);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveProperty('delta_checkpoint', 'c1');
  });

  it('the completion write the database refuses as archived is the same error', async () => {
    await expect(syncSource(db((patch) => 'last_synced_at' in patch), options())).rejects.toBeInstanceOf(SourceArchivedError);
  });

  it('any other failure is rethrown and recorded as before: nothing is swallowed', async () => {
    persist.persistItems.mockRejectedValueOnce(new Error('discovery persist: source_items insert failed (XX000)'));
    await expect(syncSource(db(), options())).rejects.toThrow('source_items insert failed (XX000)');
    expect(writes).toEqual([expect.objectContaining({ last_error: 'Database error' })]);
  });
});
