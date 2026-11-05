// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { normalizeMessage } from '@/lib/discovery/normalize';
import { routeByFirmRules, type RoutingScope } from '@/lib/discovery/route/firmRules';
import { contextFromStored } from '../../worker/sync';

// Subject prefix evidence across pages (#173 G-09 3b). The worker routes one page of 10 at a time, so a prefix's two
// topics and two firm people can fall on different pages. RoutingContext carries each source's evidence (digests and
// counts) from every item the router saw, stored or not; the bootstrap seeds it from what the tenant stored. A prefix
// route still teaches nothing. DEALS is a shared source; ANA is a person's.

const FIRM = 'harrow.example';
const SCOPE: RoutingScope = { shared: new Set(['deals']) };
const NO_OWNERS = new Map<string, string>();

let n = 0;
const msg = (subject: string, o: { sources?: string[]; from?: string; conv?: string } = {}) => {
  n += 1;
  const item = normalizeMessage({
    id: `pp${n}`,
    internetMessageId: `<prefix-pages-${n}@harrow.example>`,
    conversationId: o.conv ?? null,
    subject,
    sentDateTime: '2026-05-01T10:00:00Z',
    from: { emailAddress: { address: o.from ?? 'tom@harrow.example', name: null } },
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: 'text', content: 'See attached.' },
  });
  return { item, observations: (o.sources ?? ['deals']).map((sourceId) => ({ sourceId, providerItemId: `pp${n}` })) };
};
const keys = (r: { routes: Array<{ codenameKey: string }> }) => r.routes.map((x) => x.codenameKey);
const fresh = () => contextFromStored([], [], SCOPE, { internalDomains: [FIRM], sourceOwners: NO_OWNERS });
const page = (context: ReturnType<typeof fresh>, items: ReturnType<typeof msg>[]) => {
  const routed = routeByFirmRules(items, { ...context.options(), sourceOwners: NO_OWNERS });
  context.notePrefixes(items, NO_OWNERS);
  return routed;
};

describe('RoutingContext carries subject prefix evidence page to page', () => {
  it('routes a prefix on the page where its evidence, started on an earlier unrouted page, reaches the bar', () => {
    const context = fresh();
    expect(page(context, [msg('Fenwick: lender list')]).map(keys)).toEqual([[]]);
    expect(page(context, [msg('Fenwick: VDR index', { from: 'ana@harrow.example' })]).map(keys)).toEqual([['fenwick']]);
    // And on every page after it.
    expect(page(context, [msg('Fenwick: management meeting')]).map(keys)).toEqual([['fenwick']]);
  });

  it('without the carried evidence, the same second page routes nothing (the per-page limit)', () => {
    const context = fresh();
    expect(page(context, [msg('Fenwick: VDR index', { from: 'ana@harrow.example' })]).map(keys)).toEqual([[]]);
  });

  it('keeps the evidence per source: a personal mailbox\'s pages never promote the team inbox\'s prefix', () => {
    const context = fresh();
    page(context, [msg('Fenwick: lender list', { sources: ['ana'] })]);
    expect(page(context, [msg('Fenwick: VDR index', { from: 'ana@harrow.example' })]).map(keys)).toEqual([[]]);
  });

  it('learns nothing from a prefix route: no codename and no thread for the alias or thread rules', () => {
    const context = fresh();
    page(context, [msg('Fenwick: lender list', { conv: 'c1' })]);
    const routed = page(context, [msg('Fenwick: VDR index', { from: 'ana@harrow.example', conv: 'c2' })]);
    context.learn(routed);
    expect(context.codenames.size).toBe(0);
    expect(context.threads.size).toBe(0);
  });
});

describe('contextFromStored seeds the prefix evidence from stored items', () => {
  const stored = () => [msg('Fenwick: lender list'), msg('Fenwick: VDR index', { from: 'ana@harrow.example' })];

  it('with the firm, a later run routes a new topic on the stored evidence', () => {
    const context = contextFromStored(stored(), [], SCOPE, { internalDomains: [FIRM], sourceOwners: NO_OWNERS });
    expect(page(context, [msg('Fenwick: management meeting')]).map(keys)).toEqual([['fenwick']]);
  });

  it('without the firm, the bootstrap seeds nothing', () => {
    const context = contextFromStored(stored(), [], SCOPE);
    expect(context.prefixEvidence.size).toBe(0);
  });

  it('counts a stored item in every source that observed it, and no other', () => {
    const items = [msg('Fenwick: lender list', { sources: ['deals', 'ana'] })];
    const context = contextFromStored(items, [], SCOPE, { internalDomains: [FIRM], sourceOwners: NO_OWNERS });
    expect([...context.prefixEvidence.keys()].sort()).toEqual(['ana', 'deals']);
  });
});
