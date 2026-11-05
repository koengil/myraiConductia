// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { HISTORY_WINDOW_EXCEEDED, HISTORY_WINDOW_HALT_DAYS, MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { ContentSource, SourceItemPage } from '@/lib/discovery/source/types';
import { RoutingContext, SYNC_ERROR, syncSource, type SyncSource } from '../../worker/sync';

// An expired incremental cursor (Gmail 404 on history.list, #259 phase 3, R9 and
// R21) resets the source to a fresh backfill, and halts it only when a reset
// would loop. The database is a stub that records every content_sources patch,
// so what is asserted is exactly what the worker writes.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-20T00:00:00Z');

type Patch = Record<string, unknown>;

function stubDb() {
  const patches: Patch[] = [];
  const ok = { data: [], error: null };
  const db = {
    from: (table: string) => ({
      upsert: async () => ok,
      update: (patch: Patch) => ({
        eq: async () => {
          if (table === 'content_sources') patches.push(patch);
          return ok;
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { db, patches };
}

/** A source in the state a completed backfill leaves it in: one timestamp for both completions. */
function source(over: Partial<SyncSource> = {}): SyncSource {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    kind: SOURCE_KIND.MAILBOX,
    provider: MAILBOX_PROVIDER.GOOGLE,
    address: 'storm.duncan@bank.example',
    ownerUserId: null,
    deltaCheckpoint: 'delta-1000',
    backfillStartedAt: iso(T0 - HOUR),
    backfillCompletedAt: iso(T0),
    lastSyncedAt: iso(T0),
    historyExpiryStreak: 0,
    ...over,
  };
}

const expired: ContentSource = {
  kind: SOURCE_KIND.MAILBOX,
  backfill: () => (async function* () {})(),
  delta: () =>
    (async function* (): AsyncGenerator<SourceItemPage> {
      throw new CheckpointExpiredError('google');
    })(),
};

const run = (db: SupabaseClient, s: SyncSource, reader: ContentSource) =>
  syncSource(db, { source: s, reader, runId: 'run-1', context: new RoutingContext() });

describe('an expired incremental cursor', () => {
  it('resets the source to a fresh backfill: clears the checkpoint and completion, keeps when the backfill started', async () => {
    const { db, patches } = stubDb();
    const s = source();
    const result = await run(db, s, expired);

    expect(result).toMatchObject({ status: 'reset', mode: 'delta', pages: 0, itemsRead: 0 });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      delta_checkpoint: null,
      backfill_completed_at: null,
      history_expiry_streak: 1,
      last_error: null,
      last_error_at: null,
    });
    // backfill_started_at is not touched: the reset keeps it (the next backfill rewrites it when it starts).
    expect(patches[0]).not.toHaveProperty('backfill_started_at');
    // The in-memory row follows, so a caller reusing it starts the backfill.
    expect(s).toMatchObject({ deltaCheckpoint: null, backfillCompletedAt: null, historyExpiryStreak: 1 });
  });

  it('counts a reset in the streak only when it follows a backfill directly', async () => {
    // A delta pass completed since the backfill: the cursor expired in the ordinary way (a long outage).
    const settled = stubDb();
    await run(settled.db, source({ lastSyncedAt: iso(T0 + 2 * HOUR), historyExpiryStreak: 0 }), expired);
    expect(settled.patches[0]).toMatchObject({ history_expiry_streak: 0, delta_checkpoint: null });

    // No sync has completed since the backfill: the streak counts it.
    const fresh = stubDb();
    await run(fresh.db, source({ lastSyncedAt: iso(T0), historyExpiryStreak: 0 }), expired);
    expect(fresh.patches[0]).toMatchObject({ history_expiry_streak: 1 });
  });

  it('halts, with a fixed content-free code, when a second backfill in a row was followed by an expired cursor (streak 2)', async () => {
    const { db, patches } = stubDb();
    const s = source({ historyExpiryStreak: 1 });
    const result = await run(db, s, expired);

    expect(result).toMatchObject({ status: 'halted', mode: 'delta' });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED, history_expiry_streak: 2 });
    expect(patches[0].last_error).toBe('history_window_exceeded');
    // Halted, not reset: the checkpoint and the completion stay.
    expect(patches[0]).not.toHaveProperty('delta_checkpoint');
    expect(patches[0]).not.toHaveProperty('backfill_completed_at');
    expect(s.deltaCheckpoint).toBe('delta-1000');
  });

  it('halts when the backfill took longer than the history window allows, whatever the streak', async () => {
    const { db, patches } = stubDb();
    const long = source({ backfillStartedAt: iso(T0 - (HISTORY_WINDOW_HALT_DAYS * DAY + HOUR)), lastSyncedAt: iso(T0 + HOUR) });
    expect((await run(db, long, expired)).status).toBe('halted');
    expect(patches[0]).toMatchObject({ last_error: HISTORY_WINDOW_EXCEEDED, history_expiry_streak: 0 });
  });

  it('resets a backfill of exactly the window, and one with no recorded start', async () => {
    const exact = stubDb();
    expect((await run(exact.db, source({ backfillStartedAt: iso(T0 - HISTORY_WINDOW_HALT_DAYS * DAY) }), expired)).status).toBe('reset');
    const unknown = stubDb();
    expect((await run(unknown.db, source({ backfillStartedAt: null }), expired)).status).toBe('reset');
  });

  it('is not an error: no last_error is written on a reset, and the halt code is the only one written on a halt', async () => {
    for (const s of [source(), source({ historyExpiryStreak: 1 })]) {
      const { db, patches } = stubDb();
      await run(db, s, expired);
      expect(JSON.stringify(patches)).not.toContain(SYNC_ERROR.WORKER);
    }
  });
});

describe('a successful delta pass', () => {
  const quiet: ContentSource = {
    kind: SOURCE_KIND.MAILBOX,
    backfill: () => (async function* () {})(),
    delta: () =>
      (async function* (): AsyncGenerator<SourceItemPage> {
        yield { items: [], nextCheckpoint: 'delta-1001' };
      })(),
  };

  it('zeroes the expiry streak and leaves the backfill completion alone', async () => {
    const { db, patches } = stubDb();
    const result = await run(db, source({ historyExpiryStreak: 1 }), quiet);
    expect(result).toMatchObject({ status: 'complete', mode: 'delta', pages: 1 });
    const completion = patches[patches.length - 1];
    expect(completion).toMatchObject({ history_expiry_streak: 0, last_error: null });
    expect(completion).not.toHaveProperty('backfill_completed_at');
    expect(patches.some((p) => p.delta_checkpoint === 'delta-1001')).toBe(true);
  });
});

describe('a backfill', () => {
  const page = (checkpoint: string): ContentSource => ({
    kind: SOURCE_KIND.MAILBOX,
    backfill: () =>
      (async function* (): AsyncGenerator<SourceItemPage> {
        yield { items: [], nextCheckpoint: checkpoint };
      })(),
    delta: () => (async function* () {})(),
  });

  it('records when it started, from a null checkpoint', async () => {
    const { db, patches } = stubDb();
    const s = source({ deltaCheckpoint: null, backfillCompletedAt: null, backfillStartedAt: iso(T0 - 9 * DAY), historyExpiryStreak: 1 });
    const before = Date.now();
    const result = await run(db, s, page('delta-2000'));
    expect(result).toMatchObject({ status: 'complete', mode: 'backfill' });
    const started = patches.find((p) => 'backfill_started_at' in p);
    expect(started).toBeDefined();
    expect(Date.parse(started!.backfill_started_at as string)).toBeGreaterThanOrEqual(before);
    // The start is written before the first page's checkpoint.
    expect(patches.indexOf(started!)).toBe(0);
  });

  it('keeps the start of a backfill that resumes from a checkpoint', async () => {
    const { db, patches } = stubDb();
    await run(db, source({ deltaCheckpoint: 'backfill-part', backfillCompletedAt: null }), page('delta-2000'));
    expect(patches.some((p) => 'backfill_started_at' in p)).toBe(false);
  });

  it('completes without touching the streak: the next expiry must still see it', async () => {
    const { db, patches } = stubDb();
    await run(db, source({ deltaCheckpoint: null, backfillCompletedAt: null, historyExpiryStreak: 1 }), page('delta-2000'));
    const completion = patches[patches.length - 1];
    expect(completion).toHaveProperty('backfill_completed_at');
    expect(completion).not.toHaveProperty('history_expiry_streak');
    expect(completion.last_synced_at).toBe(completion.backfill_completed_at);
  });

  it('does not treat an expired cursor during a backfill as an expiry: it is the error it is', async () => {
    const { db, patches } = stubDb();
    const s = source({ deltaCheckpoint: null, backfillCompletedAt: null });
    const reader: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: () =>
        (async function* (): AsyncGenerator<SourceItemPage> {
          throw new CheckpointExpiredError('google');
        })(),
      delta: () => (async function* () {})(),
    };
    await expect(run(db, s, reader)).rejects.toBeInstanceOf(CheckpointExpiredError);
    expect(patches.some((p) => p.last_error === SYNC_ERROR.WORKER)).toBe(true);
    expect(patches.some((p) => 'history_expiry_streak' in p)).toBe(false);
  });

  it('still records and rethrows any other delta failure', async () => {
    const { db, patches } = stubDb();
    const reader: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: () => (async function* () {})(),
      delta: () =>
        (async function* (): AsyncGenerator<SourceItemPage> {
          throw new Error('boom');
        })(),
    };
    await expect(run(db, source(), reader)).rejects.toThrow('boom');
    expect(patches[patches.length - 1]).toMatchObject({ last_error: SYNC_ERROR.WORKER });
  });
});
