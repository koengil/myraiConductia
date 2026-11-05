import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { isProductionAppEnv } from '@/lib/appEnv';
import { FIXTURE_PAGE_SIZE, SOURCE_KIND } from '@/lib/constants/discovery';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import type { ContentSource, GraphMessage, SourceItemPage, SourceRow } from './types';

/**
 * The fixture ContentSource: serves tests/fixtures/discovery/*.json in Graph's
 * message shape, standing in for a Graph mailbox in CI, E2E and local runs.
 *
 * Each fixture file is one mailbox of the synthetic test tenant:
 *   { "mailbox": "<address>", "messages": [GraphMessage, ...] }
 * A content source reads the file whose `mailbox` equals its address, so the
 * same corpus serves any Conductia tenant: content_sources.owner_user_id, not
 * the address, decides whose items they are (Q6).
 *
 * Checkpoints are `fixture:<offset>` into the mailbox's message list. A delta
 * read serves whatever follows the token's offset, which for a fixed corpus
 * is nothing.
 */

export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery');
// The page size lives in constants/discovery.ts (the fake Graph tenant pages the same way); re-exported for the tests.
export { FIXTURE_PAGE_SIZE };

/**
 * The fixture corpus directory: the base corpus unless DISCOVERY_FIXTURE_DIR
 * names one under it (the demo corpus and its late-mail superset). Refused in
 * production, and never outside tests/fixtures/discovery.
 */
export function fixtureDirFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env.DISCOVERY_FIXTURE_DIR?.trim();
  if (!raw) return FIXTURE_DIR;
  if (isProductionAppEnv(env)) throw new Error('DISCOVERY_FIXTURE_DIR is refused in production');
  const dir = resolve(process.cwd(), raw);
  if (!dir.startsWith(FIXTURE_DIR + sep)) throw new Error('DISCOVERY_FIXTURE_DIR must be under tests/fixtures/discovery');
  return dir;
}

type FixtureMailbox = { mailbox: string; messages: GraphMessage[] };

/**
 * The fixture corpus, one entry per mailbox file. It demands the reader
 * capability like the reader factories do (audit round 2, item 9): the corpus
 * is what a fixture reader serves, so it is reached only where a reader may be.
 * Production callers reach it through the reader; tests claim the capability
 * in their own module registry (tests/discovery/fixtureCapability.ts).
 */
export function loadFixtureMailboxes(capability: ReaderCapability, dir: string = FIXTURE_DIR): FixtureMailbox[] {
  // First, before the directory is read.
  requireReaderCapability(capability);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as FixtureMailbox)
    .filter((file) => typeof file.mailbox === 'string' && Array.isArray(file.messages));
}

function offsetOf(checkpoint: string | null): number {
  if (!checkpoint) return 0;
  const match = /^fixture:(\d+)$/.exec(checkpoint);
  if (!match) throw new Error('fixture reader: unreadable checkpoint');
  return Number(match[1]);
}

/**
 * DISCOVERY_FIXTURE_PAGE_DELAY_MS slows each page down, so a test can kill the
 * worker between two pages and prove the restart resumes from the checkpoint.
 * Fixture only; the fixture is refused in production.
 */
function pageDelayFromEnv(): number {
  const raw = Number(process.env.DISCOVERY_FIXTURE_PAGE_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function createFixtureContentSource(
  capability: ReaderCapability,
  options: { dir?: string; pageSize?: number; pageDelayMs?: number } = {},
): ContentSource {
  requireReaderCapability(capability);
  const pageSize = options.pageSize ?? FIXTURE_PAGE_SIZE;
  const pageDelayMs = options.pageDelayMs ?? pageDelayFromEnv();
  let cache: FixtureMailbox[] | null = null;
  const messagesFor = (source: SourceRow): GraphMessage[] => {
    cache ??= loadFixtureMailboxes(capability, options.dir);
    const address = source.address.toLowerCase();
    return cache.find((file) => file.mailbox.toLowerCase() === address)?.messages ?? [];
  };

  async function* pagesFrom(source: SourceRow, start: number): AsyncIterable<SourceItemPage> {
    const messages = messagesFor(source);
    for (let offset = start; offset < messages.length; offset += pageSize) {
      const end = Math.min(offset + pageSize, messages.length);
      if (pageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
      const items = messages.slice(offset, end);
      // A fixture message is whole when served: each one counts as fetched (#370).
      yield { items, fetched: items.length, nextCheckpoint: `fixture:${end}` };
    }
  }

  return {
    kind: SOURCE_KIND.MAILBOX,
    backfill: (source, checkpoint) => pagesFrom(source, offsetOf(checkpoint)),
    delta: (source, token) => pagesFrom(source, offsetOf(token)),
  };
}
