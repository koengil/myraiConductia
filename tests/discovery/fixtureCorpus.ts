import { dedupeObservations, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';

import { fixtureCapability } from './fixtureCapability';

/** The fixture corpus as the worker sees it: every mailbox read, then deduplicated. */
export function fixtureItems(): DedupedItem[] {
  const observations = loadFixtureMailboxes(fixtureCapability).flatMap((box) =>
    box.messages.map((m) => ({ sourceId: box.mailbox, providerItemId: m.id, item: normalizeMessage(m) })),
  );
  return dedupeObservations(observations).items;
}

export const INTERNAL_DOMAINS = ['bank.example'];
