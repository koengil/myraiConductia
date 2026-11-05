import { describe, expect, it } from 'vitest';

import { ROUTE_METHOD } from '@/lib/constants/discovery';
import { clusterCandidates, partyNameFromDomain, WINDOW_GAP_DAYS } from '@/lib/discovery/discover/cluster';
import { normalizeMessage } from '@/lib/discovery/normalize';
import { routeByFirmRules, type RoutedItem } from '@/lib/discovery/route/firmRules';
import { fixtureItems, INTERNAL_DOMAINS } from './fixtureCorpus';

const routed = routeByFirmRules(fixtureItems(), { scope: 'unscoped' }).filter((r) => r.routes.length > 0);
const groups = clusterCandidates(routed, { internalDomains: INTERNAL_DOMAINS });

describe('clusterCandidates over the fixture corpus', () => {
  it('proposes Cobra and Falcon, keyed by codename', () => {
    expect(groups.map((g) => g.clusterKey)).toEqual(['codename:cobra', 'codename:falcon']);
  });

  it('gives Falcon its six items, date range and outside party', () => {
    const falcon = groups.find((g) => g.clusterKey === 'codename:falcon')!;
    expect(falcon.proposedName).toBe('Project Falcon');
    expect(falcon.links).toHaveLength(6);
    expect(falcon.firstSeenAt).toBe('2026-02-03T09:12:00.000Z');
    expect(falcon.lastSeenAt).toBe('2026-02-20T16:05:00.000Z');
    expect(falcon.parties).toEqual([{ name: 'Heliotrope', domain: 'heliotrope.example' }]);
    expect(falcon.confidence).toBe(0.95);
    expect(falcon.links.map((l) => l.method)).toContain(ROUTE_METHOD.THREAD_CONTINUATION);
  });

  it('never lists the firm itself as a party', () => {
    for (const group of groups) {
      expect(group.parties.map((p) => p.domain)).not.toContain('bank.example');
    }
    const cobra = groups.find((g) => g.clusterKey === 'codename:cobra')!;
    expect(cobra.parties).toEqual([{ name: 'Cobalt Systems', domain: 'cobalt-systems.example' }]);
  });

  it('is deterministic', () => {
    expect(clusterCandidates(routed, { internalDomains: INTERNAL_DOMAINS })).toEqual(groups);
  });

  it(`splits a codename reused after more than ${WINDOW_GAP_DAYS} days into a second candidate`, () => {
    const at = (id: string, sent: string): RoutedItem => ({
      item: normalizeMessage({
        id,
        internetMessageId: `<${id}@bank.example>`,
        conversationId: null,
        subject: 'Project Falcon',
        sentDateTime: sent,
        from: null,
        toRecipients: [],
        ccRecipients: [],
        body: { contentType: 'text', content: '' },
      }),
      observations: [{ sourceId: 's', providerItemId: id }],
      routes: [{ codenameKey: 'falcon', codename: 'Project Falcon', method: 'codename', confidence: 0.95 }],
    });
    const split = clusterCandidates([at('a', '2021-01-01T00:00:00Z'), at('b', '2026-01-01T00:00:00Z')], {
      internalDomains: [],
    });
    expect(split.map((g) => g.clusterKey)).toEqual(['codename:falcon', 'codename:falcon#2']);
  });
});

describe('partyNameFromDomain', () => {
  it('title-cases the first label', () => {
    expect(partyNameFromDomain('cobalt-systems.example')).toBe('Cobalt Systems');
    expect(partyNameFromDomain('heliotrope.example')).toBe('Heliotrope');
  });
});
