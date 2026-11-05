// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The reader pass record (#370, R1-m5): syncSource writes the attempt's counts in place, so a throw mid-pass still
// reports what was done. The real syncSource runs over a fake reader; persistItems is stubbed to store two keys per
// page (or to throw on a chosen call), and the database is a stub that records every content_sources patch and can
// refuse the checkpoint write.
const persist = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));
vi.mock('@/lib/discovery/persist', async () => {
  const actual = await vi.importActual<typeof import('@/lib/discovery/persist')>('@/lib/discovery/persist');
  return {
    ...actual,
    persistItems: async () => {
      persist.calls += 1;
      if (persist.calls === persist.failOnCall) throw new Error('discovery persist: source_items upsert failed (23P01)');
      return {
        itemsRead: 2,
        storedKeys: [`<k${persist.calls}a@x>`, `<k${persist.calls}b@x>`],
        itemIds: new Map(),
        collisions: [],
      };
    },
  };
});

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { ContentSource, SourceItemPage } from '@/lib/discovery/source/types';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { emptyCounts } from '../../worker/passRecord';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';
import { domainRule, exclusionWith } from '../google/exclusion';
import { fakeGmail, threadOf } from '../google/fakeGmail';

function db(options: { failCheckpoint?: boolean } = {}) {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async () =>
          options.failCheckpoint && 'delta_checkpoint' in patch && patch.delta_checkpoint !== null
            ? { data: null, error: { code: 'P0001', message: 'refused' } }
            : { data: [], error: null },
      }),
      // The message index read (#461) finds nothing.
      select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }),
    }),
  } as unknown as SupabaseClient;
}

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: 'a@bank.example',
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

/** A reader that yields `n` pages, each with a checkpoint; the content is irrelevant (persistItems is stubbed). */
function pages(n: number, then?: Error, counts: Pick<SourceItemPage, 'fetched' | 'excluded'> = {}): ContentSource {
  const gen = async function* (): AsyncGenerator<SourceItemPage> {
    for (let i = 1; i <= n; i += 1) yield { items: [], ...counts, nextCheckpoint: `cp-${i}` };
    if (then) throw then;
  };
  return { kind: SOURCE_KIND.MAILBOX, backfill: () => gen(), delta: () => gen() };
}

const context = new RoutingContext();
const runId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  persist.calls = 0;
  persist.failOnCall = 0;
});

describe('syncSource counts in place (#370)', () => {
  it('clears census start only when stamping a new backfill', async () => {
    const patches: Record<string, unknown>[] = [];
    const recording = { from: () => ({ update: (patch: Record<string, unknown>) => ({ eq: async () => { patches.push(patch); return { data: [], error: null }; } }) }) } as unknown as SupabaseClient;
    await syncSource(recording, { source: source(), reader: pages(1), runId, context });
    expect(patches[0]).toMatchObject({ backfill_started_at: expect.any(String), send_census_from: null });
    patches.length = 0;
    await syncSource(recording, { source: source({ backfillStartedAt: '2026-10-01T00:00:00Z', deltaCheckpoint: 'cp-0' }), reader: pages(1), runId, context });
    expect(patches[0]).not.toHaveProperty('send_census_from');
  });
  it('two pages persist and checkpoint, the third throws in persist: the counts survive the throw', async () => {
    persist.failOnCall = 3;
    const counts = emptyCounts();
    await expect(syncSource(db(), { source: source(), reader: pages(3), runId, context, counts })).rejects.toThrow('23P01');
    expect(counts).toMatchObject({ pages: 2, stored: 4, checkpointAdvanced: true });
  });

  it('persist succeeds and the checkpoint write fails: stored is reported, pages is not (R1-M3)', async () => {
    const counts = emptyCounts();
    await expect(
      syncSource(db({ failCheckpoint: true }), { source: source(), reader: pages(1), runId, context, counts }),
    ).rejects.toThrow('checkpoint update failed');
    expect(counts).toMatchObject({ pages: 0, stored: 2, checkpointAdvanced: false });
  });

  it('a completed pass reports checkpointAdvanced on the result and the counts', async () => {
    const counts = emptyCounts();
    const result = await syncSource(db(), { source: source(), reader: pages(2), runId, context, counts });
    expect(result).toMatchObject({ status: 'complete', pages: 2, checkpointAdvanced: true });
    expect(counts).toEqual({ pages: 2, fetched: 0, excluded: 0, stored: 4, checkpointAdvanced: true });
  });

  it('page_limit keeps the counts it reached', async () => {
    const counts = emptyCounts();
    const result = await syncSource(db(), { source: source(), reader: pages(5), runId, context, counts, maxPages: 2 });
    expect(result.status).toBe('page_limit');
    expect(counts).toMatchObject({ pages: 2, stored: 4, checkpointAdvanced: true });
  });

  it('an expired cursor after a page keeps the counts it reached, and resets', async () => {
    const counts = emptyCounts();
    const delta = source({ deltaCheckpoint: 'delta-1', backfillCompletedAt: '2026-10-01T00:00:00.000Z' });
    const result = await syncSource(db(), {
      source: delta,
      reader: pages(1, new CheckpointExpiredError('google')),
      runId,
      context,
      counts,
    });
    expect(result.status).toBe('reset');
    expect(counts).toMatchObject({ pages: 1, stored: 2, checkpointAdvanced: true });
  });

  it('adds up fetched and excluded on arrival, before persist: a third page that fails to store still counts (#370 Phase 2)', async () => {
    persist.failOnCall = 3;
    const counts = emptyCounts();
    await expect(
      syncSource(db(), { source: source(), reader: pages(3, undefined, { fetched: 3, excluded: 1 }), runId, context, counts }),
    ).rejects.toThrow('23P01');
    expect(counts).toMatchObject({ pages: 2, fetched: 9, excluded: 3, stored: 4 });
  });

  it('reads an unset, negative, fractional or non-numeric page count as 0', async () => {
    for (const bad of [undefined, -2, 1.5, Number.NaN, '3' as unknown as number]) {
      const counts = emptyCounts();
      const result = await syncSource(db(), {
        source: source(),
        reader: pages(2, undefined, { fetched: bad, excluded: bad }),
        runId,
        context,
        counts,
      });
      expect(result).toMatchObject({ fetched: 0, excluded: 0 });
      expect(counts).toMatchObject({ fetched: 0, excluded: 0 });
    }
  });

  it('works without counts given, as the existing callers do', async () => {
    const result = await syncSource(db(), { source: source(), reader: pages(1), runId, context });
    expect(result).toMatchObject({ status: 'complete', pages: 1, checkpointAdvanced: true });
  });
});

// A pass stopped between pages (the worker flag turned off, or the page cap) keeps the counts of every page it read:
// they are added on arrival, before the stop is decided (#370, #344 G2).
describe('a pass that stops between pages keeps its counts', () => {
  it('paused after the first page: fetched, excluded and stored of that page stand', async () => {
    const counts = emptyCounts();
    const reader: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: async function* () {
        yield { items: [], fetched: 3, excluded: 1, nextCheckpoint: 'cp-1' };
        yield { items: [], fetched: 5, excluded: 0, nextCheckpoint: 'cp-2' };
      },
      delta: async function* () {},
    };
    const result = await syncSource(db(), { source: source(), reader, runId, context, counts, shouldContinue: async () => false });
    expect(result).toMatchObject({ status: 'paused', pages: 1, fetched: 3, excluded: 1 });
    expect(result.storedKeys.size).toBe(2);
    expect(counts).toEqual({ pages: 1, fetched: 3, excluded: 1, stored: 2, checkpointAdvanced: true });
  });

  it('on the Gmail reader: a pass paused after its first page reports that page\'s raw reads and pre-fetch exclusions', async () => {
    // Eleven one-message threads: the first page is the first ten (THREADS_PER_CHUNK); one of them is excluded by the
    // policy on metadata, so nine are fetched raw. The eleventh is never read.
    const threads = Array.from({ length: 11 }, (_, i) => threadOf(`t${i + 1}`, 1));
    threads[3].messages[0].to = [{ address: 'partner@counsel.example' }];
    const gmail = fakeGmail({ address: 'a@bank.example', threads });
    const reader = createGmailMailContentSource({
      httpFor: async () => gmail.http,
      exclusion: exclusionWith([domainRule('outside-counsel', 'counsel.example')]),
    });
    const counts = emptyCounts();
    const result = await syncSource(db(), {
      source: source({ address: 'a@bank.example' }),
      reader,
      runId,
      context,
      counts,
      shouldContinue: async () => false,
    });
    expect(gmail.log.filter((entry) => entry.startsWith('raw:'))).toHaveLength(9);
    expect(result).toMatchObject({ status: 'paused', pages: 1, fetched: 9, excluded: 1 });
    expect(counts).toMatchObject({ pages: 1, fetched: 9, excluded: 1, stored: 2, checkpointAdvanced: true });
  });
});
