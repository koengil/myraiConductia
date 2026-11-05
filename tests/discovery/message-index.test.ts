// @vitest-environment node
import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { indexDigester, INDEX_DIGEST_PATTERN } from '@/lib/discovery/indexDigest';
import { normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { messageKey, persistItems, skipIndexed } from '@/lib/discovery/persist';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';
import { DISCOVERY_RULES_VERSION } from '@/lib/discovery/rulesVersion';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { emptyCounts } from '../../worker/passRecord';
import { RoutingContext, screenTags, syncSource, type SyncSource } from '../../worker/sync';

// The message index, which holds no content (#461, design entries 19 and 20): written per page after the ledger, with the
// screen's categories and never its terms; and the skip rule that keeps a mailbox from processing a routed message
// twice under the same digest and rules version. An unrouted one is processed again; a backfill, an expired-cursor
// re-backfill and a re-read skip nothing; and a skipped sighting is counted as `unchanged` only, never in itemsRead.

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';
/** The index digest as the worker writes it for TENANT (the development key: no secret in the test env). */
const keyed = indexDigester(TENANT, {});

type IndexRow = {
  message_key: string;
  provider_item_ids: string[];
  content_digest: string;
  rules_version: string;
  candidate_id: string | null;
  deal_id: string | null;
};

/**
 * A client that records every rpc and answers the index read with `indexed`. Every other table answers empty, but
 * the stored-item read-back, which finds each Message-ID it is asked for under the digest in `held` (or its own).
 */
function recorder(indexed: IndexRow[] = [], held: ReadonlyMap<string, string> = new Map()) {
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const query = (table: string) => {
    let filter: unknown[] = [];
    // An empty ledger: an insert returns every row it is given, so every sighting is new (develop's first-seen count).
    let written: unknown[] = [];
    const answer = () => {
      if (table === 'routing_ledger') return written;
      if (table === 'discovery_message_index') {
        return indexed.filter((r) => filter.includes(r.message_key));
      }
      if (table === 'source_items') {
        return filter.map((id) => ({ id: `item-${String(id)}`, internet_message_id: id, subject: 'held', content_hash: held.get(String(id)) }));
      }
      return [];
    };
    const chain: unknown = new Proxy(
      {},
      {
        get: (_, prop) => {
          if (prop === 'then') return (resolve: (value: unknown) => unknown) => resolve({ data: answer(), error: null });
          return (...args: unknown[]) => {
            if (prop === 'in') filter = args[1] as unknown[];
            if (prop === 'upsert') written = args[0] as unknown[];
            return chain;
          };
        },
      },
    );
    return chain;
  };
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: [], error: null };
    },
    from: query,
  } as unknown as SupabaseClient;
  return { db, rpcs, indexRows: () => rpcs.filter((r) => r.name === 'discovery_message_index_record') };
}

const message = (id: string, subject = 'Lunch', content = 'See you at noon.') =>
  ({
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject,
    body: { contentType: 'text', content },
    from: { emailAddress: { address: 'someone@outside.example', name: 'Someone' } },
    toRecipients: [{ emailAddress: { address: 'banker@bank.example', name: 'Banker' } }],
    ccRecipients: [],
    sentDateTime: '2026-10-07T10:00:00Z',
  }) as unknown as MailMessage;

const unrouted = (id: string, kind?: 'document'): RoutedItem =>
  ({
    item: { ...normalizeMessage(message(id)), ...(kind ? { kind, internetMessageId: `drive:${id}` } : {}) },
    observations: [{ sourceId: SOURCE, providerItemId: id }],
    routes: [],
  }) as unknown as RoutedItem;

describe('the message key', () => {
  it('is the sha256 hex of the trimmed Message-ID, the value the database writes', () => {
    // The same literal is asserted in supabase/tests/discovery_purge.sql: encode(sha256(convert_to(btrim(id), 'UTF8')), 'hex').
    expect(messageKey('<ix@p2>')).toBe('4d9cdc623861466ff4e82fbe2f20592e649cfd40d56ca0d55d4d7e6375dc8cb4');
    expect(messageKey('  <ix@p2> ')).toBe(messageKey('<ix@p2>'));
    expect(messageKey('<ix@p2>')).toBe(createHash('sha256').update('<ix@p2>').digest('hex'));
  });
});

describe('the index tags', () => {
  it('keep the kind of each reason and never its term', () => {
    expect(screenTags(['promissory: guarantee', 'mnpi: walk-away', 'mnpi: across subject and body'])).toEqual(['mnpi', 'promissory']);
    expect(screenTags([])).toEqual([]);
    expect(screenTags(['other: something', 'walk-away'])).toEqual([]);
  });
});

describe('the index write', () => {
  it('indexes every screened message of the page, routed or not, in one call, with no content', async () => {
    const { db, indexRows } = recorder();
    await persistItems(db, {
      tenantId: TENANT,
      runId: RUN,
      routed: [unrouted('m1'), unrouted('m2'), unrouted('d1', 'document'), unrouted('m3')],
      tags: new Map([
        ['<m1@bank.example>', ['mnpi']],
        ['<m2@bank.example>', []],
        ['drive:d1', []],
      ]),
    });
    const calls = indexRows();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ p_tenant: TENANT, p_source: SOURCE });
    // m3's screen failed (no tags): not indexed, so it is processed again. A document is never indexed.
    expect(calls[0].args.p_rows).toEqual([
      {
        provider_item_id: 'm1',
        internet_message_id: '<m1@bank.example>',
        sent_at: '2026-10-07T10:00:00Z',
        content_digest: keyed(normalizeMessage(message('m1')).contentHash),
        tags: ['mnpi'],
        rules_version: DISCOVERY_RULES_VERSION,
      },
      expect.objectContaining({ provider_item_id: 'm2', tags: [] }),
    ]);
    expect(JSON.stringify(calls[0].args)).not.toMatch(/Lunch|noon|someone@/);
    // Keyed per tenant (owner, 2026-10-17): never the unsalted contentHash the ledger carries.
    const rows = calls[0].args.p_rows as Array<{ content_digest: string }>;
    for (const r of rows) expect(r.content_digest).toMatch(INDEX_DIGEST_PATTERN);
    expect(rows[0].content_digest).not.toContain(normalizeMessage(message('m1')).contentHash);
  });

  it('sends a copied message as one sighting per provider id, all with the same Message-ID', async () => {
    const { db, indexRows } = recorder();
    const entry = unrouted('m1');
    entry.observations.push({ sourceId: SOURCE, providerItemId: 'm1-copy' });
    await persistItems(db, { tenantId: TENANT, runId: RUN, routed: [entry], tags: new Map([['<m1@bank.example>', []]]) });
    const rows = indexRows()[0].args.p_rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.provider_item_id, r.internet_message_id])).toEqual([
      ['m1', '<m1@bank.example>'],
      ['m1-copy', '<m1@bank.example>'],
    ]);
  });

  it('writes nothing without tags', async () => {
    const { db, indexRows } = recorder();
    await persistItems(db, { tenantId: TENANT, runId: RUN, routed: [unrouted('m1')] });
    expect(indexRows()).toEqual([]);
  });
});

describe('the skip rule', () => {
  const item = (id: string): DedupedItem => ({ item: normalizeMessage(message(id)), observations: [{ sourceId: SOURCE, providerItemId: id }] });
  const digest = (id: string) => keyed(normalizeMessage(message(id)).contentHash);
  const row = (id: string, over: Partial<IndexRow> = {}): IndexRow => ({
    message_key: messageKey(`<${id}@bank.example>`),
    provider_item_ids: [id],
    content_digest: digest(id),
    rules_version: DISCOVERY_RULES_VERSION,
    candidate_id: 'cand-1',
    deal_id: null,
    ...over,
  });

  it('drops a routed sighting indexed under the same digest and rules version, and keeps the rest', async () => {
    const { db } = recorder([
      row('same'),
      row('deal', { candidate_id: null, deal_id: 'deal-1' }),
      row('older', { rules_version: 'rules-2020-01-01' }),
      row('edited', { content_digest: 'another digest' }),
    ]);
    const out = await skipIndexed(db, { tenantId: TENANT, sourceId: SOURCE }, ['same', 'deal', 'older', 'edited', 'new'].map(item));
    expect(out.unchanged).toBe(2);
    expect(out.items.map((entry) => entry.observations[0].providerItemId)).toEqual(['older', 'edited', 'new']);
  });

  it('keeps a sighting indexed under the unkeyed contentHash or another tenant\'s key, so it is processed and re-keyed', async () => {
    const other = indexDigester('99999999-9999-4999-8999-999999999999', {});
    const { db } = recorder([
      row('plain', { content_digest: normalizeMessage(message('plain')).contentHash }),
      row('foreign', { content_digest: other(normalizeMessage(message('foreign')).contentHash) }),
    ]);
    const out = await skipIndexed(db, { tenantId: TENANT, sourceId: SOURCE }, ['plain', 'foreign'].map(item));
    expect(out.unchanged).toBe(0);
    expect(out.items).toHaveLength(2);
  });

  it('keeps an indexed sighting that is not linked to a candidate or a deal, so it is routed again', async () => {
    const { db } = recorder([row('falcon', { candidate_id: null, deal_id: null })]);
    const out = await skipIndexed(db, { tenantId: TENANT, sourceId: SOURCE }, [item('falcon')]);
    expect(out.unchanged).toBe(0);
    expect(out.items.map((entry) => entry.observations[0].providerItemId)).toEqual(['falcon']);
  });

  it('matches on the message, not the provider id: a copy under a new id is processed once, its original is skipped', async () => {
    const { db } = recorder([row('m1')]);
    const copy: DedupedItem = {
      item: normalizeMessage(message('m1')),
      observations: [
        { sourceId: SOURCE, providerItemId: 'm1' },
        { sourceId: SOURCE, providerItemId: 'm1-copy' },
      ],
    };
    const out = await skipIndexed(db, { tenantId: TENANT, sourceId: SOURCE }, [copy]);
    expect(out.unchanged).toBe(1);
    expect(out.items.map((entry) => entry.observations.map((o) => o.providerItemId))).toEqual([['m1-copy']]);
  });

  // A source whose backfill is complete and that holds a checkpoint: its next pass is a delta pass, the only kind that
  // skips. `backfillSource` is the same source before its backfill completes (or after a restart cleared both).
  const deltaSource: SyncSource = {
    id: SOURCE,
    tenantId: TENANT,
    kind: SOURCE_KIND.MAILBOX,
    provider: MAILBOX_PROVIDER.GOOGLE,
    address: 'banker@bank.example',
    ownerUserId: null,
    deltaCheckpoint: 'cp-0',
    backfillCompletedAt: '2026-10-01T00:00:00Z',
    backfillStartedAt: '2026-09-30T00:00:00Z',
    lastSyncedAt: '2026-10-02T00:00:00Z',
  };
  const backfillSource: SyncSource = { ...deltaSource, deltaCheckpoint: null, backfillCompletedAt: null, lastSyncedAt: null };
  // The same page whether the pass is a backfill or a delta; `pages` counts the reads, and `skipped` rides on the page.
  const readerOf = (items: MailMessage[], extra: Partial<SourceItemPage> = {}) => {
    const reads = { backfill: 0, delta: 0 };
    const read: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: () => {
        reads.backfill += 1;
        return (async function* (): AsyncGenerator<SourceItemPage> {
          yield { items, nextCheckpoint: 'cp-1', ...extra } as unknown as SourceItemPage;
        })();
      },
      delta: () => {
        reads.delta += 1;
        return (async function* (): AsyncGenerator<SourceItemPage> {
          yield { items, nextCheckpoint: 'cp-1', ...extra } as unknown as SourceItemPage;
        })();
      },
    };
    return { read, reads };
  };
  const reader = readerOf([message('m1')]).read;
  const sync = (db: SupabaseClient, src: SyncSource, read: ContentSource, extra: { reread?: boolean; counts?: ReturnType<typeof emptyCounts>; context?: RoutingContext } = {}) =>
    syncSource(db, { source: { ...src }, reader: read, runId: RUN, context: extra.context ?? new RoutingContext(), ...extra });

  it('in a delta pass of a completed backfill: a routed unchanged message is not processed again, is counted only as unchanged, and the checkpoint still advances', async () => {
    const { db, indexRows } = recorder([row('m1')]);
    const result = await sync(db, deltaSource, reader);
    expect(result).toMatchObject({ mode: 'delta', unchanged: 1, itemsRead: 0, checkpointAdvanced: true, screening: { screened: 0, flagged: 0 } });
    expect(indexRows()).toEqual([]);
  });

  it('in a sync: an unrouted indexed message that comes back unchanged is routed again and indexed again', async () => {
    const { db, indexRows } = recorder([row('m1', { candidate_id: null })]);
    const result = await sync(db, deltaSource, reader);
    expect(result).toMatchObject({ unchanged: 0, itemsRead: 1, screening: { screened: 1 } });
    expect(indexRows()).toHaveLength(1);
  });

  it('in a sync: a message indexed under an older rules version is processed and indexed again', async () => {
    const { db, indexRows } = recorder([row('m1', { rules_version: 'rules-2020-01-01' })]);
    const result = await sync(db, deltaSource, reader);
    expect(result).toMatchObject({ unchanged: 0, itemsRead: 1 });
    expect(indexRows().map((call) => call.args.p_rows)).toEqual([[expect.objectContaining({ provider_item_id: 'm1', rules_version: DISCOVERY_RULES_VERSION })]]);
  });

  it('in a sync: a message whose digest changed is processed and indexed again', async () => {
    const { db, indexRows } = recorder([row('m1', { content_digest: 'another digest' })]);
    const result = await sync(db, deltaSource, reader);
    expect(result).toMatchObject({ unchanged: 0, itemsRead: 1 });
    expect(indexRows()).toHaveLength(1);
  });

  describe('a pass that may recount the mailbox skips nothing (#460 invariant: routed + unrouted + skipped + collisions === itemsRead)', () => {
    // A routed, indexed message under its current digest: the skip rule's (d) holds for every case below.
    const indexed = [row('m1')];

    it('an initial backfill (no checkpoint, backfill not complete) skips nothing', async () => {
      const { db, indexRows } = recorder(indexed);
      const result = await sync(db, backfillSource, reader);
      expect(result).toMatchObject({ mode: 'backfill', unchanged: 0, itemsRead: 1, screening: { screened: 1 } });
      expect(indexRows()).toHaveLength(1);
    });

    it('a resumed backfill (a checkpoint, backfill not complete) skips nothing', async () => {
      const { db } = recorder(indexed);
      const result = await sync(db, { ...backfillSource, deltaCheckpoint: 'cp-0' }, reader);
      expect(result).toMatchObject({ mode: 'backfill', unchanged: 0, itemsRead: 1 });
    });

    it('a restarted source (the restart clears the checkpoint and the completion) skips nothing', async () => {
      // discovery_restart_mailbox_source sets delta_checkpoint, backfill_started_at and backfill_completed_at to null.
      const { db } = recorder(indexed);
      const result = await sync(db, { ...deltaSource, deltaCheckpoint: null, backfillCompletedAt: null, backfillStartedAt: null }, reader);
      expect(result).toMatchObject({ mode: 'backfill', unchanged: 0, itemsRead: 1 });
    });

    it('an expired-cursor re-backfill skips nothing: the delta pass that hit the expiry reset the source, and the next pass backfills', async () => {
      const { db } = recorder(indexed);
      const expired: ContentSource = {
        ...reader,
        delta: () =>
          (async function* (): AsyncGenerator<SourceItemPage> {
            throw new CheckpointExpiredError('google');
          })(),
      };
      const live = { ...deltaSource };
      const first = await syncSource(db, { source: live, reader: expired, runId: RUN, context: new RoutingContext() });
      expect(first).toMatchObject({ status: 'reset', mode: 'delta', unchanged: 0, itemsRead: 0 });
      // handleExpiry cleared the checkpoint and completion on the live source; the next job reads it as it stands.
      expect([live.deltaCheckpoint, live.backfillCompletedAt]).toEqual([null, null]);
      const second = await syncSource(db, { source: live, reader, runId: RUN, context: new RoutingContext() });
      expect(second).toMatchObject({ mode: 'backfill', unchanged: 0, itemsRead: 1 });
    });

    it('reread: true on a delta pass skips nothing', async () => {
      // #460: a re-read reads from nothing on a copy of the source, so the pass is a backfill.
      const { db, indexRows } = recorder(indexed);
      const result = await sync(db, deltaSource, reader, { reread: true });
      expect(result).toMatchObject({ mode: 'backfill', unchanged: 0, itemsRead: 1, screening: { screened: 1 } });
      expect(indexRows()).toHaveLength(1);
    });
  });

  it('in a re-read: nothing is skipped, and unchanged mail is counted in itemsRead and the pass counts as on a pass that never saw the index', async () => {
    // A routed message ("Project Falcon" is a known codename), already indexed and linked under its current digest.
    const falcon = message('m1', 'Project Falcon update', 'Project Falcon is moving ahead.');
    const falconReader = readerOf([falcon]).read;
    const context = () => {
      const c = new RoutingContext();
      c.addCodename('falcon', 'Project Falcon');
      return c;
    };
    const indexed = row('m1', { content_digest: keyed(normalizeMessage(falcon).contentHash) });
    const held = new Map([['<m1@bank.example>', normalizeMessage(falcon).contentHash]]);

    // A delta pass without the flag skips the message: it is not stored, and it is not in itemsRead.
    const skippedCounts = emptyCounts();
    const skipped = await sync(recorder([indexed], held).db, deltaSource, falconReader, { context: context(), counts: skippedCounts });
    expect(skipped).toMatchObject({ unchanged: 1, itemsRead: 0 });
    expect(skippedCounts).toMatchObject({ pages: 1, stored: 0 });

    // With the flag, nothing is skipped and the counts are those of a pass that never saw the index.
    const { db, indexRows } = recorder([indexed], held);
    const counts = emptyCounts();
    const result = await sync(db, deltaSource, falconReader, { context: context(), counts, reread: true });
    expect(result).toMatchObject({ unchanged: 0, itemsRead: 1, pages: 1, screening: { screened: 1 } });
    expect(counts).toMatchObject({ pages: 1, stored: 1 });
    const bare = emptyCounts();
    const fresh = await sync(recorder([], held).db, deltaSource, falconReader, { context: context(), counts: bare });
    // A re-read moves no checkpoint (#460); everything else is what a pass that never saw the index counts.
    expect({ itemsRead: result.itemsRead, counts }).toEqual({ itemsRead: fresh.itemsRead, counts: { ...bare, checkpointAdvanced: false } });
    expect(indexRows()).toHaveLength(1);
  });

  it('itemsRead is the stored, unrouted, policy-skipped and collided sightings of the pass, and never the unchanged ones', async () => {
    // One delta page of: m1 routed and indexed (skipped, unchanged); m2 unrouted; m3 routed and stored; m4 unrouted
    // with a second, different message under its Message-ID (a collision); and one reader skip (a policy-free one).
    const m3 = message('m3', 'Project Falcon update', 'Project Falcon is moving ahead.');
    const m4 = message('m4', 'First', 'one');
    const m4Twin = message('m4', 'Second', 'two');
    const page = readerOf([message('m1'), message('m2'), m3, m4, m4Twin], {
      skipped: [{ providerItemId: 'img-1', itemHash: 'hash-img', reason: 'image_only' }],
    }).read;
    const context = new RoutingContext();
    context.addCodename('falcon', 'Project Falcon');
    const held = new Map([['<m3@bank.example>', normalizeMessage(m3).contentHash]]);
    const counts = emptyCounts();
    const result = await sync(recorder([row('m1')], held).db, deltaSource, page, { context, counts });

    const stored = 1; // m3
    const unrouted = 2; // m2, m4
    const policySkipped = 1; // img-1
    const collisions = 1; // m4Twin
    expect(counts.stored).toBe(stored);
    expect(result.unchanged).toBe(1); // m1
    expect(result.itemsRead).toBe(stored + unrouted + policySkipped + collisions);
    expect(result.itemsRead + result.unchanged).toBe(6); // every sighting the reader returned
  });
});
