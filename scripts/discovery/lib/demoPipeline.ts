// The demo mail through develop's own normalize, route and cluster code, in
// memory. Shared by the owner-run recorder and the extractor tests. Plain fs
// reads: it imports no reader (fence D), so it is identical on develop and on
// #262.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clusterCandidates, type CandidateGroup } from '@/lib/discovery/discover/cluster';
import {
  dedupeObservations,
  normalizeMessage,
  type DedupedItem,
} from '@/lib/discovery/normalize';
import { routeByFirmRules, type RoutedItem } from '@/lib/discovery/route/firmRules';
import type { GraphMessage } from '@/lib/graph/reader';

export const DEMO_INTERNAL_DOMAINS = ['bank.example'];

type Header = { name: string; value: string };
type BoxFile = { mailbox: string; messages: Array<GraphMessage & { internetMessageHeaders?: Header[] }> };

function readBoxes(dir: string): BoxFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as BoxFile);
}

export function demoPipeline(dir: string): {
  items: DedupedItem[];
  routed: RoutedItem[];
  groups: CandidateGroup[];
} {
  const items = dedupeObservations(
    readBoxes(dir).flatMap((box) =>
      box.messages.map((m) => ({ sourceId: box.mailbox, providerItemId: m.id, item: normalizeMessage(m) })),
    ),
  ).items;
  const routed = routeByFirmRules(items, { scope: 'unscoped' });
  const groups = clusterCandidates(
    routed.filter((r) => r.routes.length > 0),
    { internalDomains: DEMO_INTERNAL_DOMAINS },
  );
  return { items, routed, groups };
}

/** The Message-IDs a header value names ("<a@x> <b@y>"). */
function idsIn(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Every message the recorder covers: routed items, plus every message whose
 * In-Reply-To or References names one (the triage reply).
 */
export function recordableItems(dir: string): DedupedItem[] {
  const { items, routed } = demoPipeline(dir);
  const routedIds = new Set(routed.filter((r) => r.routes.length > 0).map((r) => r.item.internetMessageId));
  const replyTargets = new Map<string, string[]>(); // internetMessageId -> ids it replies to
  for (const box of readBoxes(dir)) {
    for (const m of box.messages) {
      const named = (m.internetMessageHeaders ?? [])
        .filter((h) => /^(in-reply-to|references)$/i.test(h.name))
        .flatMap((h) => idsIn(h.value));
      if (named.length) replyTargets.set(m.internetMessageId.trim(), named);
    }
  }
  return items.filter((entry) => {
    const id = entry.item.internetMessageId;
    return routedIds.has(id) || (replyTargets.get(id) ?? []).some((target) => routedIds.has(target));
  });
}
