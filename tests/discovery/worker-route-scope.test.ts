// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ROUTE_METHOD } from '@/lib/constants/discovery';
import { normalizeMessage } from '@/lib/discovery/normalize';
import { routeByFirmRules, threadKey, type RoutingScope } from '@/lib/discovery/route/firmRules';
import { contextFromStored, firmRouting, routeStored } from '../../worker/sync';

// The two pure helpers behind the worker's bootstrap and discovery paths (#173 G-09 3/6), without SQL. contextFromStored
// is what loadRoutingContext builds a context with; routeStored is discoverTenant's route. The stored items carry every
// source that observed them, as loadStoredItems returns them. DEALS is a shared source; ANA and LENA are people's.

const SCOPE: RoutingScope = { shared: new Set(['deals']) };

let n = 0;
const stored = (subject: string, o: { sources: string[]; body?: string; conv?: string; from?: string }) => {
  n += 1;
  const item = normalizeMessage({
    id: `w${n}`,
    internetMessageId: `<worker-scope-${n}@harrow.example>`,
    conversationId: o.conv ?? null,
    subject,
    sentDateTime: '2026-05-01T10:00:00Z',
    from: { emailAddress: { address: o.from ?? 'tom@harrow.example', name: null } },
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: 'text', content: o.body ?? 'See attached.' },
  });
  return { item, observations: o.sources.map((sourceId) => ({ sourceId, providerItemId: `w${n}` })) };
};
const keys = (r: { routes: Array<{ codenameKey: string }> }) => r.routes.map((x) => x.codenameKey);

describe('contextFromStored', () => {
  it('learns the sources of each literal, from every observation of the item', () => {
    const context = contextFromStored(
      [stored('Project Aster: CIM draft', { sources: ['deals', 'ana'] }), stored('Project Fallow: bids', { sources: ['ana'] })],
      [],
      SCOPE,
    );
    expect(context.scope).toBe(SCOPE);
    expect(context.codenames.get('aster')?.taughtIn).toEqual(new Set(['deals', 'ana']));
    expect(context.codenames.get('fallow')?.taughtIn).toEqual(new Set(['ana']));
  });

  it('does not launder: a shared-only key refused on a mixed copy stays taught in the shared source alone', () => {
    const items = [
      stored('Project Fallow: teaser draft', { sources: ['deals'] }),
      // Read in deals@ and in Ana's mailbox: the literal Aster teaches both, the bare Fallow is refused on the item.
      stored('Project Aster: weekly status', { sources: ['deals', 'ana'], body: 'Also, Fallow needs a decision on the teaser.' }),
    ];
    const context = contextFromStored(items, [], SCOPE);
    expect(context.codenames.get('aster')?.taughtIn).toEqual(new Set(['deals', 'ana']));
    expect(context.codenames.get('fallow')?.taughtIn).toEqual(new Set(['deals']));

    // So Lena's bare Fallow, routed with what the bootstrap learned, is refused.
    const lena = stored('Fallow teaser feedback', { sources: ['lena'] });
    expect(keys(routeByFirmRules([lena], { ...context.options() })[0])).toEqual([]);
    // Unscoped, the same context would route it: the bootstrap is what holds the line.
    expect(keys(routeByFirmRules([lena], { ...context.options(), scope: 'unscoped' })[0])).toEqual(['fallow']);
  });

  it('treats a candidate codename as taught nowhere: it admits nothing until a stored literal teaches it', () => {
    const candidates = [{ key: 'fallow', codename: 'Project Fallow' }];
    const bare = stored('Fallow bidder call', { sources: ['deals'] });
    const none = contextFromStored([bare], candidates, SCOPE);
    expect(none.codenames.get('fallow')).toEqual({ codename: 'Project Fallow', taughtIn: new Set() });
    expect(none.threads.size).toBe(0);
    expect(keys(routeByFirmRules([bare], { ...none.options() })[0])).toEqual([]);

    const taught = contextFromStored([bare, stored('Project Fallow: bids', { sources: ['deals'] })], candidates, SCOPE);
    expect(taught.codenames.get('fallow')?.taughtIn).toEqual(new Set(['deals']));
    expect(keys(routeByFirmRules([bare], { ...taught.options() })[0])).toEqual(['fallow']);
  });

  it('threads: a literal teaches its thread, an alias route inherits the key and adds no source, a refused route teaches nothing', () => {
    const items = [
      stored('Project Fallow: teaser draft', { sources: ['deals'] }),
      stored('Buyer list', { sources: ['ana'], conv: 'c1', body: 'About Project Briar.' }),
      // An alias route in deals@ (Fallow was taught there): its thread inherits {deals}.
      stored('Seller call', { sources: ['deals'], conv: 'c2', body: 'Fallow agenda attached.' }),
      // An alias route in Ana's mailbox is refused (Fallow has no personal teacher), so its thread learns nothing.
      stored('Seller call', { sources: ['ana'], conv: 'c3', body: 'Fallow agenda attached.' }),
    ];
    const context = contextFromStored(items, [], SCOPE);
    const thread = (conv: string, subject: string) =>
      context.threads.get(threadKey({ conversationId: conv, threadSubject: subject })!);
    expect(thread('c1', 'buyer list')?.get('briar')?.taughtIn).toEqual(new Set(['ana']));
    expect(thread('c2', 'seller call')?.get('fallow')?.taughtIn).toEqual(new Set(['deals']));
    expect(thread('c3', 'seller call')).toBeUndefined();
  });

  it('is the bootstrap of options(): the context carries its scope and each key\'s sources into the next route', () => {
    const context = contextFromStored([stored('Project Aster: CIM draft', { sources: ['deals'] })], [], SCOPE);
    const options = context.options();
    expect(options.scope).toBe(SCOPE);
    expect(options.knownCodenames).toEqual([{ key: 'aster', codename: 'Project Aster', taughtIn: new Set(['deals']) }]);
  });

  it('unscoped, it learns the same keys and routes every alias as before', () => {
    const items = [stored('Project Fallow: bids', { sources: ['ana'] }), stored('Fallow bidder call', { sources: ['deals'] })];
    const context = contextFromStored(items, [], 'unscoped');
    expect(context.scope).toBe('unscoped');
    expect([...context.codenames.keys()]).toEqual(['fallow']);
    expect(keys(routeByFirmRules([items[1]], { ...context.options() })[0])).toEqual(['fallow']);
  });
});

describe('routeStored', () => {
  const route = (items: ReturnType<typeof stored>[], extra: { knownCodenames?: Array<{ key: string; codename: string }> } = {}) =>
    routeStored(items, { ...extra, scope: SCOPE });

  it('re-routes the stored items together and counts what the scope refused', () => {
    const { routed, counts } = route([
      stored('Project Fallow: bids', { sources: ['ana'] }),
      stored('Fallow bidder call', { sources: ['deals'] }),
      stored('Fallow bidder call', { sources: ['lena'] }),
    ]);
    expect(routed.map(keys)).toEqual([['fallow'], [], ['fallow']]);
    expect(counts).toEqual({ scopeBlocked: 1 });
  });

  it('laundering case: Lena\'s bare name is refused after a mixed copy of shared-only knowledge', () => {
    const { routed, counts } = route([
      stored('Project Fallow: teaser draft', { sources: ['deals'] }),
      stored('Project Aster: weekly status', { sources: ['deals', 'ana'], body: 'Also, Fallow needs a decision on the teaser.' }),
      stored('Fallow teaser feedback', { sources: ['lena'] }),
      stored('Aster check-in', { sources: ['ana'] }),
      stored('Aster bidder call', { sources: ['deals'] }),
    ]);
    expect(routed.map(keys)).toEqual([['fallow'], ['aster'], [], ['aster'], ['aster']]);
    expect(counts.scopeBlocked).toBe(2);
  });

  it('mixed-copy cost: an item read in a personal and a shared source routes on neither side when only one taught the key', () => {
    const { routed, counts } = route([
      stored('Project Gorse: draft SPA', { sources: ['ana'] }),
      stored('Gorse diligence list', { sources: ['ana', 'deals'] }),
    ]);
    expect(routed.map(keys)).toEqual([['gorse'], []]);
    expect(counts.scopeBlocked).toBe(1);
  });

  it('threads: a shared reader of a personal root is refused, a personal reader continues it', () => {
    const { routed, counts } = route([
      stored('Buyer list', { sources: ['ana'], conv: 'c1', body: 'Draft list for Project Briar attached.' }),
      stored('RE: Buyer list', { sources: ['deals'], conv: 'c1' }),
      stored('RE: Buyer list', { sources: ['lena'], conv: 'c1' }),
    ]);
    expect(routed.map((r) => r.routes.map((x) => [x.codenameKey, x.method]))).toEqual([
      [['briar', ROUTE_METHOD.CODENAME]],
      [],
      [['briar', ROUTE_METHOD.THREAD_CONTINUATION]],
    ]);
    expect(counts.scopeBlocked).toBe(1);
  });

  it('candidate codenames carry no provenance: with no stored literal they route nothing, and the refusals are counted', () => {
    const { routed, counts } = route([stored('Fallow bidder call', { sources: ['deals'] })], {
      knownCodenames: [{ key: 'fallow', codename: 'Project Fallow' }],
    });
    expect(routed.map(keys)).toEqual([[]]);
    expect(counts.scopeBlocked).toBe(1);
  });

  it('unscoped, it counts nothing and routes everything the alias rule matches', () => {
    const { routed, counts } = routeStored(
      [stored('Project Fallow: bids', { sources: ['ana'] }), stored('Fallow bidder call', { sources: ['deals'] })],
      { scope: 'unscoped' },
    );
    expect(routed.map(keys)).toEqual([['fallow'], ['fallow']]);
    expect(counts).toEqual({ scopeBlocked: 0 });
  });

  it('passes the other options through: the owner clause of the subject prefix rule still reads sourceOwners', () => {
    const items = [
      stored('Kestrel: lender feedback', { sources: ['ana'], from: 'ana@harrow.example' }),
      stored('RE: Kestrel: site visit', { sources: ['ana'], from: 'ana@harrow.example' }),
    ];
    const owners = firmRouting([{ id: 'ana', address: 'ana@harrow.example', kind: 'mailbox', team_mailbox_id: null, owner_user_id: 'u1' }]).sourceOwners;
    const withOwner = routeStored(items, { internalDomains: ['harrow.example'], sourceOwners: owners, scope: SCOPE });
    expect(withOwner.routed.map(keys)).toEqual([['kestrel'], ['kestrel']]);
    const without = routeStored(items, { internalDomains: ['harrow.example'], scope: SCOPE });
    expect(without.routed.map(keys)).toEqual([[], []]);
  });
});
