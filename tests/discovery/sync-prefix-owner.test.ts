// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { firmRouting, RoutingContext, syncSource, type SyncSource } from '../../worker/sync';
import { memoryPersistDb } from './memoryPersistDb';

// The owner clause of the subject prefix rule (#653): a page is one mailbox, so syncSource hands the router that
// mailbox's own address as its owner. The real routeByFirmRules and persistItems run over a fake reader and an
// in-memory client; routing.routed is the verdict.

const TENANT = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const OWNER = 'storm.duncan@bank.example';

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: OWNER,
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

const sentBy = (from: string, id: string, subject: string): MailMessage => ({
  id,
  internetMessageId: `<${id}@bank.example>`,
  conversationId: `conv-${id}`,
  subject,
  sentDateTime: '2026-03-02T09:00:00Z',
  from: { emailAddress: { name: null, address: from } },
  toRecipients: [{ emailAddress: { name: null, address: 'casey@osprey-capital.example' } }],
  ccRecipients: [],
  body: { contentType: 'text', content: `Body of ${id}.` },
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

/** A Sent Items page: the owner alone, two topics with one reply. */
const ownerPage = (): SourceItemPage[] => [
  {
    items: [sentBy(OWNER, 'm1', 'Kestrel: lender feedback'), sentBy(OWNER, 'm2', 'RE: Kestrel: site visit')],
    nextCheckpoint: 'cp-1',
  },
];

const run = (pages: SourceItemPage[], over: Partial<SyncSource> = {}) => {
  const context = new RoutingContext();
  context.internalDomains = ['bank.example'];
  return syncSource(memoryPersistDb().db, { source: source(over), reader: readerOf(pages), runId, context });
};

describe('syncSource passes the source address as the mailbox owner (#653)', () => {
  it('routes an owner-replied page under the owner\'s own source', async () => {
    const result = await run(ownerPage());
    expect(result.routing).toMatchObject({ routed: 2, unrouted: 0 });
    expect(result.routing.codenameKeys).toEqual(new Set(['kestrel']));
  });

  it('matches the owner whatever the case of the source address', async () => {
    const result = await run(ownerPage(), { address: 'Storm.Duncan@Bank.example' });
    expect(result.routing).toMatchObject({ routed: 2, unrouted: 0 });
  });

  it('does not route the same page under another source address: the owner never appears as From', async () => {
    const result = await run(ownerPage(), { address: 'alex.chen@bank.example' });
    expect(result.routing).toMatchObject({ routed: 0, unrouted: 2 });
  });

  it('does not route an owner who only writes originals', async () => {
    const result = await run([
      { items: [sentBy(OWNER, 'm1', 'Kestrel: lender feedback'), sentBy(OWNER, 'm2', 'Kestrel: site visit')], nextCheckpoint: 'cp-1' },
    ]);
    expect(result.routing).toMatchObject({ routed: 0, unrouted: 2 });
  });
});

describe('firmRouting (#653)', () => {
  it('returns the lowercased domains and an id to lowercased address map of one read', () => {
    const { internalDomains, sourceOwners } = firmRouting([
      { id: 's1', address: 'Storm.Duncan@Bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' },
      { id: 's2', address: 'alex.chen@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u2' },
    ]);
    expect(internalDomains).toEqual(['bank.example', 'bank.example']);
    expect(sourceOwners).toEqual(
      new Map([
        ['s1', 'storm.duncan@bank.example'],
        ['s2', 'alex.chen@bank.example'],
      ]),
    );
  });

  it('skips an address without a domain for the domains, and is empty without sources', () => {
    expect(firmRouting([{ id: 's1', address: 'not-an-address', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' }]).internalDomains).toEqual([]);
    expect(firmRouting([])).toEqual({ internalDomains: [], sourceOwners: new Map(), shared: new Set() });
  });

  it('names the shared sources: a team inbox, or a mailbox with no owner; a person\'s mailbox is not shared (#173 G-09)', () => {
    const { shared } = firmRouting([
      { id: 'person', address: 'ana@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' },
      { id: 'team', address: 'deals@bank.example', kind: 'mailbox', team_mailbox_id: 'tm1', owner_user_id: null },
      { id: 'ownerless', address: 'archive@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: null },
      // A team registration wins even if an owner is recorded.
      { id: 'team-owned', address: 'ops@bank.example', kind: 'mailbox', team_mailbox_id: 'tm2', owner_user_id: 'u2' },
    ]);
    expect(shared).toEqual(new Set(['team', 'ownerless', 'team-owned']));
  });

  it('admits a SharePoint site as a person\'s source: no owner by design, so it keeps the routing it had (audit G4)', () => {
    const { shared } = firmRouting([
      { id: 'site', address: 'deals.sharepoint.example', kind: 'sharepoint_site', team_mailbox_id: null, owner_user_id: null },
      { id: 'ownerless', address: 'archive@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: null },
    ]);
    expect(shared).toEqual(new Set(['ownerless']));
  });

  it('makes a mailbox whose owner user was deleted (owner_user_id set null) shared, the stricter side (audit G8)', () => {
    const before = firmRouting([{ id: 'm', address: 'ana@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' }]);
    const after = firmRouting([{ id: 'm', address: 'ana@bank.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: null }]);
    expect([before.shared.has('m'), after.shared.has('m')]).toEqual([false, true]);
  });
});
