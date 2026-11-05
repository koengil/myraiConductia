// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { normalizeMessage } from '@/lib/discovery/normalize';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import {
  loadRoutingContext,
  RoutingContext,
  routeStored,
  routingInputs,
  syncSource,
  type FirmSource,
  type SyncSource,
} from '../../worker/sync';
import { memoryPersistDb } from './memoryPersistDb';

// Subject prefix evidence on the worker's real paths (#173 G-09 3b, audit P1, P2, P5, review of #738). syncSource and persistItems run
// over a fake reader and an in-memory client; loadRoutingContext over a small table fake. DEALS is the team inbox;
// OLD is a person's mailbox that was disconnected under content_on_disconnect = 'keep' (archived, records kept).

const TENANT = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const DEALS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FIRM = 'harrow.example';

const deals = (): SyncSource => ({
  id: DEALS,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: `deals@${FIRM}`,
  ownerUserId: null,
  teamMailboxId: 'tm-1',
  deltaCheckpoint: null,
  backfillCompletedAt: null,
});

const mail = (id: string, subject: string, from: string, body = 'See attached.'): MailMessage => ({
  id,
  internetMessageId: `<${id}@${FIRM}>`,
  conversationId: `conv-${id}`,
  subject,
  sentDateTime: '2026-03-02T09:00:00Z',
  from: { emailAddress: { name: null, address: `${from}@${FIRM}` } },
  toRecipients: [{ emailAddress: { name: null, address: `deals@${FIRM}` } }],
  ccRecipients: [],
  body: { contentType: 'text', content: body },
});

const readerOf = (pages: MailMessage[][]): ContentSource => {
  const shaped: SourceItemPage[] = pages.map((items, i) => ({ items, nextCheckpoint: `cp-${i + 1}` }));
  return {
    kind: SOURCE_KIND.MAILBOX,
    backfill: async function* () {
      yield* shaped;
    },
    delta: async function* () {
      yield* shaped;
    },
  };
};

/** A context as loadRoutingContext builds it for a tenant whose only shared source is DEALS. */
const context = () => {
  const c = new RoutingContext();
  c.scope = { shared: new Set([DEALS]) };
  c.internalDomains = [FIRM];
  return c;
};

describe('syncSource carries prefix evidence across pages (audit P5)', () => {
  it('routes page 2 on the prefix evidence page 1 started, though page 1 routed nothing', async () => {
    const { db, items } = memoryPersistDb();
    const result = await syncSource(db, {
      source: deals(),
      reader: readerOf([[mail('p1', 'Fenwick: lender list', 'ana')], [mail('p2', 'Fenwick: VDR index', 'tom')]]),
      runId,
      context: context(),
    });
    expect(result.pages).toBe(2);
    expect([...items.keys()]).toEqual([`<p2@${FIRM}>`]);
  });
});

describe('a collision the store refuses adds no prefix evidence (audit P2)', () => {
  it('does not let a refused page-1 message supply the second topic and sender', async () => {
    // The tenant already stores <c1@> with other content. Page 1 brings a different message under that id: it routes on
    // its body literal, the store refuses it as a collision, and its "Fenwick:" subject must not count.
    const { db, items } = memoryPersistDb({ held: [{ internetMessageId: `<c1@${FIRM}>`, contentHash: 'other-content' }] });
    await syncSource(db, {
      source: deals(),
      reader: readerOf([
        [mail('c1', 'Fenwick: lender list', 'ana', 'Notes for Project Aster.')],
        [mail('p2', 'Fenwick: VDR index', 'tom')],
      ]),
      runId,
      context: context(),
    });
    expect(items.has(`<p2@${FIRM}>`)).toBe(false);
  });

  it('still counts a valid unrouted message on page 1', async () => {
    const { db, items } = memoryPersistDb({ held: [{ internetMessageId: `<c9@${FIRM}>`, contentHash: 'other-content' }] });
    await syncSource(db, {
      source: deals(),
      reader: readerOf([[mail('u1', 'Fenwick: lender list', 'ana')], [mail('p2', 'Fenwick: VDR index', 'tom')]]),
      runId,
      context: context(),
    });
    expect(items.has(`<p2@${FIRM}>`)).toBe(true);
  });
});

// ── Archived sources (audit P1) ─────────────────────────────────────────────

let n = 0;
const stored = (subject: string, from: string, sources: string[]) => {
  n += 1;
  return {
    item: normalizeMessage({ ...mail(`s${n}`, subject, from), conversationId: null }),
    observations: sources.map((sourceId) => ({ sourceId, providerItemId: `s${n}` })),
  };
};
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BEA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (id: string, o: Partial<FirmSource>): FirmSource => ({
  id,
  address: `${id.slice(0, 4)}@${FIRM}`,
  kind: 'mailbox',
  team_mailbox_id: null,
  owner_user_id: `u-${id.slice(0, 4)}`,
  archived_at: null,
  ...o,
});
const ARCHIVED = '2026-10-01T00:00:00Z';
const SOURCES: FirmSource[] = [
  row(DEALS, { address: `deals@${FIRM}`, team_mailbox_id: 'tm-1', owner_user_id: null }),
  row(OLD, { address: 'archived-eeee@invalid', archived_at: ARCHIVED }),
];
const keys = (r: { routes: Array<{ codenameKey: string }> }) => r.routes.map((x) => x.codenameKey);
const discover = (items: ReturnType<typeof stored>[], sources: FirmSource[]) => {
  const { internalDomains, sourceOwners, shared, archived } = routingInputs(sources);
  return routeStored(items, { internalDomains, sourceOwners, scope: { shared }, archived }).routed;
};
const live = (sources: FirmSource[]) => sources.map((s) => ({ ...s, archived_at: null }));

describe('an archived source still refuses, but no longer teaches or promotes (audit P1, review of #738)', () => {
  it('an archived team inbox keeps its barrier: an alias on an item it shares with a personal mailbox stays refused', () => {
    // martin-fp's finding 1: live personal mailbox A, team inbox T. #725 refuses the alias on the shared item.
    const T = DEALS;
    const sources = [row(ANA, {}), row(T, { address: `deals@${FIRM}`, team_mailbox_id: 'tm-1', owner_user_id: null })];
    const items = [stored('Project Fenwick kickoff', 'ana', [ANA]), stored('Fenwick buyer list', 'ana', [ANA, T])];
    expect(discover(items, sources).map(keys)).toEqual([['fenwick'], []]);
    const archivedT = sources.map((s) => (s.id === T ? { ...s, archived_at: ARCHIVED } : s));
    expect(discover(items, archivedT).map(keys)).toEqual([['fenwick'], []]);
  });

  it('an archived mailbox no longer teaches: its literal does not open an alias in another mailbox', () => {
    const sources = [row(ANA, {}), row(BEA, {})];
    const items = [stored('Project Heron kickoff', 'bea', [BEA]), stored('Heron bids', 'ana', [ANA])];
    expect(discover(items, sources).map(keys)).toEqual([['heron'], ['heron']]);
    const archivedB = sources.map((s) => (s.id === BEA ? { ...s, archived_at: ARCHIVED } : s));
    // The literal still routes its own item (a stored record); the alias it would have taught is refused.
    expect(discover(items, archivedB).map(keys)).toEqual([['heron'], []]);
  });

  it('promote: an archived mailbox\'s kept mail no longer promotes a prefix', () => {
    const items = [stored('Fenwick: lender list', 'ana', [OLD]), stored('Fenwick: VDR index', 'tom', [OLD])];
    expect(discover(items, live(SOURCES)).map(keys)).toEqual([['fenwick'], ['fenwick']]);
    expect(discover(items, SOURCES).map(keys)).toEqual([[], []]);
  });

  it('refuse: an archived mailbox that also held a deals@ message still refuses its prefix route (every observer)', () => {
    const items = [
      stored('Fenwick: lender list', 'ana', [DEALS]),
      stored('Fenwick: VDR index', 'tom', [DEALS]),
      stored('Fenwick: buyer list', 'ana', [DEALS, OLD]),
    ];
    expect(discover(items, live(SOURCES)).map(keys)).toEqual([['fenwick'], ['fenwick'], []]);
    expect(discover(items, SOURCES).map(keys)).toEqual([['fenwick'], ['fenwick'], []]);
  });

  it('keeps an archived source an observer, and shared if it was; its archive address names no domain or owner', () => {
    const archivedTeam = row(BEA, { team_mailbox_id: 'tm-2', owner_user_id: null, archived_at: ARCHIVED, address: 'x@invalid' });
    const inputs = routingInputs([...SOURCES, archivedTeam]);
    expect([...inputs.shared].sort()).toEqual([BEA, DEALS].sort());
    expect([...inputs.archived].sort()).toEqual([BEA, OLD].sort());
    expect([...inputs.sourceOwners.keys()]).toEqual([DEALS]);
    expect(inputs.internalDomains).toEqual([FIRM]);
  });
});

// ── loadRoutingContext over a table fake (audit P5) ─────────────────────────

/** Enough of the PostgREST builder for the bootstrap's reads: eq, in, not-is-null, order, range, exact count. */
function tableDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let slice: [number, number] | null = null;
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => ((rows = rows.filter((r) => r[column] === value)), builder),
      in: (column: string, values: unknown[]) => ((rows = rows.filter((r) => values.includes(r[column]))), builder),
      not: (column: string) => ((rows = rows.filter((r) => r[column] !== null && r[column] !== undefined)), builder),
      order: () => builder,
      range: (a: number, b: number) => ((slice = [a, b]), builder),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: slice ? rows.slice(slice[0], slice[1] + 1) : rows, error: null, count: rows.length }),
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

describe('loadRoutingContext seeds prefix evidence from live stored mail (audit P5, P1)', () => {
  const sourceRows = SOURCES.map((s) => ({ ...s, tenant_id: TENANT }));
  const item = (id: string, subject: string, from: string) => ({
    id,
    tenant_id: TENANT,
    kind: 'message',
    internet_message_id: `<${id}@${FIRM}>`,
    drive_item_key: null,
    drive_path: null,
    conversation_id: null,
    subject,
    sent_at: '2026-03-02T09:00:00Z',
    participants: [{ role: 'from', address: `${from}@${FIRM}`, name: null }],
    content_hash: `h-${id}`,
  });
  const route = (ctx: RoutingContext, subject: string) =>
    routeByPage(ctx, [stored(subject, 'tom', [DEALS])]).map(keys);
  const routeByPage = (ctx: RoutingContext, items: ReturnType<typeof stored>[]) =>
    routeStored(items, { ...ctx.options(), sourceOwners: new Map([[DEALS, `deals@${FIRM}`]]) }).routed;

  it('a new deals@ page routes on the evidence of mail deals@ already stores', async () => {
    const db = tableDb({
      [TABLE.CONTENT_SOURCES]: sourceRows,
      [TABLE.DEAL_CANDIDATES]: [],
      [TABLE.SOURCE_ITEMS]: [item('k1', 'Fenwick: lender list', 'ana')],
      [TABLE.SOURCE_ITEM_TEXTS]: [{ source_item_id: 'k1', body_text: 'See attached.' }],
      [TABLE.SOURCE_ITEM_SOURCES]: [{ source_item_id: 'k1', content_source_id: DEALS, provider_item_id: 'k1' }],
    });
    const ctx = await loadRoutingContext(db, TENANT);
    expect(route(ctx, 'Fenwick: VDR index')).toEqual([['fenwick']]);
  });

  it('kept mail of an archived mailbox seeds nothing', async () => {
    const db = tableDb({
      [TABLE.CONTENT_SOURCES]: sourceRows,
      [TABLE.DEAL_CANDIDATES]: [],
      [TABLE.SOURCE_ITEMS]: [item('k2', 'Fenwick: lender list', 'ana')],
      [TABLE.SOURCE_ITEM_TEXTS]: [{ source_item_id: 'k2', body_text: 'See attached.' }],
      [TABLE.SOURCE_ITEM_SOURCES]: [{ source_item_id: 'k2', content_source_id: OLD, provider_item_id: 'k2' }],
    });
    const ctx = await loadRoutingContext(db, TENANT);
    expect(ctx.prefixEvidence.has(OLD)).toBe(false);
    expect(route(ctx, 'Fenwick: VDR index')).toEqual([[]]);
  });
});
