// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SKIP_REASON, SOURCE_KIND } from '@/lib/constants/discovery';
import { contentHash } from '@/lib/discovery/normalize';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import type { GraphDocument } from '@/lib/graph/reader';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import { emptyReadTally, RoutingContext, syncSource, type SyncResult, type SyncSource } from '../../worker/sync';
import { innerFixtureReader } from './fixtureInnerReader';
import { ledgerDecisions, memoryPersistDb } from './memoryPersistDb';

// The coverage counts (#460): syncSource splits the sightings itemsRead counts by what routing decided, in the same
// unit, so routed + unrouted + skipped + collisions === itemsRead. The real routeByFirmRules and the real persistItems
// run over a fake reader and an in-memory client; the ledger they write is the cross-check.

const TENANT = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: 'storm.duncan@bank.example',
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

const message = (id: string, subject: string, body = `Body of ${id}.`, internetMessageId = `<${id}@bank.example>`): MailMessage => ({
  id,
  internetMessageId,
  conversationId: `conv-${id}`,
  subject,
  sentDateTime: '2026-03-02T09:00:00Z',
  from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
  toRecipients: [{ emailAddress: { name: 'Casey Buyer', address: 'casey@osprey-capital.example' } }],
  ccRecipients: [],
  body: { contentType: 'text', content: body },
});

const document = (key: string, name: string): GraphDocument => ({
  driveItemKey: key,
  providerItemId: `item-${key}`,
  name,
  drivePath: `/Deals/${name}`,
  lastModifiedDateTime: '2026-03-02T10:00:00Z',
  authors: [{ address: 'storm.duncan@bank.example', name: 'Storm Duncan' }],
  text: `${name} for the buyer group.`,
  cTag: null,
});

function readerOf(pages: SourceItemPage[]): ContentSource {
  return {
    kind: SOURCE_KIND.MAILBOX,
    backfill: async function* () {
      yield* pages;
    },
    delta: async function* () {
      yield* pages;
    },
  };
}

const total = (result: SyncResult) =>
  result.routing.routed + result.routing.unrouted + result.routing.skipped + result.routing.collisions;

describe('the routing tally partitions itemsRead (#460)', () => {
  it('counts each kind of sighting once: routed, unrouted, skipped, a page collision and a stored-item collision', async () => {
    // The tenant already holds a different message under m4's Message-ID: m4 is ledgered as an id collision.
    const held = { internetMessageId: '<m4@bank.example>', contentHash: contentHash('Old subject', 'Old body'), subject: 'Old subject', bodyText: 'Old body' };
    const { db, ledger } = memoryPersistDb({ held: [held] });
    const pages: SourceItemPage[] = [
      {
        items: [
          message('m1', 'Project Falcon: kickoff'),
          message('m2', 'Lunch on Friday'),
          // m2's Message-ID with other content: a collision inside the page.
          message('m3', 'Lunch on Friday', 'Another body entirely.', '<m2@bank.example>'),
          message('m4', 'Project Cobra: NDA'),
        ],
        documents: [document('drive-1:item-1', 'Project Falcon teaser')],
        skipped: [
          { providerItemId: 'att-1', itemHash: 'a'.repeat(64), reason: SKIP_REASON.UNSUPPORTED_TYPE },
          {
            providerItemId: 'm9',
            itemHash: 'b'.repeat(64),
            reason: SKIP_REASON.POLICY_EXCLUDED,
            providerThreadId: 'thread-9',
            policy: { version: 1, ruleId: 'outside-counsel' },
          },
        ],
        nextCheckpoint: 'cp-1',
      },
      {
        items: [message('m5', 'Board pack', 'The Project Osprey board pack is attached.'), message('m6', 'Weekly review')],
        nextCheckpoint: 'cp-2',
      },
    ];

    const result = await syncSource(db, { source: source(), reader: readerOf(pages), runId, context: new RoutingContext() });

    expect(result.itemsRead).toBe(9);
    expect(result.routing).toEqual({
      routed: 3, // m1, the Falcon document and m5
      unrouted: 2, // m2 and m6
      skipped: 2, // the unsupported attachment and the policy exclusion
      collisions: 2, // m3 inside the page, m4 against the stored item
      codenameKeys: new Set(['falcon', 'osprey']), // Cobra's only item collided, so it routed nothing
      scopeBlocked: 0,
    });
    expect(total(result)).toBe(result.itemsRead);
    // The ledger the real persistItems wrote agrees: collisions and skips are both ledgered skipped.
    expect(ledgerDecisions(ledger)).toEqual({ routed: 3, unrouted: 2, skipped: 4 });
  });

  it('adds up across the fixture corpus, one source at a time with one routing context, as a run reads it', async () => {
    const { db, ledger } = memoryPersistDb();
    const context = new RoutingContext();
    const reader = innerFixtureReader();
    const results: SyncResult[] = [];
    // Address order, as runOnce reads them.
    const addresses = ['alex.chen@bank.example', 'morgan.vale@bank.example', 'storm.duncan@bank.example'];
    for (const [i, address] of addresses.entries()) {
      const id = `33333333-3333-4333-8333-33333333333${i}`;
      results.push(await syncSource(db, { source: source({ id, address }), reader, runId, context }));
    }
    const sum = (key: 'routed' | 'unrouted' | 'skipped' | 'collisions') => results.reduce((n, r) => n + r.routing[key], 0);
    const codenames = new Set(results.flatMap((r) => [...r.routing.codenameKeys]));

    // The tracer's numbers (tests/integration/discovery-tracer.test.ts): 17 sightings, 10 of them routed.
    expect(results.reduce((n, r) => n + r.itemsRead, 0)).toBe(17);
    expect({ routed: sum('routed'), unrouted: sum('unrouted'), skipped: sum('skipped'), collisions: sum('collisions') }).toEqual({
      routed: 10,
      unrouted: 7,
      skipped: 0,
      collisions: 0,
    });
    expect(codenames).toEqual(new Set(['falcon', 'cobra']));
    expect(ledgerDecisions(ledger)).toEqual({ routed: 10, unrouted: 7 });
    for (const result of results) expect(total(result)).toBe(result.itemsRead);
  });
});

describe('the read tally survives a stop mid-pass (#460 A1)', () => {
  it('a refusal on page 2 leaves page 1 counted in options.read, its four counts adding up to its itemsRead', async () => {
    const { db } = memoryPersistDb();
    const reader: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: async function* () {
        yield { items: [message('m1', 'Project Falcon: kickoff'), message('m2', 'Lunch on Friday')], nextCheckpoint: 'cp-1' };
        throw new MailboxAccessRefusedError(TENANT, 'storm.duncan@bank.example', 'no_consent', 'provider_read');
      },
      delta: async function* () {},
    };
    const read = emptyReadTally();

    await expect(syncSource(db, { source: source(), reader, runId, context: new RoutingContext(), read })).rejects.toBeInstanceOf(
      MailboxAccessRefusedError,
    );
    expect(read.itemsRead).toBe(2);
    expect(read.routing).toMatchObject({ routed: 1, unrouted: 1, skipped: 0, collisions: 0 });
    expect(read.routing.codenameKeys).toEqual(new Set(['falcon']));
  });
});

describe('fullRead: a backfill from a null checkpoint that completed (#460)', () => {
  const onePage: SourceItemPage[] = [{ items: [message('m1', 'Project Falcon: kickoff')], nextCheckpoint: 'cp-1' }];

  it('is true for a first backfill that completes', async () => {
    const result = await syncSource(memoryPersistDb().db, { source: source(), reader: readerOf(onePage), runId, context: new RoutingContext() });
    expect(result).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: true });
  });

  it('is false for a delta pass, a resumed backfill, a paused pass and a page limit', async () => {
    const run = (over: Partial<SyncSource>, extra: { shouldContinue?: () => Promise<boolean>; maxPages?: number } = {}) =>
      syncSource(memoryPersistDb().db, {
        source: source(over),
        reader: readerOf([...onePage, { items: [], nextCheckpoint: 'cp-2' }]),
        runId,
        context: new RoutingContext(),
        ...extra,
      });
    expect(await run({ deltaCheckpoint: 'delta-1', backfillCompletedAt: '2026-10-01T00:00:00.000Z' })).toMatchObject({
      mode: 'delta',
      status: 'complete',
      fullRead: false,
    });
    expect(await run({ deltaCheckpoint: 'cp-1' })).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: false });
    expect(await run({}, { shouldContinue: async () => false })).toMatchObject({ status: 'paused', fullRead: false });
    expect(await run({}, { maxPages: 1 })).toMatchObject({ status: 'page_limit', fullRead: false });
  });
});
