// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { clusterCandidates } from '@/lib/discovery/discover/cluster';
import { dedupeObservations, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';

import { hasRecording, readReplay, RECORDED_DIR, TWIN_DIR } from '../google/replayHarness';
import { fixtureItems, INTERNAL_DOMAINS } from './fixtureCorpus';

// Parity (#259 phase 6): the same corpus, read through Graph's fixture and
// through the real Gmail ContentSource over a replay, must route and cluster
// identically. Everything after the reader is provider-neutral; this proves the
// Gmail reader's mapping (headers, threading by the References root, bodies)
// gives the pipeline the same input, not merely similar input.
//
// The replay is read in its last phase, `after-unspam`: the phase in which the
// mailbox holds the whole corpus (the two imported messages have arrived and
// the SPAM message is back in the inbox). Earlier phases are subsets by design.

function summarize(items: DedupedItem[]) {
  const routed = routeByFirmRules(items, { scope: 'unscoped' });
  const groups = clusterCandidates(
    routed.filter((entry) => entry.routes.length > 0),
    { internalDomains: INTERNAL_DOMAINS },
  );
  return {
    clusterKeys: groups.map((g) => g.clusterKey),
    itemsByCandidate: Object.fromEntries(groups.map((g) => [g.clusterKey, g.links.map((l) => l.internetMessageId).sort()])),
    methods: Object.fromEntries(
      routed
        .map((entry) => [entry.item.internetMessageId, entry.routes.map((r) => `${r.codenameKey}:${r.method}`).sort()] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    parties: Object.fromEntries(groups.map((g) => [g.clusterKey, g.parties])),
    window: Object.fromEntries(groups.map((g) => [g.clusterKey, [g.firstSeenAt, g.lastSeenAt]])),
  };
}

async function gmailItems(dir: string): Promise<DedupedItem[]> {
  const boxes = await readReplay(dir, 'after-unspam');
  return dedupeObservations(
    boxes.flatMap((box) =>
      box.items.map((m) => ({ sourceId: box.mailbox, providerItemId: m.id, item: normalizeMessage(m) })),
    ),
  ).items;
}

const graph = summarize(fixtureItems());

describe.each([
  { name: 'the synthetic twin', dir: TWIN_DIR, run: true },
  { name: 'the recorded replay', dir: RECORDED_DIR, run: hasRecording() },
])('Gmail over $name matches the Graph fixture', ({ dir, run }) => {
  it.skipIf(!run)('yields the same candidate clusterKeys', async () => {
    expect(summarize(await gmailItems(dir)).clusterKeys).toEqual(graph.clusterKeys);
    expect(graph.clusterKeys).toEqual(['codename:cobra', 'codename:falcon']);
  });

  it.skipIf(!run)('routes the same internetMessageIds to each candidate', async () => {
    expect(summarize(await gmailItems(dir)).itemsByCandidate).toEqual(graph.itemsByCandidate);
  });

  it.skipIf(!run)('routes every item by the same method', async () => {
    // The corpus exercises all three firm methods, so equality is not vacuous.
    const used = new Set(Object.values(graph.methods).flat().map((m) => m.split(':')[1]));
    expect([...used].sort()).toEqual(['alias', 'codename', 'thread_continuation']);
    expect(summarize(await gmailItems(dir)).methods).toEqual(graph.methods);
  });

  it.skipIf(!run)('finds the same external parties and evidence window', async () => {
    const gmail = summarize(await gmailItems(dir));
    expect(gmail.parties).toEqual(graph.parties);
    expect(gmail.window).toEqual(graph.window);
  });

  it.skipIf(!run)('reads as many distinct messages as the Graph fixture holds', async () => {
    expect((await gmailItems(dir)).length).toBe(fixtureItems().length);
  });
});
