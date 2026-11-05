// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The fetched / excluded / stored counts (#344, design R12; gate G2). G2's
// task-level evidence is the worker's own job line: `fetched` counts the
// messages whose content came back from the provider (#370 R2-M1), `excluded` those the exclusion
// policy (#263) excluded on metadata before any content request, and an excluded message
// is never also fetched. The counts travel on the reader's page result, are
// summed by syncSource, and the sync job's line carries them.

const access = vi.hoisted(() => ({ readableMailboxes: vi.fn() }));
vi.mock('@/lib/mailboxAccess', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailboxAccess')>('@/lib/mailboxAccess');
  return {
    ...actual,
    readableMailboxes: access.readableMailboxes,
    // The guard is out of scope here: the override reader is used as is.
    createGuardedContentSource: (inner: unknown) => inner,
    createFixtureAllowlistMirror: () => ({ listMembers: async () => [] }),
  };
});
// The demo flag behind model proposals (G-02b #173) stays off: the accept step has its own suites.
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: async (key: string) => key !== 'discovery_model_proposals_demo' }));
const persist = vi.hoisted(() => ({ persistItems: vi.fn() }));
vi.mock('@/lib/discovery/persist', async () => {
  const actual = await vi.importActual<typeof import('@/lib/discovery/persist')>('@/lib/discovery/persist');
  return { ...actual, persistItems: persist.persistItems };
});
vi.mock('../../worker/sync', async () => {
  const actual = await vi.importActual<typeof import('../../worker/sync')>('../../worker/sync');
  return { ...actual, loadRoutingContext: async () => new actual.RoutingContext(), discoverTenant: async () => [] };
});

import { MAILBOX_PROVIDER, READER_MODE, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, SourceItemPage } from '@/lib/discovery/source/types';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { QUEUE } from '../../worker/boss';
import { createWorkerHandlers } from '../../worker/classify';
import { runJob } from '../../worker/jobLog';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';
import { domainRule, exclusionWith, NO_EXCLUSION } from '../google/exclusion';
import { recordingRpc } from '../helpers/readerPassRpc';
import { fakeGmail, type FakeHistoryRecord } from '../google/fakeGmail';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const ADDRESS = 'storm.duncan@bank.example';

/** The #263 policy: a message-scoped rule excluding any message with a participant at counsel.example. */
const EXCLUDE_COUNSEL = exclusionWith([domainRule('outside-counsel', 'counsel.example')]);
const COUNSEL = [{ address: 'partner@counsel.example' }];

const sum = (pages: SourceItemPage[], key: 'fetched' | 'excluded') => pages.reduce((total, page) => total + (page[key] ?? 0), 0);

describe('the Gmail reader counts per page', () => {
  it('a fetched message adds to fetched; a message the policy excluded adds to excluded and is never fetched', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'm1', internalDate: 1000, subject: 'Privileged', to: COUNSEL },
            { id: 'm2', internalDate: 2000, subject: 'Project Falcon: update' },
            // The hard label skip is neither fetched nor policy-excluded.
            { id: 'm3', internalDate: 3000, labels: ['DRAFT'] },
          ],
        },
      ],
    });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(gmail.source, null)) pages.push(page);

    expect(gmail.log.filter((entry) => entry.startsWith('raw:'))).toEqual(['raw:m2']);
    expect(sum(pages, 'fetched')).toBe(1);
    expect(sum(pages, 'excluded')).toBe(1);
    // Every page reports both, as numbers.
    for (const page of pages) expect(page).toMatchObject({ fetched: expect.any(Number), excluded: expect.any(Number) });
  });

  it('counts the same way on a delta pass', async () => {
    const added = (id: string): FakeHistoryRecord => ({ id: `h-${id}`, messagesAdded: [{ message: { id } }] });
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'd1', internalDate: 1000, subject: 'Board minutes', to: COUNSEL },
            { id: 'd2', internalDate: 2000 },
            { id: 'd3', internalDate: 3000 },
          ],
        },
      ],
      history: { pages: [[added('d1'), added('d2'), added('d3')]], current: '2000', validStart: '1000' },
    });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
    const token = JSON.stringify({
      v: 1,
      kind: 'gmail-mail',
      phase: 'delta',
      startHistoryId: '1000',
      pageToken: null,
      nextThreadId: null,
      nextMessageId: null,
      pageTokenRestarted: false,
      historyId: '1000',
      historyPageToken: null,
    });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.delta(gmail.source, token)) pages.push(page);

    expect(gmail.log.filter((entry) => entry.startsWith('raw:'))).toEqual(['raw:d2', 'raw:d3']);
    expect(sum(pages, 'fetched')).toBe(2);
    expect(sum(pages, 'excluded')).toBe(1);
  });

  it('under a policy that excludes nothing (version 0, the fixture-only empty policy), excluded stays 0', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages: [{ id: 'm1', subject: 'Privileged', to: COUNSEL }] }] });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(gmail.source, null)) pages.push(page);
    expect(sum(pages, 'fetched')).toBe(1);
    expect(sum(pages, 'excluded')).toBe(0);
  });
});

/** A stub service client: the reads the sync handler makes, and content_sources writes that succeed. */
function stubDb(): SupabaseClient {
  const rowsFor = (table: string): unknown[] => {
    if (table === 'feature_flags') return [{ enabled: true }];
    if (table === 'google_reader_registrations') return [{ tenant_id: TENANT }];
    if (table === 'content_sources') {
      return [
        {
          id: SOURCE_ID,
          tenant_id: TENANT,
          kind: 'mailbox',
          provider: 'google',
          address: ADDRESS,
          owner_user_id: null,
          delta_checkpoint: null,
          backfill_completed_at: null,
          backfill_started_at: null,
          history_expiry_streak: 0,
          last_synced_at: null,
        },
      ];
    }
    return [];
  };
  return {
    // Every sync job records its reader pass (#370) through this rpc.
    rpc: recordingRpc().rpc,
    from: (table: string) => {
      const rows = rowsFor(table);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'not', 'order', 'range', 'limit']) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.update = () => ({ eq: async () => ({ data: null, error: null }) });
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
}

/** Two counted pages and one from a reader that does not count. */
const countedReader: ContentSource = {
  kind: SOURCE_KIND.MAILBOX,
  backfill: async function* () {
    yield { items: [], nextCheckpoint: 'c1', fetched: 1, excluded: 0 };
    yield { items: [], nextCheckpoint: 'c2', fetched: 0, excluded: 1 };
    yield { items: [], nextCheckpoint: 'c3' };
  },
  delta: async function* () {},
};

const source = (): SyncSource => ({
  id: SOURCE_ID,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: ADDRESS,
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
});

let stdout: string[];
beforeEach(() => {
  persist.persistItems.mockReset();
  // The admitted message is stored on the first page; nothing on the others.
  persist.persistItems
    .mockResolvedValueOnce({ itemsRead: 1, storedKeys: ['<admitted@bank.example>'], itemIds: new Map(), collisions: [] })
    .mockResolvedValue({ itemsRead: 0, storedKeys: [], itemIds: new Map(), collisions: [] });
  access.readableMailboxes.mockReset();
  access.readableMailboxes.mockResolvedValue({
    status: 'in_sync',
    readable: new Set<string>(),
    missingInGroup: [],
    extraInGroup: [],
    providerCheck: () => null,
  });
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncSource sums the page counts', () => {
  it('fetched and excluded are summed from every page; a page without counts adds 0', async () => {
    const result = await syncSource(stubDb(), { source: source(), reader: countedReader, runId: 'run-1', context: new RoutingContext() });
    expect(result).toMatchObject({ status: 'complete', pages: 3, itemsRead: 1, fetched: 1, excluded: 1 });
    expect(result.storedKeys.size).toBe(1);
  });
});

describe('the sync job line carries both counts and the stored count', () => {
  it('handlers.sync returns them and runJob prints them, with ids and no address', async () => {
    const boss = { send: vi.fn(async () => 'job') };
    const handlers = createWorkerHandlers({ db: stubDb(), boss, provider: READER_MODE.FIXTURE, readerFor: () => countedReader });
    const result = await runJob('sync', { tenant: TENANT, source: SOURCE_ID }, () => handlers.sync({ tenantId: TENANT, sourceId: SOURCE_ID }));

    expect(result).toEqual({ status: 'complete', pages: 3, fetched: 1, excluded: 1, stored: 1, screened: 0, flagged: 0, unchanged: 0 });
    const lines = stdout.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([{ evt: 'sync', tenant: TENANT, source: SOURCE_ID, status: 'complete', pages: 3, fetched: 1, excluded: 1, stored: 1, screened: 0, flagged: 0, unchanged: 0 }]);
    expect(stdout.join('')).not.toContain('@');
    // A completed sync with stored items queues the tenant's discover job, as before.
    expect(boss.send).toHaveBeenCalledWith(QUEUE.DISCOVER, { tenantId: TENANT }, { singletonKey: TENANT });
  });
});

describe('a sync job pg-boss aborted (stale heartbeat, retried)', () => {
  it('stops at the next page boundary as paused and queues nothing', async () => {
    const boss = { send: vi.fn(async () => 'job') };
    const controller = new AbortController();
    // pg-boss aborts the job's signal while page 1 is being read.
    const abortingReader: ContentSource = {
      ...countedReader,
      backfill: async function* (src, checkpoint) {
        for await (const page of countedReader.backfill(src, checkpoint)) {
          controller.abort();
          yield page;
        }
      },
    };
    const handlers = createWorkerHandlers({ db: stubDb(), boss, provider: READER_MODE.FIXTURE, readerFor: () => abortingReader });
    const result = await handlers.sync({ tenantId: TENANT, sourceId: SOURCE_ID }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'paused', pages: 1 });
    // Neither a continuation nor the discover job, though page 1 stored an item: the retry carries on.
    expect(boss.send).not.toHaveBeenCalled();
  });
});
