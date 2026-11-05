import type { SupabaseClient } from '@supabase/supabase-js';

import { isProductionAppEnv } from '@/lib/appEnv';
import { READER_MODE, SOURCE_KIND, type ReaderMode, type SourceKind } from '@/lib/constants/discovery';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import type { GraphHttpOptions } from '@/lib/graph/http';
import type { ProviderAllowlistMirror } from '@/lib/mailboxAccess/mirror';
import { certificateSourceFromRef, type CertificateSourceDeps } from './certificateSource';
import { createGraphDriveContentSource, type ExtractFn } from './drive';
import { createFixtureContentSource, fixtureDirFromEnv } from './fixture';
import { createGraphGroupMirror } from './groupMirror';
import { createGraphMailContentSource } from './mail';
import { ReaderTokenCache, type ReaderRegistration } from './token';
import type { ContentSource } from './types';

export type {
  ContentSource,
  GraphDocument,
  GraphMessage,
  GraphRecipient,
  SkippedItem,
  SourceItemPage,
  SourceRow,
} from './types';
export type { ReaderRegistration } from './token';
export { probeGraphScope } from './probe';
// The live mailbox read's binding and checkpoint key checks (#275 design R4), run by the guarded reader (readers.ts).
export { assertCheckpointKey, checkBinding } from './mail';
export type { ScopeProbeResult, ScopeProbeTarget } from './probe';

// The mode lives in constants/discovery.ts so scripts need not import the reader (#262).
export const GRAPH_READER_PROVIDER = READER_MODE;
export type GraphReaderProvider = ReaderMode;

/**
 * Which reader the worker uses, from GRAPH_READER_PROVIDER. There is no
 * default: a worker started without it must not guess, because the fixture
 * would write synthetic mail into a real tenant. The fixture is refused in
 * production outright.
 */
export function readerProviderFromEnv(env: NodeJS.ProcessEnv = process.env): GraphReaderProvider {
  const raw = env.GRAPH_READER_PROVIDER?.trim();
  if (raw === GRAPH_READER_PROVIDER.FIXTURE) {
    if (isProductionAppEnv(env)) {
      throw new Error('GRAPH_READER_PROVIDER=fixture is refused in production');
    }
    return GRAPH_READER_PROVIDER.FIXTURE;
  }
  if (raw === GRAPH_READER_PROVIDER.GRAPH) return GRAPH_READER_PROVIDER.GRAPH;
  throw new Error('GRAPH_READER_PROVIDER must be set to "fixture" or "graph"');
}

/** What the live reader needs for one registration: an authenticated Graph client. */
export type GraphReaderContext = {
  http: GraphHttpOptions;
  extract?: ExtractFn;
  /** A site reader's download cap; the reader's own (EXTRACT_DEFAULTS.maxBytes) when absent. Tests inject a small one. */
  maxBytes?: number;
};

// Built on first use: the cache demands the capability, which a caller passes in.
let defaultTokenCache: ReaderTokenCache | null = null;

/**
 * The Graph client for one bank tenant's registration: its certificate
 * source (Key Vault or env PEM, from cert_secret_ref) and its MSAL token
 * cache. Switching banks is a new registration row, nothing else (ADR-005).
 * Demands the reader capability (#262), so a reader token is only acquired
 * behind the guard.
 */
export function createGraphReaderContext(
  capability: ReaderCapability,
  registration: ReaderRegistration,
  deps: { tokenCache?: ReaderTokenCache; certificate?: CertificateSourceDeps; fetchImpl?: typeof fetch } = {},
): GraphReaderContext {
  requireReaderCapability(capability);
  const cache =
    deps.tokenCache ??
    (deps.certificate
      ? new ReaderTokenCache(capability, (r) => ({
          certificateSource: certificateSourceFromRef(capability, r.certSecretRef, r.certThumbprint, deps.certificate),
        }))
      : (defaultTokenCache ??= new ReaderTokenCache(capability, (r) => ({
          certificateSource: certificateSourceFromRef(capability, r.certSecretRef, r.certThumbprint),
        }))));
  return { http: { getToken: cache.forRegistration(registration), fetchImpl: deps.fetchImpl } };
}

/**
 * The Exchange side of the provider allowlist mirror (#275): the members of the scope group the tenant's
 * registration records, read with that registration's own client (createGraphReaderContext, so the reader's token
 * cache and retries). Demands the reader capability, like the Google mirror (#259). Tests inject the registration
 * lookup, the token cache and the transport.
 */
export function getGraphGroupMirror(
  capability: ReaderCapability,
  deps: { db?: () => SupabaseClient; tokenCache?: ReaderTokenCache; fetchImpl?: typeof fetch } = {},
): ProviderAllowlistMirror {
  requireReaderCapability(capability);
  return createGraphGroupMirror({
    db: deps.db,
    httpFor: (registration) =>
      createGraphReaderContext(capability, registration, { tokenCache: deps.tokenCache, fetchImpl: deps.fetchImpl }).http,
  });
}

/**
 * A reader for one kind of source. Refuses (no_capability) any caller that does
 * not hold the reader capability, which only src/lib/mailboxAccess/readers.ts
 * has, so no reader is ever built outside the guard. The live (`graph`) mode
 * reads with the registration's client from createGraphReaderContext.
 */
export function getContentSource(
  capability: ReaderCapability,
  kind: SourceKind,
  mode?: GraphReaderProvider,
  graph?: GraphReaderContext,
): ContentSource {
  // First, before anything else runs (a default argument would read the environment first).
  requireReaderCapability(capability);
  const provider = mode ?? readerProviderFromEnv();
  if (provider === GRAPH_READER_PROVIDER.GRAPH) {
    if (!graph) throw new Error('The graph reader needs a registration context (createGraphReaderContext)');
    return kind === SOURCE_KIND.MAILBOX
      ? createGraphMailContentSource(capability, { http: graph.http })
      : createGraphDriveContentSource(capability, { http: graph.http, extract: graph.extract, maxBytes: graph.maxBytes });
  }
  if (kind !== SOURCE_KIND.MAILBOX) {
    throw new Error(`The fixture reader serves mailboxes only, not ${kind}`);
  }
  return createFixtureContentSource(capability, { dir: fixtureDirFromEnv() });
}
