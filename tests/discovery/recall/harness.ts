// The recall harness (#173 G-09). It runs a parsed corpus through the firm router in several shapes and reports,
// per corpus id, the routes the final re-route gave and the sources whose observation the run kept.
//
//   whole       one routeByFirmRules call over the whole corpus, the demoPipeline shape. A single-batch comparison,
//               not a bound: the worker never routes with the whole tenant in view, and a rule that needs every
//               observing source can admit less in one batch than page by page.
//   paged       the worker's shape: per source, pages routed with the worker's own RoutingContext; only routed items are kept,
//               as persistItems keeps them (an unrouted item keeps no text); the context learns from what was kept;
//               then discoverTenant's step (routeStored), a re-route of everything kept with all its kept observations. Sources
//               are read in the order the world lists them. The page is the reader's:
//     graph50     the Graph reader's page, MAIL_PAGE_SIZE (50) messages in corpus order. The headline shape for an
//                 M365 inbox. Folders are not modelled: a corpus is one stream per mailbox.
//     gmail10t    the Gmail reader's page, THREADS_PER_CHUNK (10) threads, each read whole and oldest message first,
//                 threads in Gmail's listing order (most recent activity first). The 25-request budget is not
//                 modelled: it only splits a page further.
//     page10      10 messages in corpus order: a stress case, smaller than any reader's page.
//     page10_rev  page10 with the sources and the pages in the opposite order, so a message is read before the one
//                 that makes it routable (the known limit in worker/sync.ts, "Routing across pages").
//
// The router is called with the real source scope (#173 G-09): `shared` is every team or ownerless source, the
// worker's rule for a shared inbox (worker/sync.ts firmRouting). Page mode runs the worker's own RoutingContext (built
// by contextFromStored, as loadRoutingContext builds it) and routeStored (discoverTenant's route), so the measurement
// is the production shape (3/6). Only the keep step is an inline imitation of persistItems, which needs a database.

import {
  dedupeObservations,
  documentKey,
  isDocumentKey,
  normalizeDocument,
  normalizeMessage,
  type DedupedItem,
  type NormalizedItem,
  type Observation,
} from '@/lib/discovery/normalize';
import { codenamesIn, routeByFirmRules, type FirmRoute, type RoutingScope } from '@/lib/discovery/route/firmRules';
import { contextFromStored, routeStored } from '../../../worker/sync';
import { MAIL_PAGE_SIZE } from '@/lib/graph/reader/mail';
import { THREADS_PER_CHUNK } from '@/lib/google/reader/mail';
import { isRecallDocument, RECALL_PAGE_SIZE, type RecallCorpus, type RecallMessage } from './format';

export const RECALL_MODES = ['whole', 'graph50', 'gmail10t', 'page10', 'page10_rev'] as const;
export type RecallMode = (typeof RECALL_MODES)[number];
/** The mode the headline (the team inbox's row set) is read in: an M365 team inbox, read by the Graph reader. */
export const HEADLINE_MODE: RecallMode = 'graph50';

export type RunResult = {
  /** Corpus id -> the routes of the final route. */
  routes: Map<string, FirmRoute[]>;
  /** Corpus id -> the sources whose observation of it the run kept. */
  kept: Map<string, ReadonlySet<string>>;
};

const DOCUMENT_PREFIX_LENGTH = documentKey('').length;

/** The corpus id of a normalized item: its Internet message id, or a document's id. */
export function corpusIdOfItem(item: NormalizedItem): string {
  return isDocumentKey(item.internetMessageId) ? item.internetMessageId.slice(DOCUMENT_PREFIX_LENGTH) : item.internetMessageId;
}

function normalize(message: RecallMessage): { item: NormalizedItem; providerItemId: string } {
  if (isRecallDocument(message)) {
    return {
      providerItemId: message.id,
      item: normalizeDocument({
        driveItemKey: message.id,
        providerItemId: message.id,
        name: message.name,
        drivePath: `/${message.name}`,
        lastModifiedDateTime: null,
        authors: [{ address: message.author, name: null }],
        text: message.text,
        cTag: null,
      }),
    };
  }
  return { providerItemId: message.id, item: normalizeMessage(message) };
}

/** One observation per (message, source), in corpus order: a source's own order is the order of its messages. */
export function observationsOf(corpus: RecallCorpus): Observation[] {
  return corpus.messages.flatMap((message) => {
    const { item, providerItemId } = normalize(message);
    return message.sources.map((sourceId) => ({ sourceId, providerItemId, item }));
  });
}

function ownersOf(corpus: RecallCorpus): Map<string, string> {
  return new Map(corpus.world.sources.map((s) => [s.id, s.address.toLowerCase()]));
}

/** The worker's rule for a shared inbox: a team mailbox, or a source with no owner. Every other source is personal. */
function scopeOf(corpus: RecallCorpus): RoutingScope {
  return { shared: new Set(corpus.world.sources.filter((s) => s.kind === 'team' || !s.ownerPersonId).map((s) => s.id)) };
}

function resultOf(routed: Array<DedupedItem & { routes: FirmRoute[] }>): RunResult {
  const routes = new Map<string, FirmRoute[]>();
  const kept = new Map<string, ReadonlySet<string>>();
  for (const entry of routed) {
    const id = corpusIdOfItem(entry.item);
    routes.set(id, entry.routes);
    kept.set(id, new Set(entry.observations.map((o) => o.sourceId)));
  }
  return { routes, kept };
}

export function runWhole(corpus: RecallCorpus): RunResult {
  const { items } = dedupeObservations(observationsOf(corpus));
  return resultOf(
    routeByFirmRules(items, { internalDomains: [corpus.world.firm.domain], sourceOwners: ownersOf(corpus), scope: scopeOf(corpus) }),
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** A Gmail page: whole threads, most recently active thread first, each thread's messages in corpus order. */
function gmailPages(observations: Observation[]): Observation[][] {
  const threads = new Map<string, Observation[]>();
  observations.forEach((o, i) => {
    const key = o.item.conversationId ?? `solo\u0000${i}`;
    threads.set(key, [...(threads.get(key) ?? []), o]);
  });
  const lastAt = (thread: Observation[]) => observations.lastIndexOf(thread[thread.length - 1]);
  const listed = [...threads.values()].sort((a, b) => lastAt(b) - lastAt(a));
  return chunk(listed, THREADS_PER_CHUNK).map((page) => page.flat());
}

type Shape = { pages: (observations: Observation[]) => Observation[][]; reversed: boolean };
const SHAPES: Record<Exclude<RecallMode, 'whole'>, Shape> = {
  graph50: { pages: (o) => chunk(o, MAIL_PAGE_SIZE), reversed: false },
  gmail10t: { pages: gmailPages, reversed: false },
  page10: { pages: (o) => chunk(o, RECALL_PAGE_SIZE), reversed: false },
  page10_rev: { pages: (o) => chunk(o, RECALL_PAGE_SIZE), reversed: true },
};

export function runPage(corpus: RecallCorpus, mode: Exclude<RecallMode, 'whole'>): RunResult {
  const { domain } = corpus.world.firm;
  const all = observationsOf(corpus);
  const shape = SHAPES[mode];
  const sources = shape.reversed ? [...corpus.world.sources].reverse() : [...corpus.world.sources];
  const scope = scopeOf(corpus);
  // A fresh tenant has stored nothing yet: the bootstrap's empty case, which also fixes the scope on the context.
  const context = contextFromStored([], [], scope);
  context.internalDomains = [domain];
  const stored = new Map<string, DedupedItem>();

  for (const source of sources) {
    const pages = shape.pages(all.filter((o) => o.sourceId === source.id));
    if (shape.reversed) pages.reverse();
    for (const page of pages) {
      const { items } = dedupeObservations(page);
      // A page is one mailbox, so its owner is this source's address (syncSource, #653).
      const owner = new Map([[source.id, source.address]]);
      const routed = routeByFirmRules(items, { ...context.options(), sourceOwners: owner });
      // As syncSource: every item the router saw adds its prefix evidence for the pages after it.
      context.notePrefixes(items, owner);
      // persistItems keeps what a rule routed, with this source's observation; unrouted items keep nothing.
      const keptNow = routed.filter((entry) => entry.routes.length > 0);
      for (const entry of keptNow) {
        const id = entry.item.internetMessageId;
        const existing = stored.get(id);
        if (!existing) {
          stored.set(id, { item: entry.item, observations: [...entry.observations] });
          continue;
        }
        for (const observation of entry.observations) {
          if (!existing.observations.some((o) => o.sourceId === observation.sourceId)) existing.observations.push(observation);
        }
      }
      context.learn(keptNow);
    }
  }

  // discoverTenant: everything kept is re-routed together, with the candidates' codenames read back from text. A
  // candidate carries no provenance, so only the stored items' own literals teach the keys.
  const knownCodenames = [...context.codenames.values()].flatMap(({ codename }) => codenamesIn(codename));
  const { routed } = routeStored([...stored.values()], {
    knownCodenames,
    internalDomains: [domain],
    sourceOwners: ownersOf(corpus),
    scope,
  });
  return resultOf(routed);
}

export function runAll(corpus: RecallCorpus): Record<RecallMode, RunResult> {
  return {
    whole: runWhole(corpus),
    graph50: runPage(corpus, 'graph50'),
    gmail10t: runPage(corpus, 'gmail10t'),
    page10: runPage(corpus, 'page10'),
    page10_rev: runPage(corpus, 'page10_rev'),
  };
}
