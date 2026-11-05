// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { dedupeObservations, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { messageKey } from '@/lib/discovery/persist';
import { modelProposalRoute, type RoutedItem } from '@/lib/discovery/route/firmRules';
import type { ContentSource, MailMessage } from '@/lib/discovery/source/types';
import { acceptKeys, commitAccepted } from '../../worker/accept';
import {
  emptyAcceptBuffer,
  heldAcceptedKeys,
  loadRoutingContext,
  RoutingContext,
  syncSource,
  type SyncSource,
} from '../../worker/sync';
import { memoryPersistDb } from './memoryPersistDb';

// The accept's route (G-02b #173, design R5): `model_proposal`, durable and non-teaching. The commit stores it; a later
// pass keeps the message routed from the exact keys of a done accept (loadRoutingContext); and it teaches the router no
// codename, thread or alias, so a reply nobody accepted is never pulled in by it.

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_A = '33333333-3333-4333-8333-333333333333';
const SOURCE_B = '55555555-5555-4555-8555-555555555555';
const RUN = '22222222-2222-4222-8222-222222222222';

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
const deduped = (m: MailMessage, sourceId = SOURCE_A): DedupedItem =>
  dedupeObservations([{ sourceId, providerItemId: m.id, item: normalizeMessage(m) }]).items[0];

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: SOURCE_A,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: 'storm.duncan@bank.example',
  ownerUserId: '44444444-4444-4444-8444-444444444444',
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

/** A reader whose backfill yields each argument as a page. */
const readerOf = (...pages: MailMessage[][]): ContentSource => ({
  kind: SOURCE_KIND.MAILBOX,
  backfill: async function* () {
    for (const [index, items] of pages.entries()) yield { items, nextCheckpoint: `cp-${index}` };
  },
  delta: async function* () {
    throw new Error('not read');
  },
});

describe('the commit stores the accepted messages with the model_proposal route', () => {
  it('routed, method model_proposal, text kept, and no skip or thread taint written', async () => {
    const wanted = message('m1', 'Lunch on Friday');
    const buffer = emptyAcceptBuffer();
    buffer.items.set(keyOf(wanted), { ...deduped(wanted), routes: [] });
    buffer.tags.set('<m1@bank.example>', []);

    const memory = memoryPersistDb();
    const rpcs: string[] = [];
    const db = {
      from: (memory.db as unknown as { from: SupabaseClient['from'] }).from,
      rpc: async (name: string, args: never) => {
        rpcs.push(name);
        return (memory.db as unknown as { rpc: (n: string, a: never) => Promise<unknown> }).rpc(name, args);
      },
    } as unknown as SupabaseClient;

    const result = await commitAccepted(db, { tenantId: TENANT, runId: RUN, buffer });

    expect(result!.storedKeys).toEqual(['<m1@bank.example>']);
    expect(memory.items.has('<m1@bank.example>')).toBe(true);
    expect(memory.ledger.get(`${SOURCE_A}\u0000m1`)).toMatchObject({ decision: 'routed', method: 'model_proposal', confidence: 1 });
    expect(rpcs).toEqual(['discovery_message_index_record']);
    expect(memory.patches).toEqual([]);
  });

  it('an empty buffer writes nothing', async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('touched'); } }) as unknown as SupabaseClient;
    expect(await commitAccepted(untouched, { tenantId: TENANT, runId: RUN, buffer: emptyAcceptBuffer() })).toBeNull();
  });

  it('acceptKeys groups the hashes of one key', () => {
    const keys = acceptKeys([
      { message_key: 'a'.repeat(64), item_hash: '1'.repeat(64) },
      { message_key: 'a'.repeat(64), item_hash: '2'.repeat(64) },
      { message_key: 'b'.repeat(64), item_hash: '3'.repeat(64) },
    ]);
    expect(keys.get('a'.repeat(64))).toEqual(new Set(['1'.repeat(64), '2'.repeat(64)]));
    expect(keys.size).toBe(2);
  });
});

describe('the route teaches the router nothing', () => {
  it('RoutingContext.learn adds no codename, thread or alias from a model_proposal route', () => {
    const context = new RoutingContext();
    const entry: RoutedItem = { ...deduped(message('m1', 'Project Falcon: kickoff', { conversationId: 'conv-1' })), routes: [modelProposalRoute()] };
    context.learn([entry]);
    expect(context.codenames.size).toBe(0);
    expect(context.threads.size).toBe(0);
    expect(context.options().knownCodenames).toEqual([]);
  });

  it('a durable route keeps the message routed on a later pass, and a reply on a later page of its thread stays unrouted', async () => {
    const accepted = message('m1', 'Kickoff call', { conversationId: 'conv-1' });
    const reply = message('m2', 'Re: Kickoff call', { conversationId: 'conv-1', body: { contentType: 'text', content: 'Thanks.' } });
    const context = new RoutingContext();
    context.addModelKeys(SOURCE_A, [keyOf(accepted)]);

    const memory = memoryPersistDb();
    const result = await syncSource(memory.db, { source: source(), reader: readerOf([accepted], [reply]), runId: RUN, context });

    expect(memory.ledger.get(`${SOURCE_A}\u0000m1`)).toMatchObject({ decision: 'routed', method: 'model_proposal' });
    expect(memory.items.has('<m1@bank.example>')).toBe(true);
    // The reply is in the accepted message's thread, and nothing was taught: it is not pulled in.
    expect(memory.ledger.get(`${SOURCE_A}\u0000m2`)).toMatchObject({ decision: 'unrouted', method: null });
    expect(memory.items.has('<m2@bank.example>')).toBe(false);
    expect(context.codenames.size).toBe(0);
    expect(context.threads.size).toBe(0);
    expect(result.routing).toMatchObject({ routed: 1, unrouted: 1 });
    // The route has no codename, so it adds none to the tally either.
    expect(result.routing.codenameKeys.size).toBe(0);
  });

  it('control: without the durable key the same message is ledgered unrouted', async () => {
    const accepted = message('m1', 'Kickoff call', { conversationId: 'conv-1' });
    const memory = memoryPersistDb();
    await syncSource(memory.db, { source: source(), reader: readerOf([accepted]), runId: RUN, context: new RoutingContext() });
    expect(memory.ledger.get(`${SOURCE_A}\u0000m1`)).toMatchObject({ decision: 'unrouted' });
  });
});

describe('the route matches exact messages of exact sources only', () => {
  it('withModelRoutes routes a message the rules left alone, in the source that accepted it, and no other', () => {
    const accepted = message('m1', 'Lunch on Friday');
    const other = message('m2', 'Weekly note');
    const falcon = message('m3', 'Project Falcon: kickoff');
    const context = new RoutingContext();
    context.addModelKeys(SOURCE_A, [keyOf(accepted), keyOf(falcon)]);

    const unrouted = (m: MailMessage, sourceId = SOURCE_A): RoutedItem => ({ ...deduped(m, sourceId), routes: [] });
    const rulesRouted: RoutedItem = {
      ...deduped(falcon),
      routes: [{ codenameKey: 'falcon', codename: 'Project Falcon', method: 'codename', confidence: 0.95 }],
    };
    const shared: RoutedItem = {
      ...deduped(accepted),
      observations: [...deduped(accepted).observations, { sourceId: SOURCE_B, providerItemId: 'b1' }],
      routes: [],
    };

    const out = context.withModelRoutes(SOURCE_A, [unrouted(accepted), unrouted(other), rulesRouted, shared]);
    expect(out[0].routes.map((r) => [r.method, r.teaches])).toEqual([['model_proposal', false]]);
    expect(out[1].routes).toEqual([]);
    // The rules' route stays the rules' route.
    expect(out[2].routes.map((r) => r.method)).toEqual(['codename']);
    // A copy also read in another source is not this source's accepted message.
    expect(out[3].routes).toEqual([]);

    // The same message in another source is not routed by this source's accept.
    expect(context.withModelRoutes(SOURCE_B, [unrouted(accepted, SOURCE_B)])[0].routes).toEqual([]);
  });

  it('heldAcceptedKeys: only keys of a done accept whose item this source still holds', () => {
    const kept = message('m1', 'Lunch on Friday');
    const purged = message('m2', 'Weekly note');
    const unrelated = message('m3', 'Budget call');
    const items = [
      deduped(kept),
      // Stored by another source only: the accepting source's holder row was purged.
      deduped(purged, SOURCE_B),
      deduped(unrelated),
    ];
    const held = heldAcceptedKeys(items, [{ sourceId: SOURCE_A, keys: [keyOf(kept), keyOf(purged)] }]);
    expect(held).toEqual(new Map([[SOURCE_A, new Set([keyOf(kept)])]]));
    expect(heldAcceptedKeys(items, [])).toEqual(new Map());
  });
});

/**
 * A chainable stand-in for the service client's reads: each table answers its rows, whatever the filters (the rows are
 * prepared to match), cut to the range asked, with an exact count.
 */
function reading(tables: Record<string, unknown[]>): SupabaseClient {
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    let range: [number, number] | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      in: () => chain,
      order: () => chain,
      range: (a: number, b: number) => {
        range = [a, b];
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null, count: rows.length }),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe('loadRoutingContext makes a done accept durable', () => {
  it('routes the held keys of this source, and the purged and unrelated ones not at all', async () => {
    const kept = message('m1', 'Lunch on Friday');
    const purged = message('m2', 'Weekly note');
    const row = (id: string, m: MailMessage) => ({
      id,
      kind: 'message',
      internet_message_id: normalizeMessage(m).internetMessageId,
      drive_item_key: null,
      drive_path: null,
      conversation_id: null,
      subject: m.subject,
      sent_at: m.sentDateTime,
      participants: [],
      content_hash: normalizeMessage(m).contentHash,
    });
    const db = reading({
      content_sources: [
        { id: SOURCE_A, address: 'storm.duncan@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' },
        { id: SOURCE_B, address: 'morgan.vale@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u2' },
      ],
      deal_candidates: [],
      source_items: [row('i1', kept), row('i2', purged)],
      source_item_texts: [],
      source_item_sources: [
        { source_item_id: 'i1', content_source_id: SOURCE_A, provider_item_id: 'm1' },
        { source_item_id: 'i2', content_source_id: SOURCE_B, provider_item_id: 'b2' },
      ],
      discovery_model_proposal_accepts: [{ content_source_id: SOURCE_A, storing_keys: [keyOf(kept), keyOf(purged)] }],
    });

    const context = await loadRoutingContext(db, TENANT);

    expect(context.modelKeys).toEqual(new Map([[SOURCE_A, new Set([keyOf(kept)])]]));
    // Routed from the exact key; learned from by nothing.
    expect(context.codenames.size).toBe(0);
    expect(context.threads.size).toBe(0);
  });

  it('a tenant with no done accept has no durable keys', async () => {
    const context = await loadRoutingContext(
      reading({
        content_sources: [{ id: SOURCE_A, address: 'storm.duncan@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' }],
      }),
      TENANT,
    );
    expect(context.modelKeys.size).toBe(0);
  });
});
