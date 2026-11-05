import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dedupeObservations, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import type { GraphMessage } from '@/lib/graph/reader';

export const DEMO_GRAPH_DIR = join(process.cwd(), 'tests/fixtures/discovery/demo/graph');
export const DEMO_LATE_DIR = join(process.cwd(), 'tests/fixtures/discovery/demo/graph-after-imports');

/** The demo superset as the worker sees it: every mailbox read, then deduplicated. */
export function demoItems(dir = DEMO_GRAPH_DIR): DedupedItem[] {
  const boxes = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as { mailbox: string; messages: GraphMessage[] });
  return dedupeObservations(
    boxes.flatMap((box) =>
      box.messages.map((m) => ({ sourceId: box.mailbox, providerItemId: m.id, item: normalizeMessage(m) })),
    ),
  ).items;
}
