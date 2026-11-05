// The only way to obtain a ContentSource outside the reader directories
// (#262, R9). The wrapper asserts the guard before every page request, so a
// withdrawal or removal mid-backfill stops the read at the next page.
//
// It also holds the reader capability (src/lib/discovery/source/capability.ts),
// claimed once when this module loads. The reader factories refuse any caller
// without it, so a reader reached around this module (a computed import, a
// re-export) refuses at run time instead of reading unguarded.
//
// Four doors are not guarded reads, each for an operator script. The first three
// carry no registration credential and no mailbox of a real tenant; the fourth
// is the Gmail trial's tooling, which is the exception and says why below:
// - probeReaderScope, the scope probe (scripts/m365/probe-out-of-scope.ts). It
//   returns HTTP statuses only.
// - graphContentSourceOver, the Graph reader over a transport the caller holds:
//   the cassette replay and the recorder's test double (scripts/m365/cassette/).
//   Replay hands it to runOnce as `readerFor`, which wraps it in the guard.
// - loadFixtureCorpus, the synthetic bank.example corpus the fake Graph tenant serves.
// - googleOperatorKit, the Google HTTP and token primitives the Gmail trial
//   scripts use (scripts/google/). Unguarded on purpose and operator-only.
//
// One more door IS a guarded read: createGuardedRecording, the owner's live Microsoft capture (#318). Its
// sources are the worker's own guarded live read (guardedMicrosoftLive), with the responses shown to an
// observer that never sees a token, a download URL or the binding check.

import {
  DISCOVERY_WORKER_SERVICE_IDENTITY,
  M365_RECORDER_SERVICE_IDENTITY,
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  MAILBOX_REFUSAL_REASON,
  READER_MODE,
  SOURCE_KIND,
  type MailboxProvider,
  type ReaderMode,
  type SourceKind,
} from '@/lib/constants/discovery';
import {
  ExclusionNotEnforcedError,
  InvalidExclusionPolicyError,
  NoExclusionPolicyError,
} from '@/lib/discovery/exclusion/errors';
import { isUnavailable, type ExclusionContext } from '@/lib/discovery/exclusion/types';
import type { DealContacts } from '@/lib/discovery/sendCensus/types';
import { claimReaderCapability } from '@/lib/discovery/source/capability';
import { withReadProgress } from '@/lib/discovery/source/progress';
import {
  getFixtureTeamMailboxVerifier,
  getGoogleContentSource,
  getGoogleGroupMirror,
  getGoogleTeamMailboxVerifier,
} from '@/lib/google/reader';
import { assertKeylessCredentialFile, createCallerTokenSource, createDirectoryTokenSource } from '@/lib/google/reader/credentials';
import type { TeamMailboxVerifier } from '@/lib/google/reader/directoryUser';
import { GoogleHttpError, googleFetch, googleJson, googleUrl } from '@/lib/google/reader/http';
import { GOOGLE_REGISTRATION_COLUMNS, googleRegistrationFromRow } from '@/lib/google/reader/registration';
import { GoogleTokenError, createDelegatedTokenCache, serviceAccountAccessToken } from '@/lib/google/reader/token';
import {
  assertCheckpointKey,
  checkBinding,
  createGraphReaderContext,
  getContentSource,
  getGraphGroupMirror,
  probeGraphScope,
  readerProviderFromEnv,
} from '@/lib/graph/reader';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';
import type {
  ContentSource,
  GraphMessage,
  GraphReaderContext,
  ReaderRegistration,
  ScopeProbeResult,
  ScopeProbeTarget,
  SourceItemPage,
  SourceRow,
} from '@/lib/graph/reader';

import {
  assertSourceAllowed,
  MailboxAccessRefusedError,
  mailboxGuardVerdict,
  PROVIDER_REFUSAL_REASONS,
  type ProviderRefusalReason,
} from './guard';
import type { ProviderAllowlistMirror, ReadKey } from './mirror';

export { readerProviderFromEnv };

/**
 * No reader serves this source's kind or provider in this mode: a SharePoint site in fixture mode (the fixture
 * serves mailboxes only), or a provider whose reader has not landed. It is not a guard refusal and not a wiring
 * fault: it names one source the worker cannot read, so the worker skips that source and reads the others
 * (C8, C28), where any other error building a reader still fails the pass. The message is the reader's own.
 */
export class UnsupportedSourceError extends Error {
  constructor(
    readonly kind: string,
    readonly provider: string,
    readonly mode: ReaderMode,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}
export type { ContentSource, GraphMessage, GraphReaderContext, ReaderRegistration, ScopeProbeResult, ScopeProbeTarget, SourceItemPage, SourceRow };

// Claimed at load. The guard is asked through its own service client (guard.ts),
// so a reader context carries no database handle a caller could stub.
const readerCapability = claimReaderCapability();

/**
 * The provider check's answer for one mailbox, failing closed. A missing or
 * non-function check, a throw, and any return other than null or a known
 * provider reason (undefined, a boolean, an empty or unknown string, an object, a
 * promise) is `mirror_unavailable`.
 */
function providerReasonFor(check: unknown, address: string): ProviderRefusalReason | null {
  if (typeof check !== 'function') return MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
  let answer: unknown;
  try {
    answer = (check as (address: string) => unknown)(address.toLowerCase());
  } catch {
    return MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
  }
  if (answer === null) return null;
  const known = PROVIDER_REFUSAL_REASONS.find((reason) => reason === answer);
  if (known) return known;
  // A promise from a mis-typed async check is a refusal, and a rejection of it
  // must not surface as an unhandled one.
  if (typeof (answer as { then?: unknown } | undefined)?.then === 'function') {
    Promise.resolve(answer).catch(() => undefined);
  }
  return MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
}

// An Entra object id: a read key's id is a path key too, so nothing else is accepted in it.
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The read key for one mailbox, or null, failing closed like providerReasonFor: a missing or non-function lookup, a
 * throw, and any answer that is not a UPN and an object id (null, a promise, a blank or malformed field) is null.
 */
function readKeyFor(lookup: unknown, address: string): ReadKey | null {
  if (typeof lookup !== 'function') return null;
  let answer: unknown;
  try {
    answer = (lookup as (address: string) => unknown)(address.toLowerCase());
  } catch {
    return null;
  }
  if (typeof (answer as { then?: unknown } | null | undefined)?.then === 'function') {
    Promise.resolve(answer).catch(() => undefined);
    return null;
  }
  if (answer === null || typeof answer !== 'object') return null;
  const { upn, id } = answer as { upn?: unknown; id?: unknown };
  if (typeof upn !== 'string' || upn.trim() === '' || typeof id !== 'string' || !OBJECT_ID.test(id.trim())) return null;
  return { upn: upn.trim().toLowerCase(), id: id.trim() };
}

/**
 * A live Graph mailbox read reaches the one directory object its allowlisted address is bound to (#275 design R4).
 * In two steps, so the guard records exactly one decision before the first page, with the binding's answer in it:
 *
 *   bind  runs in createGuardedContentSource (BindMailbox) once the exclusion policy, the source's tenant, kind and
 *         provider, the pass's provider check and the guard's own read-only verdict (mailbox_guard_verdict) have all
 *         allowed the read, so no provider request is made before a guard verdict (#262). It takes the address's
 *         read key and runs the binding check (the inbox by object id and by UPN must be the same folder). A missing
 *         key or a failed check is `mirror_unavailable`, which the one state-writing guard call that follows records
 *         and audits once. Asking that guard first and again on refusal reset and re-audited the refusal on every
 *         attempt (#275 audit, item 1), for the whole Exchange RBAC lag or a misconfiguration. Throttling and other
 *         Graph failures are thrown, with no state-writing guard call.
 *   open  runs after mailbox_guard_check allowed the read: it checks that a checkpoint's stored links address the
 *         bound directory object, then reads by the bound UPN, so the stored address never reaches Graph as the path key.
 *
 * The key is held for one read: by that read's token (READ), which the guarded wrapper puts on every copy of the
 * source it hands on, the first read's claim copy (#353) included. Not by the source object, which the claim copies
 * (#643), and not by the source id, which two reads of one mailbox share: a read whose bind step did not run never
 * finds another read's key, whether that read came before it or runs beside it.
 */
function boundMailboxRead(ctx: GuardedReaderContext, http: GraphReaderContext['http']) {
  const keys = new WeakMap<object, ReadKey>();
  const bind: BindMailbox = async (source) => {
    const read = readOf(source);
    // An untagged source never came through the guarded wrapper: a wiring fault, refused like a failed binding.
    if (!read) return MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
    const key = readKeyFor(ctx.readKey, source.address);
    if (key === null || !(await checkBinding(readerCapability, http, key))) return MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
    keys.set(read, key);
    return null;
  };
  async function* open<C extends string | null>(
    source: SourceRow,
    checkpoint: C,
    read: (source: SourceRow, checkpoint: C) => AsyncIterable<SourceItemPage>,
  ): AsyncIterable<SourceItemPage> {
    const token = readOf(source);
    const key = token ? keys.get(token) : undefined;
    // Taken once: the read's key opens one listing.
    if (token) keys.delete(token);
    // Bound in this read's bind step, or the read never got here. No key means a wiring fault, or a verdict that
    // denied and a check that then allowed (the database changed between the two): either way it fails closed.
    if (!key) {
      throw new MailboxAccessRefusedError(ctx.tenantId, source.address, MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE, MAILBOX_GUARD_PURPOSE.PROVIDER_READ);
    }
    assertCheckpointKey(checkpoint, key);
    yield* read({ ...source, address: key.upn }, checkpoint);
  }
  return { bind, open };
}

/**
 * A step a guarded mailbox read takes before its first state-writing guard call (#275 audit, item 1): null to go on,
 * or the provider reason the guard is to record and refuse with. Runs only for a source the provider check and the
 * guard's read-only verdict both admit.
 */
type BindMailbox = (source: SourceRow) => Promise<ProviderRefusalReason | null>;

/** One guarded read's token, carried on the copies of the source it hands its bind and open steps (#643). */
const READ = Symbol('guarded read');
type ReadSource = SourceRow & { [READ]?: object };
const readOf = (source: SourceRow): object | undefined => (source as ReadSource)[READ];

export type GuardedReaderContext = {
  tenantId: string;
  caller?: string;
  /**
   * The addresses the provider group also holds, computed once per pass. Required
   * for a mailbox read (round 2 item 4, round 3 item 5): a mailbox source whose
   * check is not a function, throws, or answers anything but null or a provider
   * reason is refused as `mirror_unavailable` before any page is read. Only a
   * sharepoint_site source, which has no provider group, may omit it.
   */
  providerCheck?: (address: string) => ProviderRefusalReason | null;
  /**
   * The directory object each bound mailbox resolves to (ReadableMailboxes.readKey, #275 design R4), from the same
   * pass as providerCheck. Required for a live Microsoft mailbox read, which is checked against it before its first
   * guard call and addressed by its UPN: a missing, throwing or malformed one, or no key for the address, refuses the
   * source as `mirror_unavailable` in that one guard call, audited once. Fixture, replay and site reads never ask it.
   */
  readKey?: (address: string) => ReadKey | null;
  /**
   * The tenant's Microsoft reader registration. Required for a live (`graph`)
   * Microsoft read: its certificate credential and token are built here, with
   * the reader capability, so no caller ever holds a reader token.
   */
  graphRegistration?: ReaderRegistration;
  /**
   * The tenant's exclusion policy for this pass (#263), loaded once by the worker.
   * Required for a Gmail mailbox read: the wrapper refuses a Google mailbox source
   * without it before any request. An unavailable one (no policy version in a live
   * pass, or a current version that fails validation) is refused on the first read,
   * for either provider, with an error that carries no rule content. A Microsoft
   * source under a non-empty policy is refused too: the Graph two-step read is
   * #272, and until then a policy is never silently ignored.
   */
  exclusion?: ExclusionContext;
  /** Absent contacts leave Gmail sent facts unclassified. */
  dealContacts?: DealContacts;
  /**
   * Called as the read makes progress (reader liveness, #409): after every page, and after every token and
   * successful provider response of a live or replayed read (src/lib/discovery/source/progress.ts). The worker
   * records it as the source's progress mark. Takes nothing and passes nothing on.
   */
  onProgress?: () => void;
  /**
   * A team inbox's way to renew its Directory check mid-pass (#581, design R7). Set by the worker for a team source
   * only. The guard refuses a team source whose last successful check is 65 minutes old, which a long backfill or a
   * --recount re-read can outlive. When that refusal comes BETWEEN pages, the wrapper calls this once per reader,
   * asks the guard again, and continues only if the guard now allows it. The renewal decides nothing: it writes the
   * registry, and the guard (which reads the registry) is still the only thing that lets a page be requested. A
   * second refusal, a throw from this, or a stale check before the first page stops the read.
   */
  recheckTeam?: () => Promise<void>;
  /**
   * The first read's claim (#353): called once on a backfill from nothing, after the guard admits the source and
   * before the inner reader starts, so before its first provider request. The worker marks the read started and reads
   * the window back in one statement; the reader then reads that window, not the one the job loaded. Absent: the
   * reader reads the source as given.
   */
  claimFirstRead?: (source: SourceRow) => Promise<string | null>;
};

/**
 * Wrap a ContentSource. Used by guardedContentSource, and by tests for the
 * Google stub (R18). A mailbox source goes through the mailbox guard with its
 * owner bound; a sharepoint_site source goes through the site guard (R23).
 * Any other kind is refused before any read. A mailbox reader names its
 * provider (round 2, item 6): a source of another provider is refused (C2), and
 * the provider goes to the guard, which refuses `provider_mismatch` when it is
 * not the source's. A site reader needs none.
 */
export function createGuardedContentSource(
  inner: ContentSource,
  ctx: GuardedReaderContext,
  provider?: MailboxProvider,
  hooks: { bind?: BindMailbox } = {},
): ContentSource {
  if (inner.kind !== SOURCE_KIND.MAILBOX && inner.kind !== SOURCE_KIND.SHAREPOINT_SITE) {
    throw new Error(`No access guard exists for ${String(inner.kind)} sources`);
  }
  if (inner.kind === SOURCE_KIND.MAILBOX && provider === undefined) {
    throw new Error('a guarded mailbox reader needs the provider it reads through');
  }
  const caller = ctx.caller ?? DISCOVERY_WORKER_SERVICE_IDENTITY;
  const assertShape = (source: SourceRow) => {
    if (source.tenantId !== ctx.tenantId) throw new Error('guarded reader: source belongs to another tenant');
    if (source.kind !== inner.kind) throw new Error('guarded reader: source kind does not match its reader');
    if (provider !== undefined && source.provider !== provider) {
      throw new Error('guarded reader: source provider does not match its reader');
    }
  };
  // `bind`: the first guard call of a read takes the bind step's answer (#275 audit, item 1), so a binding refusal is
  // one state-writing guard call, and one audit, however often the read is attempted. The bind step runs only after
  // the guard's read-only verdict allowed the read, so no provider request precedes a guard decision (#262); when the
  // verdict denies, mailbox_guard_check below refuses and records it, as for any read.
  const assertSource = async (source: SourceRow, bind?: BindMailbox) => {
    assertShape(source);
    // A mailbox read whose provider check is not a function, or whose answer is
    // neither null (in the group) nor a known provider reason, is a wiring fault
    // and fails closed (round 2 item 4, round 3 item 5): the guard is still asked,
    // with `mirror_unavailable`, so it refuses and audits, and the refusal is
    // thrown here even if the guard did not. The provider group mirrors
    // mailboxes only; a site has no group (R23).
    let providerReason =
      source.kind === SOURCE_KIND.MAILBOX ? providerReasonFor(ctx.providerCheck, source.address) : null;
    if (providerReason === null && bind && source.kind === SOURCE_KIND.MAILBOX && provider !== undefined) {
      const verdict = await mailboxGuardVerdict(ctx.tenantId, source.address, { provider, owner: { userId: source.ownerUserId } });
      if (verdict === null) providerReason = await bind(source);
    }
    await assertSourceAllowed(ctx.tenantId, source, {
      purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
      caller,
      provider,
      providerReason,
    });
    if (providerReason !== null) {
      throw new MailboxAccessRefusedError(ctx.tenantId, source.address, providerReason, MAILBOX_GUARD_PURPOSE.PROVIDER_READ);
    }
  };

  // The exclusion policy is asked before the guard, any token mint or any request (#263, R1, R5, R9),
  // so every reader that passes through here, an override included, is covered.
  const assertPolicy = () => {
    const policy = ctx.exclusion?.policy;
    if (policy !== undefined && isUnavailable(policy)) {
      throw policy.unavailable === 'missing' ? new NoExclusionPolicyError() : new InvalidExclusionPolicyError();
    }
    // The policy's rules are mail metadata (labels, classification, markers, participants), so a SharePoint site read
    // is outside it: a non-empty policy neither applies to nor refuses a site. A site's own sensitivity labels are
    // #274's. R9's refusal below is about Graph mail only.
    if (inner.kind !== SOURCE_KIND.MAILBOX) return;
    if (provider === MAILBOX_PROVIDER.GOOGLE && policy === undefined) {
      throw new Error('a guarded Gmail reader needs the tenant exclusion policy');
    }
    if (provider === MAILBOX_PROVIDER.MICROSOFT && policy !== undefined && policy.rules.length > 0) {
      throw new ExclusionNotEnforcedError('Microsoft');
    }
  };

  // One renewal per reader, so a pass that keeps going stale stops instead of looping on directory calls.
  let teamRechecked = false;

  /**
   * The guard's check between pages. A team inbox whose confirmation aged out mid-pass (the guard's
   * team_mailbox_unverified) is renewed once and asked again; every other refusal, and a second one, propagates and
   * stops the pass at this page. Only a source that belongs to a registration is renewed, and only when the worker
   * gave a way to (recheckTeam). The renewal is never an answer: the second question goes to the guard.
   */
  const assertBetweenPages = async (source: SourceRow) => {
    try {
      await assertSource(source);
    } catch (error) {
      if (
        !(error instanceof MailboxAccessRefusedError) ||
        error.reason !== MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_UNVERIFIED ||
        !source.teamMailboxId ||
        !ctx.recheckTeam ||
        teamRechecked
      ) {
        throw error;
      }
      teamRechecked = true;
      await ctx.recheckTeam();
      await assertSource(source);
    }
  };

  async function* guarded(source: SourceRow, open: (read: SourceRow) => AsyncIterable<SourceItemPage>, fromNothing = false) {
    assertPolicy();
    // Before the first page the guard's word is final: a team inbox that is not fresh here was just checked (or could not be).
    // A live Microsoft mailbox's binding check (#275, hooks.bind) runs inside this first guard call only, and binds
    // for this read alone: the token travels on every copy of the source below, the claim copy included (#643).
    const tagged: ReadSource = { ...source, [READ]: {} };
    await assertSource(tagged, hooks.bind);
    // Only once the guard has admitted the source: a refused source is never claimed, so its window stays open.
    const read = fromNothing && ctx.claimFirstRead ? { ...tagged, backfillSince: await ctx.claimFirstRead(source) } : tagged;
    const iterator = open(read)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return;
        ctx.onProgress?.();
        yield step.value;
        await assertBetweenPages(source); // before the next page is requested
      }
    } finally {
      await iterator.return?.();
    }
  }

  return {
    kind: inner.kind,
    backfill: (source, checkpoint) => guarded(source, (read) => inner.backfill(read, checkpoint), checkpoint === null),
    delta: (source, token) => guarded(source, (read) => inner.delta(read, token)),
    // The registration the inner reader authenticates with, for the pass record (#370): ids, never a credential.
    registration: () => inner.registration?.() ?? null,
  };
}

type ExtractFn = NonNullable<GraphReaderContext['extract']>;

/**
 * The live Microsoft read, behind the guard: the worker's (guardedContentSource, no options) and the recording's
 * (createGuardedRecording, which passes `observeFetch` and `extract`). One registration context, built here with the
 * capability, gives two transports. The binding check (#275) always goes over the registration's own client, never
 * observed: nothing outside this module sees its two inbox requests or the object id in one of them. The inner
 * reader goes over the same client, or over `observeHttp(client)` when a recording observes its responses. It
 * acquires no token until its first request, which the wrapper makes only after the guard.
 */
function guardedMicrosoftLive(
  kind: SourceKind,
  ctx: GuardedReaderContext,
  options: { observeHttp?: (http: GraphReaderContext['http']) => GraphReaderContext['http']; extract?: ExtractFn } = {},
): ContentSource {
  if (!ctx.graphRegistration) throw new Error("a live Microsoft reader needs the tenant's reader registration");
  const graph = createGraphReaderContext(readerCapability, ctx.graphRegistration);
  const http = withReadProgress(graph.http, ctx.onProgress);
  const { observeHttp, extract } = options;
  const readerHttp = observeHttp ? withReadProgress(observeHttp(graph.http), ctx.onProgress) : http;
  const graphReader = getContentSource(readerCapability, kind, READER_MODE.GRAPH, {
    ...graph,
    http: readerHttp,
    ...(extract ? { extract } : {}),
  });
  // The registration's public ids as stored, for the pass record (#370); the worker normalizes them.
  const { clientId, certThumbprint } = ctx.graphRegistration;
  // A mailbox is read by its bound directory object (#275 design R4); a site has no group and no binding, and
  // reads under the site guard as it is.
  // Its bind step (the binding check, on the unobserved transport) runs before the first guard call.
  const bound = kind === SOURCE_KIND.MAILBOX ? boundMailboxRead(ctx, http) : null;
  const inner: ContentSource = {
    kind: graphReader.kind,
    backfill: (source, checkpoint) =>
      bound ? bound.open(source, checkpoint, (s, c) => graphReader.backfill(s, c)) : graphReader.backfill(source, checkpoint),
    delta: (source, token) =>
      bound ? bound.open(source, token, (s, t) => graphReader.delta(s, t)) : graphReader.delta(source, token),
    registration: () => ({ clientId, certThumbprint }),
  };
  return createGuardedContentSource(inner, ctx, MAILBOX_PROVIDER.MICROSOFT, bound ? { bind: bound.bind } : {});
}

/**
 * The reader for one provider's kind of source, behind the guard (C2). The
 * provider comes from content_sources.provider, so a Gmail source never reaches
 * the Graph reader (and a Graph source never reaches the Gmail one). `live` is
 * the mode for every provider's real reader; the Graph reader still names its
 * live mode `graph` (#259, C12).
 */
export function guardedContentSource(
  target: { kind: SourceKind; provider: MailboxProvider },
  mode: ReaderMode,
  ctx: GuardedReaderContext,
): ContentSource {
  const { kind, provider } = target;
  let inner: ContentSource;
  switch (provider) {
    case MAILBOX_PROVIDER.MICROSOFT: {
      // The fixture reader serves mailboxes only. Answered here, typed, before the registration check and any
      // guard call, so a fixture site is a source to skip rather than a failed pass.
      if (mode === READER_MODE.FIXTURE && kind !== SOURCE_KIND.MAILBOX) {
        throw new UnsupportedSourceError(kind, provider, mode, `The fixture reader serves mailboxes only, not ${kind}`);
      }
      // `live` is the mode for every provider; the Graph reader still names it `graph` (#259, C12).
      const graphMode = mode === READER_MODE.LIVE ? READER_MODE.GRAPH : mode;
      // The live read is shared with the guarded recording (createGuardedRecording); the worker passes no options.
      if (graphMode === READER_MODE.GRAPH) return guardedMicrosoftLive(kind, ctx);
      inner = getContentSource(readerCapability, kind, graphMode);
      break;
    }
    case MAILBOX_PROVIDER.GOOGLE: {
      // The Gmail reader serves mailboxes only (a Drive reader is out of scope, #259).
      if (kind !== SOURCE_KIND.MAILBOX) {
        throw new UnsupportedSourceError(kind, provider, mode, `The Gmail reader serves mailboxes only, not ${kind}`);
      }
      // Built with the pass's policy; an unavailable one makes both this reader and the wrapper refuse before any request.
      // A missing context reaches the wrapper's check, which refuses it on the first read.
      inner = getGoogleContentSource(readerCapability, kind, mode, {
        exclusion: ctx.exclusion ?? { policy: { unavailable: 'missing' }, threadTaint: new Map() },
        onProgress: ctx.onProgress,
        ...(ctx.dealContacts ? { dealContacts: ctx.dealContacts } : {}),
      });
      break;
    }
    default:
      throw new UnsupportedSourceError(kind, String(provider), mode, `No reader registered for provider ${String(provider)}`);
  }
  return createGuardedContentSource(inner, ctx, provider);
}

/** Records one response and returns the response the reader gets (the same status, headers and bytes). */
export type ResponseObserver = (request: { method: string; url: string }, response: Response) => Promise<Response>;

// Where a pre-authenticated download URL is reported from: a name that can never resolve (scrub.ts, REPLAY_ORIGIN, which
// tests/mailbox-access/readers.test.ts keeps equal to this).
const REPLAY_PLACEHOLDER_ORIGIN = 'https://replay.invalid';

// The only response headers the observer is shown: the ones a cassette keeps (scripts/m365/cassette/format.ts,
// ALLOWED_RESPONSE_HEADERS, which tests/mailbox-access/readers.test.ts keeps equal to this).
const OBSERVED_RESPONSE_HEADERS = ['content-type', 'content-length', 'location'] as const;

const GUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A Graph user addressed by object id, in either key form, at the head of a v1.0 path: /users/<id> or /users('<id>').
const USER_BY_ID_AT_HEAD = new RegExp(
  `^(https://graph\\.microsoft\\.com/v1\\.0)/users(?:/(${GUID_PATTERN})|\\((?:'|%27)(${GUID_PATTERN})(?:'|%27)\\))(?=[/?#]|$)`,
  'i',
);
// The same anywhere in a decoded URL: what is refused when it is not the bound object at the head.
const USER_BY_ID_ANYWHERE = new RegExp(`/users(?:/${GUID_PATTERN}|\\('${GUID_PATTERN}'\\))(?=[/?#]|$)`, 'i');

const OBJECT_ID_REFUSED = 'a request addressed a user other than the bound mailbox by object id; nothing was sent';

/**
 * A recording's request URL under the bound mailbox's UPN. Graph may hand back a paging link (nextLink, deltaLink)
 * that addresses the mailbox by its object id; when that id is the bound key's, the binding check has already shown
 * the id and the UPN reach the same mailbox, so the link is sent as `/users/<upn>`, the path the mail reader builds
 * itself. Any other object id (a site has no key) is null: refused without sending.
 */
function underBoundUpn(url: string, key: ReadKey | null): string | null {
  const head = USER_BY_ID_AT_HEAD.exec(url);
  if (head) {
    const id = head[2] ?? head[3];
    if (key === null || id.toLowerCase() !== key.id.toLowerCase()) return null;
    return `${head[1]}/users/${encodeURIComponent(key.upn)}${url.slice(head[0].length)}`;
  }
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // An undecodable URL is matched as it is.
  }
  return USER_BY_ID_ANYWHERE.test(decoded) ? null : url;
}

/** A JSON page's paging links under the bound UPN, so a cassette asks for what it holds. Other bytes are kept. */
function pageUnderBoundUpn(text: string, key: ReadKey | null): string {
  if (key === null || !text.toLowerCase().includes(key.id.toLowerCase())) return text;
  let page: unknown;
  try {
    page = JSON.parse(text);
  } catch {
    return text;
  }
  if (page === null || typeof page !== 'object' || Array.isArray(page)) return text;
  const links = page as Record<string, unknown>;
  let changed = false;
  for (const name of ['@odata.nextLink', '@odata.deltaLink']) {
    const link = links[name];
    if (typeof link !== 'string') continue;
    const head = USER_BY_ID_AT_HEAD.exec(link);
    const rewritten = head && (head[2] ?? head[3]).toLowerCase() === key.id.toLowerCase() ? underBoundUpn(link, key) : null;
    if (rewritten !== null) {
      links[name] = rewritten;
      changed = true;
    }
  }
  return changed ? JSON.stringify(links) : text;
}

/**
 * One guarded live recording of a Microsoft tenant (#318), for the owner's capture (scripts/m365/record-graph.ts).
 * Every source it hands out is the worker's own guarded live read (guardedMicrosoftLive: the mailbox guard before
 * the first page and after every page, the provider group, the read key and the binding check), under the caller
 * `m365-recorder`, with the reader's responses shown to `observe`. The observer is never given a request header,
 * the token, the certificate or #275's binding check, and of a response it gets the status, the body and only the
 * headers a cassette keeps (content-type, content-length, location): never a Set-Cookie, a request id, a response
 * `.url` or a pre-authenticated download URL. Each 3xx Location, and the request that follows it, is reported as
 * `replay.invalid/content/<n>`, numbered across the whole recording so two sites never share one. The reader keeps
 * the real headers and bytes, follows the real Location, and keeps its retries.
 *
 * A request that addresses the bound mailbox by object id (a paging link Graph may return in that form) is sent
 * under the bound UPN, and the observed copy of each JSON page names its paging links the same way, so the cassette
 * is keyed by UPN throughout and replays as recorded. A request that addresses any other user by object id is
 * refused before it is sent and before the observer is called.
 *
 * Once a request has been refused or `observe` has thrown, every later request throws the same error without
 * reaching Graph, and no later read starts (not even its binding check). So the retry of a transport that throws
 * (graphFetch) can never send another request after an abort, and its backoff sleep throws it too, so the abort
 * surfaces at once rather than after the retries.
 */
export function createGuardedRecording(hooks: { observe: ResponseObserver; extract?: ExtractFn }): {
  sourceFor(
    target: { kind: SourceKind; provider: typeof MAILBOX_PROVIDER.MICROSOFT },
    ctx: GuardedReaderContext & { graphRegistration: ReaderRegistration },
  ): ContentSource;
} {
  const placeholders = new Map<string, string>();
  const placeholderFor = (location: string): string => {
    let placeholder = placeholders.get(location);
    if (placeholder === undefined) {
      placeholder = `${REPLAY_PLACEHOLDER_ORIGIN}/content/${placeholders.size + 1}`;
      placeholders.set(location, placeholder);
    }
    return placeholder;
  };
  let failure: { error: unknown } | null = null;

  const shownHeaders = (headers: Headers): Headers => {
    const shown = new Headers();
    for (const name of OBSERVED_RESPONSE_HEADERS) {
      const value = headers.get(name);
      if (value !== null) shown.set(name, value);
    }
    return shown;
  };

  const observeResponse = async (method: string, url: string, res: Response, key: ReadKey | null): Promise<Response> => {
    const request = { method, url: placeholders.get(url) ?? url };
    const { status, statusText } = res;
    const shown = shownHeaders(res.headers);
    if (status >= 300 && status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (location !== null) shown.set('location', placeholderFor(location));
      const seen = await hooks.observe(request, new Response(null, { status, statusText, headers: shown }));
      await seen.body?.cancel().catch(() => undefined);
      return new Response(null, { status, statusText, headers: res.headers });
    }
    if (/json/i.test(res.headers.get('content-type') ?? '')) {
      // A Graph page is read whole, as the reader reads it: the reader gets the real bytes and the observer a copy
      // whose paging links name the bound UPN.
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const observed = pageUnderBoundUpn(text, key);
      if (observed !== text) shown.delete('content-length');
      const seen = await hooks.observe(request, new Response(observed === text ? bytes : observed, { status, statusText, headers: shown }));
      await seen.body?.cancel().catch(() => undefined);
      return new Response(bytes, { status, statusText, headers: res.headers });
    }
    const seen = await hooks.observe(request, new Response(res.body, { status, statusText, headers: shown }));
    return new Response(seen.body, { status, statusText, headers: res.headers });
  };

  const refuse = (error: Error): never => {
    failure ??= { error };
    throw failure.error;
  };

  const observing =
    (transport: typeof fetch, key: ReadKey | null): typeof fetch =>
    async (input, init) => {
      if (failure) throw failure.error;
      const method = (init?.method ?? 'GET').toUpperCase();
      const requested = input instanceof Request ? input.url : String(input);
      const url = underBoundUpn(requested, key);
      if (url === null) refuse(new Error(OBJECT_ID_REFUSED));
      const res = await transport(url === requested ? input : url!, init);
      try {
        return await observeResponse(method, url!, res, key);
      } catch (error) {
        failure ??= { error };
        await res.body?.cancel().catch(() => undefined);
        throw error;
      }
    };
  const observingHttp =
    (key: ReadKey | null) =>
    (http: GraphReaderContext['http']): GraphReaderContext['http'] => {
      const sleep = http.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      return {
        ...http,
        fetchImpl: observing(http.fetchImpl ?? ((input, init) => fetch(input, init)), key),
        sleep: async (ms) => {
          if (failure) throw failure.error;
          await sleep(ms);
        },
      };
    };

  return {
    sourceFor(target, ctx) {
      if (target.provider !== MAILBOX_PROVIDER.MICROSOFT) throw new Error('a guarded recording reads Microsoft sources only');
      // Refused when the source is asked for, as guardedMicrosoftLive refuses them, not at the first read.
      if (!ctx.graphRegistration) throw new Error("a live Microsoft reader needs the tenant's reader registration");
      if (target.kind !== SOURCE_KIND.MAILBOX && target.kind !== SOURCE_KIND.SHAREPOINT_SITE) {
        throw new Error(`No access guard exists for ${String(target.kind)} sources`);
      }
      const recording = { ...ctx, caller: M365_RECORDER_SERVICE_IDENTITY };
      // Built per read, with the read key of the source being read (a site has none): the transport knows which
      // object id is the bound one. A missing key is refused by the bound read before any request.
      const live = (source: SourceRow) =>
        guardedMicrosoftLive(target.kind, recording, {
          observeHttp: observingHttp(target.kind === SOURCE_KIND.MAILBOX ? readKeyFor(recording.readKey, source.address) : null),
          extract: hooks.extract,
        });
      // The registration's public ids as stored, for the pass record, as guardedMicrosoftLive reports them.
      const { clientId, certThumbprint } = recording.graphRegistration;
      // After an abort no read starts, so not even a binding check (on the unobserved transport) is sent.
      async function* aborted(error: unknown): AsyncIterable<SourceItemPage> {
        throw error;
      }
      return {
        kind: target.kind,
        registration: () => ({ clientId, certThumbprint }),
        backfill: (source, checkpoint) => (failure ? aborted(failure.error) : live(source).backfill(source, checkpoint)),
        delta: (source, token) => (failure ? aborted(failure.error) : live(source).delta(source, token)),
      };
    },
  };
}

/**
 * The operator's scope probe (scripts/m365/README.md, step 4): for each target,
 * the status and Graph error code a request with the tenant's registration gets.
 * Not a read and not guarded, on purpose: it asks about mailboxes and sites the
 * allowlist does not admit, to show Microsoft refuses them too (403). It returns
 * no body, id or token (src/lib/graph/reader/probe.ts), and the credential
 * stays behind the capability here.
 */
export async function probeReaderScope(
  registration: ReaderRegistration,
  targets: readonly ScopeProbeTarget[],
): Promise<ScopeProbeResult[]> {
  const { http } = createGraphReaderContext(readerCapability, registration);
  const results: ScopeProbeResult[] = [];
  for (const target of targets) results.push(await probeGraphScope(readerCapability, http, target));
  return results;
}

/**
 * The Graph reader over a transport the caller holds, for the cassette replay
 * and the recorder's test double (scripts/m365/cassette/). The caller supplies
 * `http` (its own token function and `fetchImpl`), so the registration's
 * credential is never used and never leaves this module: what it reads is what
 * the caller's transport serves. It refuses a context without a `fetchImpl`, so
 * it never falls back to the network on its own.
 *
 * Not guarded at this door, on purpose: replay passes it to runOnce as
 * `readerFor`, and runOnce wraps every such reader in createGuardedContentSource
 * before the first page. The live recorder does NOT use it (record-graph.ts
 * refuses without an injected transport): a live read would need the
 * registration's credential, which only guardedContentSource may use.
 */
export function graphContentSourceOver(kind: SourceKind, graph: GraphReaderContext): ContentSource {
  if (typeof graph.http.fetchImpl !== 'function') {
    throw new Error('graphContentSourceOver needs the transport to read through (http.fetchImpl)');
  }
  return getContentSource(readerCapability, kind, READER_MODE.GRAPH, graph);
}

/**
 * The synthetic bank.example corpus (tests/fixtures/discovery), the mailboxes
 * the fake Graph tenant serves when it records the committed synthetic
 * cassette. The directory is the fixture's own: there is no path argument, so
 * this door reads no other folder.
 */
export function loadFixtureCorpus(): ReturnType<typeof loadFixtureMailboxes> {
  return loadFixtureMailboxes(readerCapability);
}

/**
 * The Google primitives the Gmail trial's operator scripts use (scripts/google/: the connection probe, the
 * synthetic seeders and the replay recorder): the keyless caller credential, the delegated and service-account
 * token mints, and the retrying HTTP client. The scripts reach Google through this door and nothing else, so no
 * script imports a reader module, and the reader fence has no exception for them (tests/fixtures/mailboxReaderFence
 * stays empty).
 *
 * Unguarded on purpose, and not a read of a tenant's mail: the scripts run by hand, against a Workspace trial
 * domain the owner controls, with --live --confirm-domain (scripts/google/lib/live.ts), never from a request,
 * the worker or an agent. They seed and record synthetic mail and probe the connection, so they cannot sit behind
 * a registration's mailbox guard (there is no deal, source or member). What the kit hands out is mint-and-fetch
 * reach: createDelegatedTokenCache signs a token for any subject the caller names. That is why only
 * scripts/google/, tests and this file may import it (GOOGLE_KIT_IMPORTERS_ALLOWED in tests/mailbox-access-pins.test.ts), and
 * why nothing here carries the reader capability: no reader, no ContentSource, no guard bypass for a read.
 *
 * The connection probe also runs from the worker image (#344, design R15): createDirectoryTokenSource is the
 * worker's own directory credential (P08 and P10 test the path the group mirror uses), and the registration
 * mapping lets --tenant read the row the worker reads. Neither adds reach: the first is the directory identity's
 * token, the second is a pure function over a row the caller already holds.
 */
export function googleOperatorKit() {
  return Object.freeze({
    GOOGLE_REGISTRATION_COLUMNS,
    GoogleHttpError,
    GoogleTokenError,
    assertKeylessCredentialFile,
    createCallerTokenSource,
    createDelegatedTokenCache,
    createDirectoryTokenSource,
    googleFetch,
    googleJson,
    googleRegistrationFromRow,
    googleUrl,
    serviceAccountAccessToken,
  });
}

/**
 * The live provider group mirror: Google through the directory identity (#259), and Exchange through the
 * reader registration's scope group (#275). Any other provider fails closed (mirror_unavailable).
 */
export function createLiveAllowlistMirror(): ProviderAllowlistMirror {
  const google = getGoogleGroupMirror(readerCapability);
  const microsoft = getGraphGroupMirror(readerCapability);
  return {
    async listMembers(tenantId, provider) {
      if (provider === MAILBOX_PROVIDER.GOOGLE) return google.listMembers(tenantId, provider);
      if (provider === MAILBOX_PROVIDER.MICROSOFT) return microsoft.listMembers(tenantId, provider);
      throw new Error(`No live allowlist mirror for provider ${provider} yet`);
    },
  };
}

/**
 * The live Google Directory check of a team inbox address (#581): is it a real, active user mailbox, not an alias or
 * a Google Group. Like the group mirror it answers a verdict about an address and hands out no reader, no token and
 * no mail, so the worker may hold it. A team source is still read only through the guard.
 */
export function createLiveTeamMailboxVerifier(): TeamMailboxVerifier {
  return getGoogleTeamMailboxVerifier(readerCapability);
}

/**
 * The fixture Directory check of a team inbox address (#581): the replay folder is the Directory, so an address with a
 * replayed mailbox is a user mailbox and any other is not found. Like the live check it answers a verdict about an
 * address and hands out no reader, no token and no mail. Refused in production.
 */
export function createFixtureTeamMailboxVerifier(): TeamMailboxVerifier {
  return getFixtureTeamMailboxVerifier(readerCapability);
}
