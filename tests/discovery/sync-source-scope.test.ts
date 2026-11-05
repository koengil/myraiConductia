// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { emptyReadTally, RoutingContext, syncSource, type SyncResult, type SyncSource } from '../../worker/sync';
import { memoryPersistDb } from './memoryPersistDb';

// Source scope on the per-page path (#173 G-09 3/6). The real syncSource, routeByFirmRules and persistItems run over a
// fake reader and an in-memory client, with one RoutingContext carried across the pages of different sources as a run
// carries it. DEALS is a shared source (a team inbox); ANA and LENA are people's mailboxes. A name taught only in one
// side's mail does not route the other side's, in either direction.

const TENANT = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const DEALS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LENA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const source = (id: string, address: string, over: Partial<SyncSource> = {}): SyncSource => ({
  id,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address,
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

const deals = () => source(DEALS, 'deals@harrow.example', { teamMailboxId: 'tm-1' });
const ana = () => source(ANA, 'ana@harrow.example', { ownerUserId: 'user-ana' });
const lena = () => source(LENA, 'lena@harrow.example', { ownerUserId: 'user-lena' });

const mail = (id: string, subject: string, body = 'See attached.', conversationId = `conv-${id}`): MailMessage => ({
  id,
  internetMessageId: `<${id}@harrow.example>`,
  conversationId,
  subject,
  sentDateTime: '2026-03-02T09:00:00Z',
  from: { emailAddress: { name: null, address: 'tom@harrow.example' } },
  toRecipients: [{ emailAddress: { name: null, address: 'casey@buyer.example' } }],
  ccRecipients: [],
  body: { contentType: 'text', content: body },
});

const readerOf = (pages: SourceItemPage[]): ContentSource => ({
  kind: SOURCE_KIND.MAILBOX,
  backfill: async function* () {
    yield* pages;
  },
  delta: async function* () {
    yield* pages;
  },
});

/** A context as loadRoutingContext builds it for this tenant: DEALS is the only shared source. */
const scoped = () => {
  const context = new RoutingContext();
  context.scope = { shared: new Set([DEALS]) };
  return context;
};

const page = (items: MailMessage[], n = 1): SourceItemPage[] => [{ items, nextCheckpoint: `cp-${n}` }];

type Db = ReturnType<typeof memoryPersistDb>['db'];
const read = (db: Db, context: RoutingContext, src: SyncSource, items: MailMessage[], extra: { n?: number } = {}): Promise<SyncResult> =>
  syncSource(db, { source: src, reader: readerOf(page(items, extra.n)), runId, context });

describe('a shared page does not route on a name taught only in a personal page, and the reverse', () => {
  it('refuses a bare name in deals@ that only Ana wrote as "Project Fallow", and counts the refusal', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    const first = await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    expect(first.routing).toMatchObject({ routed: 1, unrouted: 0, scopeBlocked: 0 });

    const second = await read(db, context, deals(), [mail('d1', 'Fallow bidder call')]);
    expect(second.routing).toMatchObject({ routed: 0, unrouted: 1, scopeBlocked: 1 });
    expect(second.storedKeys.size).toBe(0);
  });

  it('routes the same bare name once the scope is lifted, so the refusal above is the scope and nothing else', async () => {
    const { db } = memoryPersistDb();
    const context = new RoutingContext();
    await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    const second = await read(db, context, deals(), [mail('d1', 'Fallow bidder call')]);
    expect(second.routing).toMatchObject({ routed: 1, unrouted: 0, scopeBlocked: 0 });
  });

  it('refuses a bare name in Ana\'s mailbox that only deals@ wrote as "Project Aster"', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    const first = await read(db, context, deals(), [mail('d1', 'Project Aster: CIM draft')]);
    expect(first.routing).toMatchObject({ routed: 1, scopeBlocked: 0 });

    const second = await read(db, context, ana(), [mail('a1', 'Aster call tomorrow')]);
    expect(second.routing).toMatchObject({ routed: 0, unrouted: 1, scopeBlocked: 1 });
  });

  it('still routes a bare name in the shared source that wrote the literal itself', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    await read(db, context, deals(), [mail('d1', 'Project Aster: CIM draft')], { n: 1 });
    const again = await read(db, context, deals(), [mail('d2', 'Aster lender list')], { n: 2 });
    expect(again.routing).toMatchObject({ routed: 1, unrouted: 0, scopeBlocked: 0 });
  });

  it('keeps pooling across personal mailboxes as built: Lena routes on a name only Ana wrote', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    const second = await read(db, context, lena(), [mail('l1', 'Fallow lender call')]);
    expect(second.routing).toMatchObject({ routed: 1, unrouted: 0, scopeBlocked: 0 });
  });

  it('refuses a reply in deals@ to a thread whose root only Ana\'s mailbox routed', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    // The root names the deal in its body only; the reply drops it, so only the thread can route the reply.
    await read(db, context, ana(), [mail('a1', 'Lender list', 'About Project Bramble.', 'conv-bramble')]);
    const reply = mail('d1', 'RE: Lender list', 'Thanks, aligned.', 'conv-bramble');
    const shared = await read(db, context, deals(), [reply]);
    expect(shared.routing).toMatchObject({ routed: 0, unrouted: 1, scopeBlocked: 1 });
    // The same reply in a personal mailbox continues the thread, as it always did.
    const personal = await read(db, context, lena(), [{ ...reply, id: 'l1', internetMessageId: '<l1@harrow.example>' }]);
    expect(personal.routing).toMatchObject({ routed: 1, scopeBlocked: 0 });
  });
});

describe('what the context remembers', () => {
  it('records the sources whose mail wrote the literal, and a refused or alias route adds none', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    await read(db, context, deals(), [mail('d1', 'Fallow bidder call')]); // refused
    await read(db, context, lena(), [mail('l1', 'Fallow lender call')]); // an alias route in a personal mailbox
    expect(context.codenames.get('fallow')?.taughtIn).toEqual(new Set([ANA]));
  });

  it('a deal known only as a candidate has taught nowhere until a literal in a source does', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    context.addCodename('cobra', 'Project Cobra');
    expect(context.codenames.get('cobra')?.taughtIn).toEqual(new Set());
    const blocked = await read(db, context, deals(), [mail('d1', 'Cobra update')]);
    expect(blocked.routing).toMatchObject({ routed: 0, scopeBlocked: 1 });

    await read(db, context, deals(), [mail('d2', 'Project Cobra: NDA')], { n: 2 });
    expect(context.codenames.get('cobra')?.taughtIn).toEqual(new Set([DEALS]));
    const admitted = await read(db, context, deals(), [mail('d3', 'Cobra update again')], { n: 3 });
    expect(admitted.routing).toMatchObject({ routed: 1, scopeBlocked: 0 });
  });
});

describe('scopeBlocked in the read tally', () => {
  it('sums across pages into options.read, beside a partition that still adds up', async () => {
    const { db } = memoryPersistDb();
    const context = scoped();
    await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    const tally = emptyReadTally();
    const pages: SourceItemPage[] = [
      { items: [mail('d1', 'Fallow bidder call'), mail('d2', 'Lunch on Friday')], nextCheckpoint: 'cp-1' },
      { items: [mail('d3', 'Fallow term sheet')], nextCheckpoint: 'cp-2' },
    ];
    const result = await syncSource(db, { source: deals(), reader: readerOf(pages), runId, context, read: tally });

    expect(result.routing.scopeBlocked).toBe(2);
    expect(tally.routing.scopeBlocked).toBe(2);
    expect(tally.routing).toMatchObject({ routed: 0, unrouted: 3, skipped: 0, collisions: 0 });
    expect(tally.routing.routed + tally.routing.unrouted + tally.routing.skipped + tally.routing.collisions).toBe(tally.itemsRead);
  });

  it('is 0 for an unscoped context, whatever it reads', async () => {
    const { db } = memoryPersistDb();
    const context = new RoutingContext();
    await read(db, context, ana(), [mail('a1', 'Project Fallow: kickoff')]);
    const result = await read(db, context, deals(), [mail('d1', 'Fallow bidder call')]);
    expect(result.routing.scopeBlocked).toBe(0);
  });
});
