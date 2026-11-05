// The Gmail reader factory (#259). Like the Graph reader (src/lib/graph/reader),
// only src/lib/mailboxAccess/ imports this module: every read goes through the
// guard, and every factory demands the one reader capability that
// readers.ts claims at load (C2, C3).

import { createHash } from 'node:crypto';

import { isProductionAppEnv } from '@/lib/appEnv';
import { READER_MODE, SOURCE_KIND, TEAM_MAILBOX_CHECK_REASON, type ReaderMode, type SourceKind } from '@/lib/constants/discovery';
import { NoExclusionPolicyError } from '@/lib/discovery/exclusion/errors';
import type { DealContacts } from '@/lib/discovery/sendCensus/types';
import { isUnavailable, type ExclusionContext } from '@/lib/discovery/exclusion/types';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import { withReadProgress } from '@/lib/discovery/source/progress';
import type { ContentSource, SourceItemPage } from '@/lib/discovery/source/types';
import type { ProviderAllowlistMirror } from '@/lib/mailboxAccess/mirror';

import { createCallerTokenSource, createDirectoryTokenSource, type CallerTokenSource } from './credentials';
import { createGoogleTeamMailboxVerifier, type TeamMailboxVerifier } from './directoryUser';
import { createGoogleGroupMirror } from './groupMirror';
import { createGmailMailContentSource } from './mail';
import { googleDelegationRecorder, googleReaderRegistry, type GoogleReaderRegistry } from './registration';
import { DEFAULT_GMAIL_REPLAY_DIR, DEFAULT_GMAIL_REPLAY_PHASE, loadGmailReplays, replayFetch } from './replay';
import { createDelegatedTokenCache } from './token';

// Created on first use, never at import: importing readers.ts must stay free of
// side effects apart from the capability claim, and a Graph-only deployment
// has no Google credential to load.
let callerToken: CallerTokenSource | null = null;
let directoryToken: CallerTokenSource | null = null;
let registry: GoogleReaderRegistry | null = null;

function sharedCallerToken(): CallerTokenSource {
  callerToken ??= createCallerTokenSource();
  return callerToken;
}

/** The directory config's token source (#344, design R5), built on first use like the caller's. */
function sharedDirectoryToken(): CallerTokenSource {
  if (!directoryToken) {
    const source = createDirectoryTokenSource();
    if (!source) throw new Error('GOOGLE_DIRECTORY_CREDENTIALS is no longer set');
    directoryToken = source;
  }
  return directoryToken;
}

function sharedRegistry(): GoogleReaderRegistry {
  registry ??= googleReaderRegistry(
    createDelegatedTokenCache({
      callerToken: () => sharedCallerToken()(),
      // The admin health view's delegation status (plan D11); on change, never per mint.
      onOutcome: googleDelegationRecorder(),
    }),
  );
  return registry;
}

/**
 * DISCOVERY_FIXTURE_PAGE_DELAY_MS, as the Graph fixture reader honours it: each
 * page is served that long after the one before, so a test can kill the worker
 * between two pages and prove the restart resumes from the checkpoint. Replay
 * only: the fixture mode is refused in production.
 */
function pageDelayFromEnv(): number {
  const raw = Number(process.env.DISCOVERY_FIXTURE_PAGE_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function withPageDelay(inner: ContentSource, ms: number): ContentSource {
  if (ms <= 0) return inner;
  const slow = (pages: AsyncIterable<SourceItemPage>): AsyncIterable<SourceItemPage> => ({
    async *[Symbol.asyncIterator]() {
      for await (const page of pages) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        yield page;
      }
    },
  });
  return {
    kind: inner.kind,
    backfill: (source, checkpoint) => slow(inner.backfill(source, checkpoint)),
    delta: (source, token) => slow(inner.delta(source, token)),
    registration: () => inner.registration?.() ?? null,
  };
}

/**
 * The Gmail ContentSource for mailboxes. The one caller is
 * guardedContentSource, which asks the guard before every page. The exclusion
 * policy is required (#263): the reader has no default, and refuses to read
 * without one.
 */
export function getGoogleContentSource(
  capability: ReaderCapability,
  kind: SourceKind,
  mode: ReaderMode,
  /** onProgress: the worker's progress mark (reader liveness), called after each token and successful response. */
  options: { exclusion: ExclusionContext; onProgress?: () => void; dealContacts?: DealContacts },
): ContentSource {
  // First, before anything else runs.
  requireReaderCapability(capability);
  if (kind !== SOURCE_KIND.MAILBOX) throw new Error(`The Gmail reader serves mailboxes only, not ${kind}`);
  if (mode === READER_MODE.FIXTURE) {
    if (isProductionAppEnv()) throw new Error('The Gmail replay is refused in production');
    // The real Gmail source over a replay: no live auth, no caller credential read, no registration lookup.
    const replays = loadGmailReplays(capability, process.env.DISCOVERY_GMAIL_REPLAY_DIR?.trim() || DEFAULT_GMAIL_REPLAY_DIR);
    const fetchImpl = replayFetch(replays, process.env.DISCOVERY_GMAIL_REPLAY_PHASE?.trim() || DEFAULT_GMAIL_REPLAY_PHASE);
    // A replayed 429 has nothing to wait for.
    return withPageDelay(
      createGmailMailContentSource({
        httpFor: async () =>
          withReadProgress({ getToken: async () => 'replay', fetchImpl, sleep: async () => undefined }, options.onProgress),
        exclusion: options.exclusion,
        dealContacts: options.dealContacts,
        // The corpora have fixed dates and the replay keys are exact query strings: a window (#353) would miss every
        // replay or empty the sandbox, so the replay reads whole. Refused in production, so no live read is affected.
        honourWindow: false,
      }),
      pageDelayFromEnv(),
    );
  }
  // Every other mode reads live Gmail. Version 0 is the fixture-only "no stored policy" (load.ts), so it is refused
  // here, before any registry, token or request, whatever mode the caller named (audit C1).
  const policy = options.exclusion.policy;
  if (!isUnavailable(policy) && policy.version === 0) throw new NoExclusionPolicyError();
  const shared = sharedRegistry();
  let clientId: string | null = null;
  const reader = createGmailMailContentSource({
    httpFor: async (source) => {
      const http = await shared.httpFor(source);
      clientId = http.clientId;
      return withReadProgress(http, options.onProgress);
    },
    exclusion: options.exclusion,
    dealContacts: options.dealContacts,
    // A first read takes only the source's window (#353).
    honourWindow: true,
  });
  // The DWD client id the reader minted under, once resolved (#370's pass record); never the service-account
  // email, which is address-shaped. The replay above reports none.
  return Object.assign(reader, { registration: () => (clientId ? { clientId, certThumbprint: null } : null) });
}

/** The Google side of the provider allowlist mirror (C7), built on the directory identity. */
export function getGoogleGroupMirror(capability: ReaderCapability): ProviderAllowlistMirror {
  requireReaderCapability(capability);
  // Only whether the variable is set is read here; the file is read on first use.
  const directoryConfigured = Boolean(process.env.GOOGLE_DIRECTORY_CREDENTIALS?.trim());
  return createGoogleGroupMirror({
    // Lazy: a live pass over a Graph-only tenant never asks the Google mirror, so it needs no Google credential.
    callerToken: () => sharedCallerToken()(),
    directoryToken: directoryConfigured ? () => sharedDirectoryToken()() : undefined,
    registry: sharedRegistry(),
  });
}

/**
 * The Google Directory check of a team inbox address (#581, design R7), built on the directory identity like the
 * group mirror and as lazy as it: nothing is read or minted until the first check. It answers a verdict about one
 * address and reads no mail, so it is a door to the Directory's answer, not to a mailbox.
 */
export function getGoogleTeamMailboxVerifier(capability: ReaderCapability): TeamMailboxVerifier {
  requireReaderCapability(capability);
  const directoryConfigured = Boolean(process.env.GOOGLE_DIRECTORY_CREDENTIALS?.trim());
  return createGoogleTeamMailboxVerifier({
    callerToken: () => sharedCallerToken()(),
    directoryToken: directoryConfigured ? () => sharedDirectoryToken()() : undefined,
    registry: sharedRegistry(),
  });
}

/**
 * The fixture Directory check (#581), the Directory's answer in replay mode: an address the replay holds a mailbox for
 * is a real user mailbox (verified); any other is not found (refused). It reads the same replay folder the fixture
 * reader serves (`DISCOVERY_GMAIL_REPLAY_DIR`), so a team inbox is Ready exactly when the fixture reader can read it,
 * and the demo needs no Workspace. No credential, no registration and no network; refused in production.
 *
 * The manifest is read on every check, not at construction: a check runs about every 15 minutes per team inbox, the
 * replays are small, and the folder is the one place the answer lives (nothing to go stale, no module state).
 */
export function getFixtureTeamMailboxVerifier(capability: ReaderCapability): TeamMailboxVerifier {
  requireReaderCapability(capability);
  if (isProductionAppEnv()) throw new Error('The fixture team inbox check is refused in production');
  return {
    async verify(_tenantId, address) {
      const replays = loadGmailReplays(capability, process.env.DISCOVERY_GMAIL_REPLAY_DIR?.trim() || DEFAULT_GMAIL_REPLAY_DIR);
      const wanted = address.trim().toLowerCase();
      if (!replays.some((replay) => replay.mailbox.trim().toLowerCase() === wanted)) {
        return { status: 'refused', reason: TEAM_MAILBOX_CHECK_REASON.NOT_FOUND };
      }
      // Stable per address and not the address: the pin a later check compares against.
      return { status: 'verified', directoryUserId: `fixture-${createHash('sha256').update(wanted).digest('hex').slice(0, 16)}` };
    },
  };
}
