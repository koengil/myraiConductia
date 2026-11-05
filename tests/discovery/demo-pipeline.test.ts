import { describe, expect, it } from 'vitest';

import { ROUTE_METHOD } from '@/lib/constants/discovery';
import { clusterCandidates } from '@/lib/discovery/discover/cluster';
import { routeByFirmRules, type RoutedItem } from '@/lib/discovery/route/firmRules';
import { DEMO_LATE_DIR, demoItems } from './demoCorpus';
import { fixtureItems, INTERNAL_DOMAINS } from './fixtureCorpus';

// The demo superset (base fixture plus the Kestrel, Harbor and Osprey mail)
// through develop's own normalize, route and cluster code. Expected values
// live here, as in firm-rules.test.ts; the corpus carries no labels.

const routed = routeByFirmRules(demoItems(), { scope: 'unscoped' });
const routedOnly = routed.filter((r) => r.routes.length > 0);
const groups = clusterCandidates(routedOnly, { internalDomains: INTERNAL_DOMAINS });
const byKey = (k: string) => groups.filter((g) => g.clusterKey.startsWith(`codename:${k}`));
const routesOf = (id: string) => routed.find((r) => r.item.internetMessageId === id)?.routes ?? [];

describe('the demo corpus through the discovery pipeline', () => {
  it('forms one cluster each for Kestrel, Harbor and Osprey', () => {
    expect(byKey('kestrel')).toHaveLength(1); // May to Sep 2026: no 540-day split
    expect(byKey('kestrel')[0].links).toHaveLength(18); // 16 + bidq-001 + bidq-002
    expect(byKey('harbor')).toHaveLength(1);
    expect(byKey('harbor')[0].links).toHaveLength(3);
    expect(byKey('osprey')).toHaveLength(1);
    expect(byKey('osprey')[0].links).toHaveLength(8);
  });

  it('names each cluster by its codename and its outside parties by domain', () => {
    expect(byKey('kestrel')[0].proposedName).toBe('Project Kestrel');
    expect(byKey('kestrel')[0].parties.map((p) => p.domain)).toEqual(
      expect.arrayContaining(['northwind-robotics.example', 'aldermoor.example', 'castellan.example']),
    );
    expect(byKey('harbor')[0].parties).toEqual([{ name: 'Northwind Robotics', domain: 'northwind-robotics.example' }]);
    expect(byKey('osprey')[0].parties.map((p) => p.domain).sort()).toEqual([
      'larkspur-health.example',
      'meridian-care.example',
    ]);
  });

  it('keeps the base outcomes: Falcon 6, Cobra 2, and no demo item joins them', () => {
    const base = routeByFirmRules(fixtureItems(), { scope: 'unscoped' });
    const baseIds = new Set(base.map((r) => r.item.internetMessageId));
    const inDemo = (key: string) => routed.filter((r) => r.routes.some((x) => x.codenameKey === key));
    expect(inDemo('falcon')).toHaveLength(6);
    expect(inDemo('cobra')).toHaveLength(2);
    for (const key of ['falcon', 'cobra']) {
      expect(inDemo(key).every((r) => baseIds.has(r.item.internetMessageId))).toBe(true);
    }
    // Every base item routes exactly as it does on the base fixture alone.
    for (const entry of base) {
      expect(routesOf(entry.item.internetMessageId)).toEqual(entry.routes);
    }
  });

  it('routes only base items, Kestrel, Harbor and Osprey mail, and no noise', () => {
    const keys = new Set(routed.flatMap((r) => r.routes.map((x) => x.codenameKey)));
    expect([...keys].sort()).toEqual(['cobra', 'falcon', 'harbor', 'kestrel', 'osprey']);
    for (const r of routed.filter((x) => x.item.internetMessageId.startsWith('<noise-'))) {
      expect(r.routes).toEqual([]);
    }
  });

  it('gives Alex no routed item, so the member empty state holds', () => {
    const alexHolds = (r: RoutedItem) => r.observations.some((o) => o.sourceId === 'alex.chen@bank.example');
    expect(routedOnly.filter(alexHolds)).toEqual([]);
  });

  it('continues the bid-clarification thread and stops at the reply that lost its references', () => {
    expect(routesOf('<bidq-001@bank.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'kestrel', method: ROUTE_METHOD.CODENAME }),
    ]);
    expect(routesOf('<bidq-002@castellan.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'kestrel', method: ROUTE_METHOD.THREAD_CONTINUATION }),
    ]);
  });

  it('leaves the triage reply unrouted on this router (tentative only with Task A)', () => {
    expect(routesOf('<bidq-003@castellan.example>')).toEqual([]);
  });

  it('routes each codename by its own mail and never crosses deals', () => {
    for (const r of routedOnly) {
      const id = r.item.internetMessageId;
      const expected = /^<(kestrel|harbor|osprey|bidq)-/.exec(id)?.[1];
      if (!expected) continue;
      const key = expected === 'bidq' ? 'kestrel' : expected;
      expect(r.routes.map((x) => x.codenameKey), id).toEqual([key]);
    }
  });

  it('routes the late mail to Kestrel', () => {
    const late = routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' });
    for (const id of ['<kestrel-017@bank.example>', '<kestrel-018@aldermoor.example>']) {
      expect(late.find((r) => r.item.internetMessageId === id)?.routes).toEqual([
        expect.objectContaining({ codenameKey: 'kestrel' }),
      ]);
    }
    // The seeded set is unchanged by the late mail and appears without it.
    expect(routed.some((r) => r.item.internetMessageId === '<kestrel-017@bank.example>')).toBe(false);
    const lateGroups = clusterCandidates(
      late.filter((r) => r.routes.length > 0),
      { internalDomains: INTERNAL_DOMAINS },
    );
    expect(lateGroups.find((g) => g.clusterKey === 'codename:kestrel')?.links).toHaveLength(20);
  });
});
