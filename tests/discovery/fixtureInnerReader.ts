import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, GraphMessage, SourceItemPage, SourceRow } from '@/lib/graph/reader';
import { FIXTURE_DIR, FIXTURE_PAGE_SIZE } from '@/lib/graph/reader/fixture';

/*
 * The fixture corpus and a reader that serves it the way the fixture reader
 * does (pages of FIXTURE_PAGE_SIZE, `fixture:<offset>` checkpoints), for a test
 * that also loads worker/classify.ts. That module claims the reader capability
 * at load (#262), so such a test cannot build the real fixture reader, and it
 * does not need to: what it builds here is only the inner reader of a
 * `readerFor` override, which the worker wraps in the guard like any reader.
 */

export type FixtureMailbox = { mailbox: string; messages: GraphMessage[] };

export function fixtureMailboxes(dir: string = FIXTURE_DIR): FixtureMailbox[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as FixtureMailbox)
    .filter((file) => typeof file.mailbox === 'string' && Array.isArray(file.messages));
}

function offsetOf(checkpoint: string | null): number {
  if (!checkpoint) return 0;
  const match = /^fixture:(\d+)$/.exec(checkpoint);
  if (!match) throw new Error(`fixture reader: unreadable checkpoint "${checkpoint}"`);
  return Number(match[1]);
}

export function innerFixtureReader(options: { dir?: string; pageSize?: number } = {}): ContentSource {
  const pageSize = options.pageSize ?? FIXTURE_PAGE_SIZE;
  const corpus = fixtureMailboxes(options.dir);
  const messagesFor = (source: SourceRow) =>
    corpus.find((file) => file.mailbox.toLowerCase() === source.address.toLowerCase())?.messages ?? [];

  async function* pagesFrom(source: SourceRow, start: number): AsyncIterable<SourceItemPage> {
    const messages = messagesFor(source);
    for (let offset = start; offset < messages.length; offset += pageSize) {
      const end = Math.min(offset + pageSize, messages.length);
      const items = messages.slice(offset, end);
      // Counted as the real fixture reader counts (src/lib/graph/reader/fixture.ts): every message served is whole,
      // so each one is fetched (#370, #344 G2).
      yield { items, fetched: items.length, nextCheckpoint: `fixture:${end}` };
    }
  }

  return {
    kind: SOURCE_KIND.MAILBOX,
    backfill: (source, checkpoint) => pagesFrom(source, offsetOf(checkpoint)),
    delta: (source, token) => pagesFrom(source, offsetOf(token)),
  };
}
