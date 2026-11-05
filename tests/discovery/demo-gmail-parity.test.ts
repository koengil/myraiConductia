// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { clusterCandidates } from '@/lib/discovery/discover/cluster';
import { dedupeObservations, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';

import { DEMO_TEAM_MAILBOX } from '../../scripts/google/build-gmail-twin';
import { DEMO_TWIN_DIR, readReplay } from '../google/replayHarness';
import { DEMO_GRAPH_DIR, DEMO_LATE_DIR } from './demoCorpus';
import { fixtureCapability } from './fixtureCapability';
import { INTERNAL_DOMAINS } from './fixtureCorpus';

// The demo Gmail twin, read through the real Gmail reader, gives the pipeline the same input as the Graph demo
// fixtures: the same copies, the same content hashes (the key worker/extract --strict replays on), and the same
// clusters. Without this, a body-encoding change would surface only as a recording_miss mid-journey.

type Copy = { key: string; hash: string; item: DedupedItem['item'] };

function graphCopies(dir: string): Copy[] {
  return loadFixtureMailboxes(fixtureCapability, dir).flatMap((box) =>
    box.messages.map((m) => {
      const item = normalizeMessage(m);
      return { key: `${box.mailbox.toLowerCase()}|${item.internetMessageId}`, hash: item.contentHash, item };
    }),
  );
}

// The demo team inbox (#581 phase 12) is a Gmail-only mailbox: its messages are copies of the personas' own mail, and the
// Graph demo has no team inbox. Its items are compared by the team journey's own checks (tests/google/demo-twin.test.ts).
async function gmailCopies(phase: string): Promise<Copy[]> {
  return (await readReplay(DEMO_TWIN_DIR, phase)).filter((box) => box.mailbox !== DEMO_TEAM_MAILBOX).flatMap((box) =>
    box.items.map((m) => {
      const item = normalizeMessage(m);
      return { key: `${box.mailbox}|${item.internetMessageId}`, hash: item.contentHash, item };
    }),
  );
}

function clusters(copies: Copy[]) {
  const items = dedupeObservations(copies.map((c) => ({ sourceId: c.key.split('|')[0], providerItemId: c.key, item: c.item }))).items;
  const groups = clusterCandidates(routeByFirmRules(items, { scope: 'unscoped' }).filter((e) => e.routes.length > 0), { internalDomains: INTERNAL_DOMAINS });
  return Object.fromEntries(groups.map((g) => [g.clusterKey, g.links.map((l) => l.internetMessageId).sort()]));
}

describe.each([
  { phase: 'seeded', graphDir: DEMO_GRAPH_DIR },
  { phase: 'after-imports', graphDir: DEMO_LATE_DIR },
])('the demo twin at $phase matches the Graph demo fixtures', ({ phase, graphDir }) => {
  it('holds the same mailbox copies', async () => {
    const gmail = await gmailCopies(phase);
    const graph = graphCopies(graphDir);
    expect(gmail.map((c) => c.key).sort()).toEqual(graph.map((c) => c.key).sort());
  });

  it('gives every copy the same content hash', async () => {
    const graph = new Map(graphCopies(graphDir).map((c) => [c.key, c.hash]));
    for (const copy of await gmailCopies(phase)) expect(copy.hash, copy.key).toBe(graph.get(copy.key));
  });

  it('clusters into the same candidates with the same messages', async () => {
    expect(clusters(await gmailCopies(phase))).toEqual(clusters(graphCopies(graphDir)));
  });
});
