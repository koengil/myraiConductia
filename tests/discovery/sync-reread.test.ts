// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The full re-read (#460, classify-once --recount): on a source that already finished its backfill, an empty
// in-memory checkpoint gives a clean full Gmail read, and nothing of the source's resume state or health is written.
// The real Gmail reader runs over a scripted Gmail (the sync-counts.test.ts harness); the real persistItems runs over
// an in-memory client that records every content_sources patch. persistItems can be told to throw on a chosen call.
const persist = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));
vi.mock('@/lib/discovery/persist', async () => {
  const actual = await vi.importActual<typeof import('@/lib/discovery/persist')>('@/lib/discovery/persist');
  return {
    ...actual,
    persistItems: async (...args: Parameters<typeof actual.persistItems>) => {
      persist.calls += 1;
      if (persist.calls === persist.failOnCall) throw new Error('discovery persist: source_items upsert failed (23P01)');
      return actual.persistItems(...args);
    },
  };
});

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { emptyCounts } from '../../worker/passRecord';
import { RoutingContext, syncSource, type SyncResult, type SyncSource } from '../../worker/sync';
import { domainRule, exclusionWith } from '../google/exclusion';
import { fakeGmail, type FakeThread } from '../google/fakeGmail';
import { memoryPersistDb } from './memoryPersistDb';

const ADDRESS = 'storm.duncan@bank.example';
const runId = '22222222-2222-4222-8222-222222222222';
const EXCLUDE_COUNSEL = exclusionWith([domainRule('outside-counsel', 'counsel.example')]);

/** Eleven one-message threads, so the backfill takes two pages (THREADS_PER_CHUNK is 10); t4 is excluded by policy. */
function mailbox(): FakeThread[] {
  const subjects = ['Project Falcon: kickoff', 'Project Falcon: buyer list', 'Project Cobra: NDA'];
  return Array.from({ length: 11 }, (_, i) => ({
    id: `t${i + 1}`,
    messages: [
      {
        id: `t${i + 1}-m1`,
        internalDate: 1_700_000_000_000 + i * 60_000,
        subject: subjects[i] ?? `Weekly note ${i + 1}`,
        ...(i === 3 ? { to: [{ address: 'partner@counsel.example' }] } : {}),
      },
    ],
  }));
}

const freshSource = (): SyncSource => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: ADDRESS,
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
});

/** The source row as the database holds it after `patches`: what the next pass would load. */
function rowAfter(patches: Array<Record<string, unknown>>): SyncSource {
  const row = freshSource();
  for (const patch of patches) {
    if ('delta_checkpoint' in patch) row.deltaCheckpoint = patch.delta_checkpoint as string | null;
    if ('backfill_completed_at' in patch) row.backfillCompletedAt = patch.backfill_completed_at as string | null;
    if ('backfill_started_at' in patch) row.backfillStartedAt = patch.backfill_started_at as string | null;
    if ('last_synced_at' in patch) row.lastSyncedAt = patch.last_synced_at as string | null;
  }
  return row;
}

const raws = (log: string[]) => log.filter((entry) => entry.startsWith('raw:'));

/** A plain pass to completion, then the row it left, as a completed source the serve loop resumes from. */
async function coveragePass() {
  const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
  const memory = memoryPersistDb();
  const reader = () => createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
  const first = await syncSource(memory.db, { source: freshSource(), reader: reader(), runId, context: new RoutingContext() });
  const completed = rowAfter(memory.patches);
  const firstLog = [...gmail.log];
  gmail.log.length = 0;
  memory.patches.length = 0;
  return { gmail, memory, reader, first, completed, firstLog };
}

beforeEach(() => {
  persist.calls = 0;
  persist.failOnCall = 0;
});

describe('a re-read of a completed source reads it whole and writes no resume state (#460)', () => {
  it('coverage, then a re-read: the same reads and counts, zero content_sources patches, the caller\'s row untouched', async () => {
    const { gmail, memory, reader, first, completed, firstLog } = await coveragePass();
    // The coverage pass completed: the stored checkpoint is phase delta and the backfill is marked done.
    expect(first).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: true, excluded: 1 });
    expect(JSON.parse(completed.deltaCheckpoint!)).toMatchObject({ phase: 'delta' });
    expect(completed.backfillCompletedAt).not.toBeNull();
    const before = structuredClone(completed);

    const counts = emptyCounts();
    const again = await syncSource(memory.db, { source: completed, reader: reader(), runId, context: new RoutingContext(), counts, reread: true });

    // A fresh profile id, the listing from its first page, and every message the first pass fetched.
    expect(gmail.log[0]).toBe('profile');
    expect(gmail.log).toContain('list');
    expect(gmail.log.some((entry) => entry.startsWith('list:'))).toBe(false);
    expect(gmail.log.some((entry) => entry.startsWith('history:'))).toBe(false);
    expect(raws(gmail.log)).toEqual(raws(firstLog));
    expect(raws(gmail.log)).toHaveLength(10);
    expect(again).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: true, checkpointAdvanced: false });
    expect(again.itemsRead).toBe(first.itemsRead);
    expect(again.routing).toEqual(first.routing);
    expect(again.routing).toMatchObject({ routed: 3, unrouted: 7, skipped: 1, collisions: 0 });
    expect(again.routing.codenameKeys).toEqual(new Set(['falcon', 'cobra']));
    // Nothing of the source's own state was written, and the row object the caller holds is as it was.
    expect(memory.patches).toEqual([]);
    expect(completed).toEqual(before);
    expect(counts).toMatchObject({ pages: 2, checkpointAdvanced: false });
  });

  it('killed midway (a throw in persist on page 2): zero patches, no last_error, the stored checkpoint untouched', async () => {
    const { memory, reader, completed } = await coveragePass();
    const before = structuredClone(completed);
    persist.failOnCall = persist.calls + 2;
    await expect(
      syncSource(memory.db, { source: completed, reader: reader(), runId, context: new RoutingContext(), reread: true }),
    ).rejects.toThrow('23P01');
    expect(memory.patches).toEqual([]);
    expect(completed).toEqual(before);

    // Not vacuous: the same failure on a plain backfill records page 1's checkpoint and the error.
    persist.failOnCall = persist.calls + 2;
    await expect(
      syncSource(memory.db, { source: freshSource(), reader: reader(), runId, context: new RoutingContext() }),
    ).rejects.toThrow('23P01');
    expect(memory.patches.map((patch) => ('last_error' in patch ? patch.last_error : 'checkpoint'))).toEqual([
      'checkpoint',
      'Database error',
    ]);
  });

  it('control, without reread: the same completed source reads new mail only, so the line needs its label', async () => {
    const { gmail, memory, reader, completed } = await coveragePass();
    const result: SyncResult = await syncSource(memory.db, { source: completed, reader: reader(), runId, context: new RoutingContext() });
    expect(result).toMatchObject({ mode: 'delta', status: 'complete', fullRead: false, itemsRead: 0 });
    expect(gmail.log.some((entry) => entry === 'list' || entry.startsWith('list:'))).toBe(false);
    expect(raws(gmail.log)).toEqual([]);
    // The delta pass writes the source's state as it always has.
    expect(memory.patches.length).toBeGreaterThan(0);
  });

  it('the default path writes the same patches as before: two checkpoints (the first with the start), then the completion', async () => {
    for (const reread of [undefined, false]) {
      const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
      const memory = memoryPersistDb();
      const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
      await syncSource(memory.db, { source: freshSource(), reader, runId, context: new RoutingContext(), reread });
      expect(memory.patches.map((patch) => Object.keys(patch).sort())).toEqual([
        ['backfill_started_at', 'checkpoint_updated_at', 'delta_checkpoint', 'send_census_from', 'table'],
        ['checkpoint_updated_at', 'delta_checkpoint', 'table'],
        ['backfill_completed_at', 'last_error', 'last_error_at', 'last_synced_at', 'table'],
      ]);
      expect(memory.patches.every((patch) => patch.table === 'content_sources')).toBe(true);
    }
  });
});
