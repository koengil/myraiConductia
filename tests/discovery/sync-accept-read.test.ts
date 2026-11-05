// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { dedupeObservations, normalizeMessage } from '@/lib/discovery/normalize';
import { messageKey } from '@/lib/discovery/persist';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';
import type { ContentSource, MailMessage, SourceItemPage, SourceRow } from '@/lib/discovery/source/types';
import { acceptKeys, commitAccepted } from '../../worker/accept';
import { emptyCounts } from '../../worker/passRecord';
import { contextFromStored, RoutingContext, syncSource, type AcceptRead, type SyncSource } from '../../worker/sync';
import { ledgerDecisions, memoryPersistDb } from './memoryPersistDb';

// The accept mode of syncSource (G-02b #173, design R4): a re-read that keeps, in memory, only the messages a person's
// accept names with the content hash accepted, and writes nothing while it reads. The reader is a scripted double that
// records which pages were requested and the source row each call received, so early stops and the window are exact.
// The database handed to the read is a trap: any touch of it fails the test, which is how "nothing is written" is held.

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';

/** A database that is never to be touched: the accept read stores, ledgers, indexes and checkpoints nothing. */
const untouched = new Proxy(
  {},
  {
    get() {
      throw new Error('the accept read touched the database');
    },
  },
) as unknown as SupabaseClient;

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: SOURCE_ID,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: 'storm.duncan@bank.example',
  ownerUserId: '44444444-4444-4444-8444-444444444444',
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

/** A source whose backfill has finished: the accept must still read it from nothing, without touching the row. */
const completed = () =>
  source({ deltaCheckpoint: '{"phase":"delta"}', backfillCompletedAt: '2026-01-01T00:00:00Z', backfillSince: '2026-01-01' });

function message(id: string, subject: string, over: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject,
    sentDateTime: '2026-03-02T09:00:00Z',
    from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
    toRecipients: [{ emailAddress: { name: 'Casey Buyer', address: 'casey@osprey-capital.example' } }],
    ccRecipients: [],
    body: { contentType: 'text', content: `Body of ${id}.` },
    ...over,
  };
}

const keyOf = (m: MailMessage) => messageKey(normalizeMessage(m).internetMessageId);
const hashOf = (m: MailMessage) => normalizeMessage(m).contentHash;
/** The accept for these messages as they are now, plus any extra (key, hash) pair. */
const accepting = (messages: MailMessage[], extra: Array<[string, string]> = []): AcceptRead['keys'] =>
  acceptKeys([
    ...messages.map((m) => ({ message_key: keyOf(m), item_hash: hashOf(m) })),
    ...extra.map(([message_key, item_hash]) => ({ message_key, item_hash })),
  ]);

const page = (items: MailMessage[], over: Partial<SourceItemPage> = {}): SourceItemPage => ({ items, nextCheckpoint: 'cp', ...over });

/** A reader that serves the given pages from nothing and records what it was asked and which pages it yielded. */
function scripted(pages: SourceItemPage[], options: { throwAtPage?: number } = {}) {
  const served: number[] = [];
  const asked: Array<{ source: SourceRow; checkpoint: string | null }> = [];
  const reader: ContentSource = {
    kind: SOURCE_KIND.MAILBOX,
    backfill: async function* (row, checkpoint) {
      asked.push({ source: row, checkpoint });
      for (const [index, current] of pages.entries()) {
        if (options.throwAtPage === index) {
          throw new MailboxAccessRefusedError(TENANT, row.address, 'no_consent', 'provider_read');
        }
        served.push(index);
        yield current;
      }
    },
    delta: async function* () {
      throw new Error('an accept read never asks for a delta');
    },
  };
  return { reader, served, asked };
}

const read = (db: SupabaseClient, reader: ContentSource, accept: AcceptRead, over: Partial<Parameters<typeof syncSource>[1]> = {}) =>
  syncSource(db, { source: completed(), reader, runId: RUN, context: new RoutingContext(), accept, ...over });

describe('what an accept read keeps', () => {
  it('only the keyed, hash-matching messages; a changed message and every other message are dropped', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const other = message('m2', 'Weekly note');
    const changed = message('m3', 'Budget call');
    const { reader } = scripted([page([wanted, other, changed])]);

    const result = await read(untouched, reader, {
      keys: accepting([wanted], [[keyOf(changed), 'f'.repeat(64)]]),
      pageBudget: 10,
    });

    const buffer = result.accepted!;
    expect([...buffer.items.keys()]).toEqual([keyOf(wanted)]);
    expect(buffer.items.get(keyOf(wanted))!.item.internetMessageId).toBe('<m1@bank.example>');
    expect(buffer.items.get(keyOf(wanted))!.routes).toEqual([]);
    // Only a key whose accepted hash was found is seen: the changed one stays unseen, so the read goes on to the end.
    expect(buffer.seen).toEqual(new Set([keyOf(wanted)]));
    expect(buffer).toMatchObject({ changed: 1, leftToRules: 0, stop: 'end' });
    expect(result).toMatchObject({ status: 'complete', pages: 1, checkpointAdvanced: false, fullRead: false, itemsRead: 0 });
    expect(result.storedKeys.size).toBe(0);
  });

  it('a message live under two hashes matches either', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const { reader } = scripted([page([wanted])]);
    const result = await read(untouched, reader, {
      keys: accepting([wanted], [[keyOf(wanted), '0'.repeat(64)]]),
      pageBudget: 10,
    });
    expect(result.accepted!.items.size).toBe(1);
    expect(result.accepted!.changed).toBe(0);
  });

  it('records no skip and no thread taint of the page: they are dropped, not written', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const { reader } = scripted([
      page([wanted], {
        skipped: [
          {
            providerItemId: 'p1',
            itemHash: 'a'.repeat(64),
            reason: 'policy_excluded',
            providerThreadId: 'thread-1',
            policy: { version: 1, ruleId: 'outside-counsel' },
          },
        ],
        threadTaints: [{ providerThreadId: 'thread-1', ruleId: 'outside-counsel', policyVersion: 1, providerItemId: 'p1' }],
        excluded: 1,
      }),
    ]);
    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 });
    expect(result.accepted!.items.size).toBe(1);
    expect(result.accepted!.collisions).toEqual([]);
    // Counts still add up for the pass record; nothing else is kept of the skip.
    expect(result).toMatchObject({ excluded: 1, routing: expect.objectContaining({ skipped: 0 }) });
  });

  it('keeps the collision of an accepted key and drops the collision of any other', async () => {
    const first = message('m1', 'Lunch on Friday', { internetMessageId: '<dup@bank.example>' });
    const clash = message('m1b', 'A different message', { internetMessageId: '<dup@bank.example>', body: { contentType: 'text', content: 'Other text.' } });
    const otherFirst = message('m2', 'Weekly note', { internetMessageId: '<dup2@bank.example>' });
    const otherClash = message('m2b', 'Weekly note again', { internetMessageId: '<dup2@bank.example>', body: { contentType: 'text', content: 'More text.' } });
    const { reader } = scripted([page([first, clash, otherFirst, otherClash])]);

    const result = await read(untouched, reader, { keys: accepting([first]), pageBudget: 10 });

    expect(result.accepted!.items.size).toBe(1);
    expect(result.accepted!.collisions).toHaveLength(1);
    expect(result.accepted!.collisions[0]).toMatchObject({ providerItemId: 'm1b', key: '<dup@bank.example>' });
  });

  it('merges the sightings of one message across pages instead of buffering it twice', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const copy = { ...wanted, id: 'm1-copy' };
    const { reader } = scripted([page([wanted]), page([copy])]);
    const result = await read(untouched, reader, { keys: accepting([wanted], [['9'.repeat(64), '8'.repeat(64)]]), pageBudget: 10 });
    const entry = result.accepted!.items.get(keyOf(wanted))!;
    expect(result.accepted!.items.size).toBe(1);
    expect(entry.observations.map((o) => o.providerItemId)).toEqual(['m1', 'm1-copy']);
  });
});

describe('a Message-ID that appears under more than one content hash', () => {
  const DUP = '<dup@bank.example>';
  const copy = (id: string, content: string) =>
    message(id, 'Lunch on Friday', { internetMessageId: DUP, body: { contentType: 'text', content } });
  const filler = (n: number) => message(`f${n}`, `Weekly note ${n}`);

  it('an unaccepted copy first on the page does not take the id from the accepted copy', async () => {
    const stale = copy('d1', 'The text before the edit.');
    const wanted = copy('d2', 'The text the person accepted.');
    expect(hashOf(stale)).not.toBe(hashOf(wanted));
    const { reader } = scripted([page([stale, wanted])]);

    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 });

    const buffer = result.accepted!;
    expect([...buffer.items.keys()]).toEqual([keyOf(wanted)]);
    const kept = buffer.items.get(keyOf(wanted))!;
    expect(kept.item.contentHash).toBe(hashOf(wanted));
    expect(kept.observations.map((o) => o.providerItemId)).toEqual(['d2']);
    // The buffered sighting is not also ledgered as a skipped collision.
    expect(buffer.collisions).toEqual([]);
    expect(buffer).toMatchObject({ changed: 0, stop: 'all_seen' });
  });

  it('keeps the collision of the unaccepted sighting after an accepted one, as before', async () => {
    const wanted = copy('d1', 'The text the person accepted.');
    const stale = copy('d2', 'The text after the edit.');
    const { reader } = scripted([page([wanted, stale])]);
    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 });
    expect(result.accepted!.items.get(keyOf(wanted))!.item.contentHash).toBe(hashOf(wanted));
    expect(result.accepted!.collisions).toHaveLength(1);
    expect(result.accepted!.collisions[0]).toMatchObject({ providerItemId: 'd2', key: DUP });
    expect(result.accepted!.changed).toBe(0);
  });

  it('an unaccepted copy on page 1 does not end the read: the accepted copy on page 2 is buffered', async () => {
    const stale = copy('d1', 'The text before the edit.');
    const wanted = copy('d2', 'The text the person accepted.');
    const { reader, served } = scripted([page([stale]), page([wanted]), page([filler(1)])]);

    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 });

    // Not stopped after page 1; stopped after page 2, where the accepted copy was seen.
    expect(served).toEqual([0, 1]);
    expect(result.accepted).toMatchObject({ stop: 'all_seen', changed: 0 });
    expect([...result.accepted!.items.keys()]).toEqual([keyOf(wanted)]);
    expect(result.accepted!.items.get(keyOf(wanted))!.item.contentHash).toBe(hashOf(wanted));
  });

  it('only changed copies: the key is never seen, the read runs to the end, and changed is counted once', async () => {
    const wanted = copy('d0', 'The text the person accepted.');
    const staleA = copy('d1', 'The first edit.');
    const staleB = copy('d2', 'The second edit.');
    const staleC = copy('d3', 'The third edit.');
    const { reader, served } = scripted([page([staleA, staleB]), page([staleC]), page([filler(1)])]);

    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 });

    expect(served).toEqual([0, 1, 2]);
    expect(result.accepted!.seen.size).toBe(0);
    expect(result.accepted!.items.size).toBe(0);
    expect(result.accepted).toMatchObject({ changed: 1, stop: 'end' });
  });

  it('only changed copies: the read runs to the budget when there is one', async () => {
    const wanted = copy('d0', 'The text the person accepted.');
    const { reader, served } = scripted([
      page([copy('d1', 'The first edit.')]),
      page([copy('d2', 'The second edit.')]),
      page([filler(1)]),
    ]);

    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 2 });

    expect(served).toEqual([0, 1]);
    expect(result).toMatchObject({ status: 'page_limit', pages: 2 });
    expect(result.accepted).toMatchObject({ changed: 1, stop: 'budget' });
    expect(result.accepted!.seen.size).toBe(0);
  });
});

describe('a message the rules route on their own is left to the normal pass', () => {
  it('a codename message is not buffered, and is counted as left to the rules', async () => {
    const falcon = message('m1', 'Project Falcon: kickoff');
    const note = message('m2', 'Lunch on Friday');
    const { reader } = scripted([page([falcon, note])]);
    const result = await read(untouched, reader, { keys: accepting([falcon, note]), pageBudget: 10 });
    expect([...result.accepted!.items.keys()]).toEqual([keyOf(note)]);
    expect(result.accepted!.leftToRules).toBe(1);
    // Seen all the same: the early stop does not wait for a message another path owns.
    expect(result.accepted!.seen.size).toBe(2);
  });

  it('a reply the context routes by thread is not buffered; without that thread it is', async () => {
    const parent = message('m0', 'Kickoff call', {
      conversationId: 'conv-1',
      body: { contentType: 'text', content: 'Project Falcon buyer list attached.' },
    });
    const reply = message('m1', 'Re: Kickoff call', { conversationId: 'conv-1', body: { contentType: 'text', content: 'Thanks.' } });
    const known = dedupeObservations([{ sourceId: SOURCE_ID, providerItemId: 'm0', item: normalizeMessage(parent) }]).items;
    const knowing = contextFromStored(known, [], 'unscoped');
    expect(knowing.threads.size).toBe(1);

    const withThread = await read(untouched, scripted([page([reply])]).reader, { keys: accepting([reply]), pageBudget: 10 }, { context: knowing });
    expect(withThread.accepted!.items.size).toBe(0);
    expect(withThread.accepted!.leftToRules).toBe(1);

    const without = await read(untouched, scripted([page([reply])]).reader, { keys: accepting([reply]), pageBudget: 10 });
    expect([...without.accepted!.items.keys()]).toEqual([keyOf(reply)]);
    expect(without.accepted!.leftToRules).toBe(0);
  });

  it('the commit never overwrites the ledger row the normal pass wrote for a rules-routed message', async () => {
    const falcon = message('m1', 'Project Falcon: kickoff');
    const note = message('m2', 'Lunch on Friday');
    const memory = memoryPersistDb();
    // The normal pass first: the rules route Falcon and store it; the note is ledgered unrouted.
    await syncSource(memory.db, { source: source(), reader: scripted([page([falcon, note])]).reader, runId: RUN, context: new RoutingContext() });
    const ledgerOf = (id: string) => memory.ledger.get(`${SOURCE_ID}\u0000${id}`)!;
    expect(ledgerOf('m1')).toMatchObject({ decision: 'routed', method: 'codename' });
    expect(ledgerOf('m2')).toMatchObject({ decision: 'unrouted', method: null });

    const result = await read(untouched, scripted([page([falcon, note])]).reader, { keys: accepting([falcon, note]), pageBudget: 10 });
    await commitAccepted(memory.db, { tenantId: TENANT, runId: RUN, buffer: result.accepted! });

    expect(ledgerOf('m1')).toMatchObject({ decision: 'routed', method: 'codename', confidence: 0.95 });
    expect(ledgerOf('m2')).toMatchObject({ decision: 'routed', method: 'model_proposal', confidence: 1 });
    expect(memory.items.has('<m2@bank.example>')).toBe(true);
    expect(ledgerDecisions(memory.ledger)).toEqual({ routed: 2 });
  });
});

describe('the read is bounded and stops early', () => {
  const messages = Array.from({ length: 6 }, (_, i) => message(`n${i}`, `Weekly note ${i}`));
  const pages = () => [page(messages.slice(0, 2)), page(messages.slice(2, 4)), page(messages.slice(4, 6))];

  it('stops once every key has been seen: the next page is never requested', async () => {
    const { reader, served } = scripted(pages());
    const result = await read(untouched, reader, { keys: accepting([messages[0], messages[3]]), pageBudget: 10 });
    expect(served).toEqual([0, 1]);
    expect(result).toMatchObject({ status: 'complete', pages: 2 });
    expect(result.accepted).toMatchObject({ stop: 'all_seen' });
    expect(result.accepted!.items.size).toBe(2);
  });

  it('stops at the page budget with what it found, and says so', async () => {
    const { reader, served } = scripted(pages());
    const result = await read(untouched, reader, { keys: accepting([messages[0], messages[5]]), pageBudget: 2 });
    expect(served).toEqual([0, 1]);
    expect(result).toMatchObject({ status: 'page_limit', pages: 2 });
    expect(result.accepted).toMatchObject({ stop: 'budget' });
    expect([...result.accepted!.items.keys()]).toEqual([keyOf(messages[0])]);
  });

  it('reads to the end when a key is never found', async () => {
    const { reader, served } = scripted(pages());
    const result = await read(untouched, reader, { keys: accepting([messages[0]], [['7'.repeat(64), '6'.repeat(64)]]), pageBudget: 10 });
    expect(served).toEqual([0, 1, 2]);
    expect(result.accepted).toMatchObject({ stop: 'end' });
  });

  it('calls onPage after every buffered page, and a throw there ends the read', async () => {
    let calls = 0;
    const { reader } = scripted(pages());
    await read(untouched, reader, { keys: accepting([messages[5]]), pageBudget: 10, onPage: async () => void (calls += 1) });
    expect(calls).toBe(3);

    const { reader: again, served } = scripted(pages());
    await expect(
      read(untouched, again, {
        keys: accepting([messages[5]]),
        pageBudget: 10,
        onPage: async () => {
          throw new Error('lease lost');
        },
      }),
    ).rejects.toThrow('lease lost');
    expect(served).toEqual([0]);
  });

  it('stops when the caller says to pause, still returning what it holds', async () => {
    const { reader } = scripted(pages());
    const result = await read(untouched, reader, { keys: accepting([messages[5]]), pageBudget: 10 }, { shouldContinue: async () => false });
    expect(result).toMatchObject({ status: 'paused', pages: 1 });
    expect(result.accepted).toMatchObject({ stop: 'paused' });
  });
});

describe('a guard refusal, and the resume state', () => {
  it('a refusal on page 2 throws and writes nothing: no store, no ledger, no source patch, no error record', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const { reader, served } = scripted([page([wanted]), page([message('m2', 'Weekly note')])], { throwAtPage: 1 });
    const counts = emptyCounts();
    await expect(read(untouched, reader, { keys: accepting([wanted, message('m2', 'x')]), pageBudget: 10 }, { counts })).rejects.toBeInstanceOf(
      MailboxAccessRefusedError,
    );
    expect(served).toEqual([0]);
    expect(counts).toMatchObject({ pages: 1, stored: 0, checkpointAdvanced: false });
  });

  it('reads from nothing, writes no checkpoint, completion or backfill window, and leaves the caller\'s row as it was', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const row = completed();
    const before = structuredClone(row);
    const { reader, asked } = scripted([page([wanted])]);
    const result = await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10 }, { source: row });
    expect(result).toMatchObject({ mode: 'backfill', checkpointAdvanced: false });
    expect(asked).toHaveLength(1);
    expect(asked[0].checkpoint).toBeNull();
    expect(asked[0].source.deltaCheckpoint).toBeNull();
    expect(row).toEqual(before);
  });

  it('narrows the window to the day it is given, never earlier than the source\'s own', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const windowOf = async (backfillSince: string | null | undefined, windowFrom: string | undefined) => {
      const { reader, asked } = scripted([page([wanted])]);
      await read(untouched, reader, { keys: accepting([wanted]), pageBudget: 10, windowFrom }, { source: source({ backfillSince }) });
      return asked[0].source.backfillSince;
    };
    expect(await windowOf('2026-01-01', '2026-02-01')).toBe('2026-02-01');
    expect(await windowOf('2026-03-01', '2026-02-01')).toBe('2026-03-01');
    expect(await windowOf(null, '2026-02-01')).toBe('2026-02-01');
    expect(await windowOf('2026-01-01', undefined)).toBe('2026-01-01');
    expect(await windowOf('2026-01-01', 'not a day')).toBe('2026-01-01');
  });

  it('is exclusive with a proposal run', async () => {
    const { reader } = scripted([page([])]);
    await expect(
      read(untouched, reader, { keys: new Map(), pageBudget: 1 }, { propose: {} as never }),
    ).rejects.toThrow('exclusive');
  });
});
