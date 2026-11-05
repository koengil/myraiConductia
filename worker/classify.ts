// The classification worker (Q1): Graph read, normalization, firm routing,
// clustering and persistence. It is the future classification zone, so it
// never calls a model: ESLint fences it off from the model gateway, Anthropic
// and Ignatious. It writes with the service role and never serves a user
// request. Reads only allowlisted mailboxes, through @/lib/mailboxAccess (#262).
//
// Two ways to run it:
//
//   --serve   the long-running pg-boss consumer (phase 4; the container's
//             `classify` entrypoint). A scheduled tick queues one sync job
//             per active content source; each sync reads pages from the
//             source's checkpoint and persists the checkpoint after every
//             page, so a killed or redeployed worker resumes where it
//             stopped; a discover job per tenant then clusters. Throttling
//             is absorbed by graphFetch (Retry-After) and, past that, by the
//             job's retries with backoff. Turning discovery_worker_enabled
//             (or deal_discovery) off pauses it without a deploy: the tick
//             queues nothing and a running sync stops after its current page.
//             Every page is read through the guarded reader, which asks the
//             mailbox or site guard before each one (#262).
//   (none)    one pass over every active registration, or --tenant <uuid>:
//             the phase 3 command, now resumable too (npm run
//             worker:classify, scripts/seed-discovery.ts, the tests).
//             --recount re-reads every source from the start and moves no
//             checkpoint (#460): the coverage count of a source that
//             something already read. Not with --serve.
//             --propose (demo only, #460; delete with #459) is a --recount
//             that also asks a model about each message the rules left
//             unrouted, through src/lib/discovery/propose/step.ts, the one
//             exception to the fence above. It runs only when every lock is
//             open (propose/gate.ts) and otherwise reads nothing. Not with
//             --serve: the service never holds the step, and --serve refuses
//             to start while AI_GATEWAY_API_KEY is set.
//
//   DISCOVERY_READER_MODE=fixture|live node --import tsx worker/classify.ts [--serve] [--tenant <uuid>] [--recount | --propose]
//   (GRAPH_READER_PROVIDER and the value `graph` are aliases for one release, #259 C12.)

// First import, on purpose: it claims the reader capability before any other
// module loads, so a hostile earlier claim fails this process at start
// (tests/mailbox-access/boot-claim.test.ts pins the order).
import '@/lib/mailboxAccess/readers';

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PgBoss } from 'pg-boss';

import {
  DISCOVERY_WORKER_SERVICE_IDENTITY,
  DRIFT_STATUS,
  GROUP_REMOVAL_BREAKER_ACTIVE,
  HISTORY_WINDOW_EXCEEDED,
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  MAILBOX_PROVIDERS,
  MAILBOX_REFUSAL_REASON,
  READER_MODE,
  READER_PASS_REASON,
  READER_PASS_STATUS,
  REGISTRATION_STATUS,
  SOURCE_STATUS,
  TENANT_CAPABILITY,
  type DriftStatus,
  type MailboxProvider,
  type ReaderMode,
  type SourceKind,
  type SourceRefusalReason,
} from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { SEND_CENSUS_WEEKS } from '@/lib/constants/sendCensus';
import { errorCodeOf } from '@/lib/errors/upstream';
import { isEnabled } from '@/lib/flags/isEnabled';
import type { FlagKey } from '@/lib/flags/keys';
import { flagSourceFor } from '@/lib/flags/supabaseSource';
import { loadExclusionPolicy } from '@/lib/discovery/exclusion/load';
import { loadDealContacts } from '@/lib/discovery/sendCensus/load';
import { isUnavailable } from '@/lib/discovery/exclusion/types';
import { readThreadTaint, SourceArchivedError, type CandidateResult } from '@/lib/discovery/persist';
import { readerModeFromEnv } from '@/lib/discovery/source/mode';
import { loadTenantApprovals } from '@/lib/discovery/tenantApprovals';
// Demo-only (#460): the proposal step, built here before any read. No model gateway import (fence B).
import { listedTeamFirms } from '@/lib/discovery/propose/gate';
import {
  MAX_CONSECUTIVE_FAILURES,
  PROPOSE_FLAG,
  proposeStepFor,
  type ProposeOptions,
  type ProposeStep,
  type ProposeTally,
} from '@/lib/discovery/propose/step';
import { assertWorkerSecretKeyShape } from '@/lib/supabase/secretKeyShape';
import {
  assertSourceAllowed,
  createFixtureAllowlistMirror,
  createFixtureTeamMailboxVerifier,
  createGuardedContentSource,
  createLiveAllowlistMirror,
  createLiveTeamMailboxVerifier,
  guardedContentSource,
  MailboxAccessRefusedError,
  readableMailboxes,
  UnsupportedSourceError,
  type ContentSource,
  type GuardedReaderContext,
  type ProviderAllowlistMirror,
  type ProviderRefusalReason,
  type ReadableMailboxes,
  type ReaderRegistration,
  type TeamMailboxVerifier,
} from '@/lib/mailboxAccess';
import {
  createBoss,
  databaseUrlFromEnv,
  ensureQueues,
  QUEUE,
  CENSUS_CRON,
  TICK_CRON,
  type DiscoverJobData,
  type SyncJobData,
} from './boss';
import { acceptStep, ACCEPT_LEASE, ACCEPT_MAX_AGE, type AcceptReadResult } from './accept';
import {
  beginPass,
  emptyCounts,
  outcomeOfFailure,
  runPass,
  workerIdentity,
  type PassOutcome,
  type ReaderPass,
} from './passRecord';
import { failureReason, logEvent, runJob, type JobLine } from './jobLog';
import { progressMarker } from './progress';
import { checkTeamMailbox, recheckTeamMailbox } from './teamMailbox';
import {
  discoverTenant,
  emptyReadTally,
  emptyRoutingTally,
  firstReadClaim,
  loadRoutingContext,
  SYNC_MAX_PAGES,
  syncSource,
  type AcceptRead,
  type RoutingContext,
  type ReadTally,
  type RoutingTally,
  type SyncResult,
  type SyncSource,
} from './sync';

export const WORKER_FLAG: FlagKey = 'discovery_worker_enabled';
export { SYNC_MAX_PAGES };

/**
 * Overrides the reader per source (tests: a reader that crashes or counts). It
 * supplies the inner reader only: the worker wraps whatever it returns in the
 * guard (createGuardedContentSource), so an override never reads around the
 * allowlist (#262).
 */
export type ReaderFactory = (source: SyncSource) => ContentSource;

export type RunOnceOptions = {
  tenantId: string;
  /** Service-role client. Defaults to one built from the environment. */
  db?: SupabaseClient;
  /** Defaults to DISCOVERY_READER_MODE (GRAPH_READER_PROVIDER is its alias for one release). */
  provider?: ReaderMode;
  /** The provider group. Defaults to the fixture mirror in fixture mode; required otherwise. */
  mirror?: ProviderAllowlistMirror;
  /** Overrides the inner reader per source; the guard still wraps it. */
  readerFor?: ReaderFactory;
  /** Overrides the Directory check of a team inbox address (tests). Defaults to the live check in live mode, none otherwise. */
  teamVerifier?: TeamMailboxVerifier;
  /**
   * Re-read every source from the start without moving its stored checkpoint (#460, --recount): the coverage count
   * then never depends on what read the source before. See SyncOptions.reread.
   */
  reread?: boolean;
  /**
   * Demo-only (#460, --propose; delete with #459): ask the proposal step about each message the rules leave unrouted.
   * Its locks are checked first, before any source is named or read: a refusal returns `propose_refused` and reads
   * nothing. Implies `reread`. Tests may pass a transport or a store; classify-once passes `{}`.
   */
  propose?: ProposeOptions;
};

/**
 * The proposal step's counts on a --propose run: its tally, how it stopped, and (G-01 #173) how many sources it did
 * not read (a team inbox of an unapproved firm, an ownerless mailbox) and how many a pass refusal stopped. Numbers only.
 */
export type ProposedSummary = ProposeTally & {
  stopped?: boolean;
  stoppedBy?: 'zdr_unavailable' | 'ledger';
  sourcesSkipped?: number;
  sourcesRefused?: number;
};

export type RefusedSource = { sourceId: string; reason: SourceRefusalReason };
/**
 * A source no reader serves in this mode (a SharePoint site under the fixture reader, a provider whose reader has
 * not landed). It is skipped and reported, and the pass reads every other source (C8, C28). Not a guard refusal:
 * nothing was asked of the allowlist, and nothing was read.
 */
export const SOURCE_SKIP_REASON = {
  UNSUPPORTED_READER: 'unsupported_reader',
  /**
   * The source was archived (a new holder's opt-in, or a merge) or deleted (its owner's consent ended, #461) while a
   * page of it was in flight, so the database refused that page's provenance (or an archived one's checkpoint) write
   * (source_archived, audit round 4, Codex 3). The page is not stored for the source and the pass goes on; the next
   * one reads the live source of the address, if any. A deleted source's page leaves items no mailbox holds: the
   * tick's backstop (collectOrphans) deletes them.
   */
  SOURCE_ARCHIVED: 'source_archived',
  // #370 pass reasons: the tenant has no active reader registration, or the queued source is gone or not active.
  NO_PROVIDER: 'no_provider',
  SOURCE_INACTIVE: 'source_inactive',
  // The source halted (history_window_exceeded) and waits for the firm admin's restart
  // (discovery_restart_mailbox_source): a job queued before the halt reads nothing.
  SOURCE_HALTED: 'source_halted',
} as const;
export type SourceSkipReason = (typeof SOURCE_SKIP_REASON)[keyof typeof SOURCE_SKIP_REASON];
export type SkippedSource = { sourceId: string; kind: SourceKind; reason: SourceSkipReason };
/** One provider's part of a pass: its group's drift and the sources it refused. */
export type ProviderRun = {
  provider: MailboxProvider;
  allowlist: DriftStatus;
  sources: number;
  refused: RefusedSource[];
};
/** One reader pass a run recorded (#370): the source and the pass id joining its two audit events. */
export type PassRef = { sourceId: string; passId: string };
/**
 * The run's routing counts (#460), summed over the sources it read: routed + unrouted + skipped + collisions === read.
 * `codenames` is the number of distinct codenames routed, never the codenames. `fullRead` is true when every source
 * the run read was read whole, from a null checkpoint to its end; refused and skipped sources are reported apart.
 */
export type RoutingSummary = {
  read: number;
  routed: number;
  unrouted: number;
  skipped: number;
  collisions: number;
  codenames: number;
  fullRead: boolean;
  /** Alias and thread routes a source scope refused, summed over the sources read (#173 G-09). A count, outside the partition. */
  scopeBlocked: number;
};
export type RunSummary =
  | {
      tenantId: string;
      status: 'skipped';
      reason: 'no_active_registration' | 'flag_disabled' | 'propose_refused';
      passes: PassRef[];
      /** With `propose_refused`: the lock's code (flag_off, tenant_not_listed, or the processor gate's). Never text. */
      code?: string;
    }
  | {
      tenantId: string;
      status: 'ok';
      runId: string;
      sources: number;
      /** Items read in this run: a resumed or incremental run reads only what is new. */
      itemsRead: number;
      /** Distinct items stored in this run. */
      itemsStored: number;
      /** Bodies the readers retrieved, and messages the exclusion policy excluded first (counts, #344 G2; #370 R2-M1). */
      fetched: number;
      excluded: number;
      /** Incoming-mail screening across the run's sources (plan v5 W3): messages the send-time rules read, and how many they flag. Counts only. */
      screening: { screened: number; flagged: number };
      candidates: CandidateResult[];
      /** Every refused source, whatever its provider. Each provider's own are in `providers`. */
      refused: RefusedSource[];
      /** Sources no reader serves in this mode. Skipped, not refused; the rest of the pass ran. */
      skipped: SkippedSource[];
      /** The worst group state across providers (unavailable, then drift, then in_sync). */
      allowlist: DriftStatus;
      /** One entry per provider that has an active registration in the tenant. */
      providers: ProviderRun[];
      /** One reader pass per active source, all sharing runId (#370). */
      passes: PassRef[];
      /** What routing decided for the items read (#460). Counts only. */
      routing: RoutingSummary;
      /** Demo-only (#460): the proposal step's counts, on a --propose run. Never a name, a subject or an id. */
      proposed?: ProposedSummary;
    };

export function serviceClientFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  // The classify service and classify-once both build their client here: in
  // production the legacy JWT service_role key is refused (#344, design R18).
  assertWorkerSecretKeyShape(env);
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) {
    throw new Error('The classification worker needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type RegistrationRow = {
  tenant_id: string;
  ms_tenant_id: string;
  client_id: string;
  cert_thumbprint: string | null;
  cert_secret_ref: string | null;
};

// Where each provider's reader registration lives. A provider with no table is
// never asked for a registration and so is never read.
export const REGISTRATION_TABLE: Record<MailboxProvider, string | null> = {
  [MAILBOX_PROVIDER.MICROSOFT]: TABLE.GRAPH_READER_REGISTRATIONS,
  [MAILBOX_PROVIDER.GOOGLE]: TABLE.GOOGLE_READER_REGISTRATIONS,
};

/** The providers with an active reader registration for this tenant, in MAILBOX_PROVIDERS order. */
async function activeProviders(db: SupabaseClient, tenantId: string): Promise<MailboxProvider[]> {
  const active: MailboxProvider[] = [];
  for (const provider of MAILBOX_PROVIDERS) {
    const table = REGISTRATION_TABLE[provider];
    if (!table) continue;
    const { data, error } = await db
      .from(table)
      .select('tenant_id')
      .eq('tenant_id', tenantId)
      .eq('status', REGISTRATION_STATUS.ACTIVE)
      .maybeSingle();
    if (error) throw new Error(`registration lookup failed (${errorCodeOf(error)})`);
    if (data) active.push(provider);
  }
  return active;
}

/** Every tenant with an active registration under any provider. */
async function tenantsWithActiveRegistration(db: SupabaseClient): Promise<string[]> {
  const tenants = new Set<string>();
  for (const provider of MAILBOX_PROVIDERS) {
    const table = REGISTRATION_TABLE[provider];
    if (!table) continue;
    const { data, error } = await db.from(table).select('tenant_id').eq('status', REGISTRATION_STATUS.ACTIVE);
    if (error) throw new Error(`registration lookup failed (${errorCodeOf(error)})`);
    for (const row of (data ?? []) as Array<{ tenant_id: string }>) tenants.add(row.tenant_id);
  }
  return [...tenants];
}

const DRIFT_SEVERITY: Record<DriftStatus, number> = {
  [DRIFT_STATUS.IN_SYNC]: 0,
  [DRIFT_STATUS.DRIFT]: 1,
  [DRIFT_STATUS.UNAVAILABLE]: 2,
};
function worstOf(statuses: DriftStatus[]): DriftStatus {
  return statuses.reduce<DriftStatus>(
    (worst, status) => (DRIFT_SEVERITY[status] > DRIFT_SEVERITY[worst] ? status : worst),
    DRIFT_STATUS.IN_SYNC,
  );
}

type SourceDbRow = {
  id: string;
  tenant_id: string;
  kind: SourceKind;
  provider: MailboxProvider;
  address: string;
  owner_user_id: string | null;
  delta_checkpoint: string | null;
  backfill_completed_at: string | null;
  backfill_started_at: string | null;
  history_expiry_streak: number;
  last_synced_at: string | null;
  last_error: string | null;
  backfill_since: string | null;
  team_mailbox_id: string | null;
};

// One literal, so supabase-js reads the column list at the type level.
const SOURCE_COLUMNS =
  'id, tenant_id, kind, provider, address, owner_user_id, delta_checkpoint, backfill_completed_at, backfill_started_at, history_expiry_streak, last_synced_at, last_error, backfill_since, team_mailbox_id';

/**
 * A source handleExpiry halted: neither queued nor read until the firm admin restarts it. Filtered after the query, so
 * a row without the column reads as not halted.
 */
function isHalted(row: { last_error?: string | null }): boolean {
  return row.last_error === HISTORY_WINDOW_EXCEEDED;
}

/**
 * Whether the source is halted now, read just before its reader is built: runOnce names its sources once, before the
 * first is read, so a source that halts in the meantime (another job's handleExpiry) is caught here, not read again.
 * A row gone since is left to the read, which handles it as before.
 */
async function haltedNow(db: SupabaseClient, source: SyncSource): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('last_error')
    .eq('id', source.id)
    .eq('tenant_id', source.tenantId)
    .maybeSingle();
  if (error) throw new Error(`content source lookup failed (${errorCodeOf(error)})`);
  return data !== null && isHalted(data as { last_error: string | null });
}

function toSyncSource(row: SourceDbRow): SyncSource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    provider: row.provider,
    address: row.address,
    ownerUserId: row.owner_user_id,
    deltaCheckpoint: row.delta_checkpoint,
    backfillCompletedAt: row.backfill_completed_at,
    backfillStartedAt: row.backfill_started_at,
    historyExpiryStreak: row.history_expiry_streak,
    lastSyncedAt: row.last_synced_at,
    backfillSince: row.backfill_since,
    // An admin-managed team inbox (#581); a test row that omits the column reads as a person's mailbox.
    teamMailboxId: row.team_mailbox_id ?? null,
  };
}

function toReaderRegistration(row: RegistrationRow): ReaderRegistration {
  return {
    tenantId: row.tenant_id,
    msTenantId: row.ms_tenant_id,
    clientId: row.client_id,
    certThumbprint: row.cert_thumbprint,
    certSecretRef: row.cert_secret_ref,
  };
}

/** The tenant's active Microsoft registration, which a live Graph read authenticates with. */
async function graphRegistration(db: SupabaseClient, tenantId: string): Promise<ReaderRegistration | null> {
  const { data, error } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id, ms_tenant_id, client_id, cert_thumbprint, cert_secret_ref')
    .eq('tenant_id', tenantId)
    .eq('status', REGISTRATION_STATUS.ACTIVE)
    .maybeSingle();
  if (error) throw new Error(`registration lookup failed (${errorCodeOf(error)})`);
  return data ? toReaderRegistration(data as RegistrationRow) : null;
}

/**
 * The provider group mirror. The fixture mode has its own; live mode builds the
 * live mirror, Google's group through the directory identity (#259) and the
 * Exchange scope group through the reader registration (#275, which lifts D68's
 * live Microsoft refusal); any other mode must be given one, or the worker
 * refuses to read (#262: the group only mirrors the allowlist, and a read
 * without it fails closed).
 */
export const GRAPH_MODE_NEEDS_MIRROR_MESSAGE = 'graph mode replays a cassette; give it a mirror.';

// The live mirrors this worker built itself (live mode). Since #275 each has an Exchange half as well as the
// Google one; the set now only tells a live Microsoft group read apart for groupRemovalExcludes below.
const LIVE_MIRRORS = new WeakSet<ProviderAllowlistMirror>();

function mirrorFor(mode: ReaderMode, db: SupabaseClient, mirror?: ProviderAllowlistMirror): ProviderAllowlistMirror {
  if (mirror) return mirror;
  if (mode === READER_MODE.FIXTURE) return createFixtureAllowlistMirror(db);
  // `graph` is the cassette replay's mode, which brings its own mirror. It also gets an implicit empty exclusion
  // policy for Microsoft (src/lib/discovery/exclusion/load.ts), so it must never build the live mirror (#275 R6).
  if (mode !== READER_MODE.LIVE) throw new Error(GRAPH_MODE_NEEDS_MIRROR_MESSAGE);
  const live = createLiveAllowlistMirror();
  LIVE_MIRRORS.add(live);
  return live;
}

/**
 * Group removal (#461, D93) does not cover live Microsoft mailboxes. Before #275 the live mirror never read the
 * Exchange group (D68), so no Microsoft address was ever sighted in it and none could be withdrawn, and so purged,
 * for leaving it. #275 (D100) lifts D68 for READS only: a live Microsoft pass reads its group and an address missing
 * from it (or bound ambiguously) is not read, but its presence is not recorded, so no group-absence row exists and
 * discovery_withdraw_group_removed can never select it; the tick's group check skips the provider too. Letting an
 * Exchange group removal withdraw the consent and purge the mailbox's stored mail is an owner decision.
 */
function groupRemovalExcludes(provider: MailboxProvider, mirror: ProviderAllowlistMirror): boolean {
  return LIVE_MIRRORS.has(mirror) && provider === MAILBOX_PROVIDER.MICROSOFT;
}

/** One provider's pass: its group, read once, and the guarded reader context its sources share. */
type ProviderPass = { provider: MailboxProvider; group: ReadableMailboxes; ctx: GuardedReaderContext };

async function providerPass(
  db: SupabaseClient,
  tenantId: string,
  provider: MailboxProvider,
  mode: ReaderMode,
  mirror: ProviderAllowlistMirror,
): Promise<ProviderPass> {
  // The provider group only mirrors the allowlist: read the intersection,
  // record drift, and read nothing when the group cannot be read (#262). Each
  // provider's group is compared with its own mailboxes only.
  const group = await readableMailboxes(db, tenantId, provider, mirror, {
    recordPresence: !groupRemovalExcludes(provider, mirror),
  });
  // The tenant's exclusion policy (#263), loaded once for the pass and given to every provider's reader. A missing
  // (any mode that can read live Gmail) or invalid one is a value, not a throw: the guard wrapper refuses on the first read, so the refusal lands
  // in the source's Last error. The thread taint is per source (a thread id is per mailbox): sourcePass reads it.
  const policy = await loadExclusionPolicy(db, tenantId, mode, provider);
  // readKey: the directory object each bound mailbox resolves to, which a live Graph mailbox read is checked against
  // and addressed by (#275 design R4).
  const ctx: GuardedReaderContext = {
    tenantId,
    providerCheck: group.providerCheck,
    readKey: group.readKey,
    exclusion: { policy, threadTaint: new Map() },
  };
  if (provider === MAILBOX_PROVIDER.GOOGLE) {
    ctx.dealContacts = await loadDealContacts(db, tenantId, (reason) =>
      logEvent({ evt: 'census_contacts', tenant: tenantId, status: 'failed', reason }),
    );
  }
  if ((mode === READER_MODE.LIVE || mode === READER_MODE.GRAPH) && provider === MAILBOX_PROVIDER.MICROSOFT) {
    ctx.graphRegistration = (await graphRegistration(db, tenantId)) ?? undefined;
  }
  return { provider, group, ctx };
}

/**
 * The pass as one source reads it: the same group and policy, plus the conversations a thread-scoped rule has already
 * excluded in this source's mailbox, which the reader cannot read from the database itself (#263, Q1). Read right
 * before the source's reader is built, in both entry points. An unavailable policy needs none: the guard wrapper
 * refuses before any request.
 */
async function sourcePass(db: SupabaseClient, pass: ProviderPass, source: SyncSource): Promise<ProviderPass> {
  const exclusion = pass.ctx.exclusion;
  if (!exclusion || isUnavailable(exclusion.policy)) return pass;
  const threadTaint = await readThreadTaint(db, source.id, exclusion.policy);
  return { ...pass, ctx: { ...pass.ctx, exclusion: { policy: exclusion.policy, threadTaint } } };
}

/** The reader for one source, always behind the guard (#262), whether it is the real one or an override. */
function guardedReaderFor(source: SyncSource, mode: ReaderMode, pass: ProviderPass, override?: ReaderFactory): ContentSource {
  if (override) {
    // The wrapper checks that a policy exists, not what a reader yields, so an override that ignored a non-empty
    // policy would still hand back excluded messages in full. Overrides are confined, not verified (#263, R1): only
    // the real Gmail reader reads under a rule. (A Microsoft source under a rule is refused by the wrapper, R9.)
    const policy = pass.ctx.exclusion?.policy;
    if (pass.provider === MAILBOX_PROVIDER.GOOGLE && policy && !isUnavailable(policy) && policy.rules.length > 0) {
      throw new Error('an override reader cannot enforce the exclusion policy');
    }
    return createGuardedContentSource(override(source), pass.ctx, pass.provider);
  }
  return guardedContentSource({ kind: source.kind, provider: pass.provider }, mode, pass.ctx);
}

// The live Directory check, built on first use: nothing is read or minted until a team source is checked.
let liveTeamVerifier: TeamMailboxVerifier | undefined;

/**
 * The Directory check of a team inbox address for a mode (#581). Live asks the Google Directory; fixture answers from
 * the replay folder (refused in production). Graph has none: connect is Gmail-only, so a team source there is never
 * checked, stays pending, and is never read.
 */
function verifierFor(mode: ReaderMode, override?: TeamMailboxVerifier): TeamMailboxVerifier | null {
  if (override) return override;
  if (mode === READER_MODE.LIVE) return (liveTeamVerifier ??= createLiveTeamMailboxVerifier());
  // Built per check, on purpose: it holds nothing, and it reads the replay folder the environment names at that moment.
  if (mode === READER_MODE.FIXTURE) return createFixtureTeamMailboxVerifier();
  return null;
}

/**
 * The Directory check of each team source, before its provider group is read (#581; audit item 10), from both entry
 * points. The group is compared with allowed_team_mailboxes, which a registration enters only once a check succeeds,
 * so the check runs first: a registration verified this tick is read this tick, and the drift record does not flap
 * between the check and the next pass. The check only updates the registry; whether a source may be read is still the
 * guard's answer, page by page. A person's mailbox pays for no round trip.
 */
async function checkTeamSources(
  db: SupabaseClient,
  sources: readonly SyncSource[],
  mode: ReaderMode,
  override?: TeamMailboxVerifier,
): Promise<void> {
  for (const source of sources) {
    if (source.teamMailboxId) await checkTeamMailbox(db, source, verifierFor(mode, override));
  }
}

/** Adds one source's routing split to the run's. */
function addRouting(into: RoutingTally, from: RoutingTally): void {
  into.routed += from.routed;
  into.unrouted += from.unrouted;
  into.skipped += from.skipped;
  into.collisions += from.collisions;
  into.scopeBlocked += from.scopeBlocked;
  for (const key of from.codenameKeys) into.codenameKeys.add(key);
}

/** A guard refusal is a refused source, not a failed run. no_capability is a wiring fault: never swallowed. */
function refusalOf(error: unknown): SourceRefusalReason | null {
  if (!(error instanceof MailboxAccessRefusedError) || error.reason === 'no_capability') return null;
  return error.reason;
}

/**
 * The provider group's answer for one mailbox, failing closed like the guarded reader's own (readers.ts): anything but
 * null or a provider reason is `mirror_unavailable`.
 */
function providerReasonOf(check: GuardedReaderContext['providerCheck'], address: string): ProviderRefusalReason | null {
  const unavailable = MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
  if (typeof check !== 'function') return unavailable;
  let answer: unknown;
  try {
    answer = check(address.toLowerCase());
  } catch {
    return unavailable;
  }
  if (answer === null) return null;
  if (answer === MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP) return MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP;
  return unavailable;
}

/**
 * Whether the mailbox guard (#262) and the exclusion policy (#338) admit a read of this source now, WITHOUT reading it.
 * An accept's stored resume has no read of its own, so this is its re-check; the reads themselves are asked page by page
 * by the guarded reader. A refusal is false; any other failure throws.
 */
async function sourceAdmitted(pass: ProviderPass, source: SyncSource): Promise<boolean> {
  const policy = pass.ctx.exclusion?.policy;
  if (policy !== undefined && isUnavailable(policy)) return false;
  // The reader's own pairing rules (assertPolicy): a Gmail source needs a policy, a Graph source cannot be read under rules.
  if (pass.provider === MAILBOX_PROVIDER.GOOGLE && policy === undefined) return false;
  if (pass.provider === MAILBOX_PROVIDER.MICROSOFT && policy !== undefined && policy.rules.length > 0) return false;
  const providerReason = providerReasonOf(pass.ctx.providerCheck, source.address);
  try {
    await assertSourceAllowed(
      source.tenantId,
      { kind: source.kind, address: source.address, ownerUserId: source.ownerUserId },
      {
        purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
        caller: pass.ctx.caller ?? DISCOVERY_WORKER_SERVICE_IDENTITY,
        provider: pass.provider,
        providerReason,
      },
    );
  } catch (error) {
    if (refusalOf(error)) return false;
    throw error;
  }
  return providerReason === null;
}

/** What a pass read before a stop ended it mid-read: the pass end's counts, for the job line and the run totals. */
type ReadCounts = { pages: number; fetched: number; excluded: number; stored: number };

type SourceOutcome =
  | SyncResult
  | ({ status: 'skipped'; skipReason: SourceSkipReason } & Partial<ReadCounts>)
  | ({ status: 'refused'; reason: SourceRefusalReason } & Partial<ReadCounts>);

/**
 * One source, read under its pass (#370): the per-source body both entry points share, so they cannot diverge. It
 * re-checks the halt, builds the guarded reader, then loads the routing context, then reads, and turns the expected stops into
 * results; anything else throws. The only caller of syncSource (pinned by tests/discovery/reader-pass-pins.test.ts).
 */
async function readOneSource(
  db: SupabaseClient,
  a: {
    source: SyncSource;
    providerRun: ProviderPass;
    mode: ReaderMode;
    readerFor?: ReaderFactory;
    /** Overrides the team inbox Directory check (RunOnceOptions.teamVerifier). */
    teamVerifier?: TeamMailboxVerifier;
    /** Called only after the reader is built (develop's order, R2-M2); runOnce passes a memoized loader. */
    loadContext: () => Promise<RoutingContext>;
    pass: ReaderPass;
    maxPages?: number;
    shouldContinue?: () => Promise<boolean>;
    /** runOnce's --recount: read from the start, write no resume state (SyncOptions.reread). */
    reread?: boolean;
    /** runOnce's read tally (#460), filled in place so a stop mid-read still counts what was read. Never in a job result. */
    read?: ReadTally;
    /** runOnce's --propose (demo only, #460): the step each page's unrouted messages go to (SyncOptions.propose). */
    propose?: ProposeStep;
    /**
     * An accept's keyed read (G-02b #173, SyncOptions.accept), from acceptStep in the SYNC job only. It is a re-read, so
     * it claims no first read and moves no resume state; it goes through the same guarded reader as every read.
     */
    accept?: AcceptRead;
  },
): Promise<SourceOutcome> {
  // Re-read here, before any reader, for both entry points: a halted source is never read again (S3, #409 audit).
  if (await haltedNow(db, a.source)) return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.SOURCE_HALTED };
  // A team inbox's Directory check ran before its provider group was read (checkTeamSources, both entry points).
  // The guard refuses a team inbox whose last confirmation is 65 minutes old. A pass that outlives that (a long backfill, a
  // --recount re-read) may renew it once, between two pages, through the reader itself; the guard still answers every page.
  const recheckTeam = a.source.teamMailboxId
    ? () => recheckTeamMailbox(db, a.source, verifierFor(a.mode, a.teamVerifier))
    : undefined;
  let reader: ContentSource;
  try {
    // The source's progress mark (reader liveness): the health view reads an unfinished pass as Reading while it moves.
    const pass = await sourcePass(db, a.providerRun, a.source);
    const onProgress = progressMarker(db, a.source);
    // #353: a Gmail first read claims its window once the guard admits it. A re-read moves no resume state, so it
    // claims nothing and reads the window the job loaded. An accept read is one (G-02b R4): it must never stamp
    // backfill_started_at, whether or not its caller also passed `reread`.
    const claim =
      pass.provider === MAILBOX_PROVIDER.GOOGLE && !a.reread && a.propose === undefined && a.accept === undefined
        ? { claimFirstRead: firstReadClaim(db, a.source) }
        : {};
    reader = guardedReaderFor(a.source, a.mode, { ...pass, ctx: { ...pass.ctx, onProgress, recheckTeam, ...claim } }, a.readerFor);
  } catch (error) {
    // A source no reader serves here is skipped before the routing context is read (C8, C28): never a job to
    // retry, and never a reason to abort the sources after it.
    if (error instanceof UnsupportedSourceError) return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.UNSUPPORTED_READER };
    throw error;
  }
  a.pass.attach({ reader });
  const context = await a.loadContext();
  try {
    // Only allowlisted sources are read (#262). The guard runs before every
    // page, so a refusal mid-read stops this source at that page: what was
    // read and checkpointed before it stays, and nothing after it is read.
    return await syncSource(db, {
      source: a.source,
      reader,
      runId: a.pass.runId,
      context,
      counts: a.pass.counts,
      maxPages: a.maxPages,
      shouldContinue: a.shouldContinue,
      reread: a.reread,
      read: a.read,
      propose: a.propose,
      accept: a.accept,
    });
  } catch (error) {
    // An archived or deleted source is no job to retry: the next tick reads the live source of the address, if any.
    // Both stops can come after completed pages: the outcome carries what the pass read, as its end records it (R1).
    const { pages, fetched, excluded, stored } = a.pass.counts;
    const read: ReadCounts = { pages, fetched, excluded, stored };
    if (error instanceof SourceArchivedError) {
      return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.SOURCE_ARCHIVED, ...read };
    }
    // A refusal is the allowlist working, not a job to retry: the next tick asks the guard again.
    const reason = refusalOf(error);
    if (!reason) throw error;
    return { status: 'refused', reason, ...read };
  }
}

/**
 * deal_discovery, read like every server flag and failing closed: off means the
 * worker reads nothing, whatever consents and registrations exist (#262, audit
 * round 1, item 20). Withdrawal stays reachable through the API while it is off.
 */
async function discoveryEnabled(db: SupabaseClient): Promise<boolean> {
  return isEnabled('deal_discovery', flagSourceFor(db));
}

/** The tenant's active sources, in address order: the sources a run reads, and records a pass for. */
async function activeSources(db: SupabaseClient, tenantId: string): Promise<SyncSource[]> {
  const { data: sourceRows, error: sourceError } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select(SOURCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('status', SOURCE_STATUS.ACTIVE)
    .order('address');
  if (sourceError) throw new Error(`content source lookup failed (${errorCodeOf(sourceError)})`);
  return ((sourceRows ?? []) as SourceDbRow[]).filter((row) => !isHalted(row)).map(toSyncSource);
}

/**
 * G-01 (#173): each team inbox source of an approved firm gets that firm's company id, so the sync can hand it to the
 * proposal step. Reads nothing when no firm is approved (the shipped state). A failed read leaves the sources as they
 * are, which keeps every team inbox out of the step: fail closed.
 */
async function withTeamFirms(
  db: SupabaseClient,
  tenantId: string,
  sources: SyncSource[],
  teamFirms: readonly string[],
): Promise<SyncSource[]> {
  const inboxes = [...new Set(sources.flatMap((source) => (source.teamMailboxId ? [source.teamMailboxId] : [])))];
  if (teamFirms.length === 0 || inboxes.length === 0) return sources;
  const { data, error } = await db
    .from(TABLE.TEAM_MAILBOXES)
    .select('id, firm_company_id')
    .eq('tenant_id', tenantId)
    .in('id', inboxes);
  if (error || !Array.isArray(data)) return sources;
  const firmOf = new Map((data as Array<{ id: string; firm_company_id: string | null }>).map((row) => [row.id, row.firm_company_id]));
  return sources.map((source) =>
    source.teamMailboxId ? { ...source, teamFirmCompanyId: firmOf.get(source.teamMailboxId) ?? null } : source,
  );
}

/**
 * One run over a tenant (classify-once, the seed and replay scripts). It names its sources first and starts every
 * source's reader pass (#370) before any tenant-level check, so each pass's startedAt is the run start, and every
 * stop leaves an end: a tenant-level stop finishes every pass; a per-source failure finishes that source failed and
 * the unread ones skipped / run_aborted. A tenant with no active sources records nothing.
 */
export async function runOnce(options: RunOnceOptions): Promise<RunSummary> {
  const { tenantId } = options;
  const db = options.db ?? serviceClientFromEnv();
  const mode = options.provider ?? readerModeFromEnv();
  const worker = workerIdentity(mode);

  // Demo-only (#460): the proposal step's locks, before anything is named or read. A refusal records no pass.
  let propose: ProposeStep | undefined;
  let teamFirms: string[] = [];
  if (options.propose) {
    const flagOn = await isEnabled(PROPOSE_FLAG, flagSourceFor(db));
    // G-01 (#173): a team inbox reaches the step only for a firm company named in the reviewed TS list AND holding a
    // live team_proposals row. Neither alone: the table is read only when the flag is on and the list names a firm
    // for this tenant, and any read error is "none". With the list empty (as shipped) nothing is read.
    const listed = listedTeamFirms(tenantId, options.propose.teamFirmList);
    const approved =
      flagOn && listed.length > 0
        ? new Set(await loadTenantApprovals(db, tenantId, TENANT_CAPABILITY.TEAM_PROPOSALS))
        : new Set<string>();
    teamFirms = listed.filter((firm) => approved.has(firm));
    const built = proposeStepFor({ ...options.propose, tenantId, db, flagOn, teamFirms });
    if (!built.ok) return { tenantId, status: 'skipped', reason: 'propose_refused', code: built.code, passes: [] };
    propose = built.step;
    // A pass a dead run left open is closed as unclosed before any source is read, whether or not anyone may begin
    // on its source again (review F5). It never throws.
    await propose.closeLapsedPasses();
  }

  // Metadata only: the sources a pass is recorded for.
  const sources = await withTeamFirms(db, tenantId, await activeSources(db, tenantId), teamFirms);
  // The ledger's run id, and the run start, shared by every pass of the run.
  const runId = randomUUID();
  const runStartedAt = Date.now();
  const passes = new Map<string, ReaderPass>();
  const passRefs = (): PassRef[] => [...passes.values()].map((pass) => ({ sourceId: pass.sourceId, passId: pass.passId }));
  const finishOpen = async (outcome: PassOutcome) => {
    await Promise.all([...passes.values()].map((pass) => pass.finish(outcome)));
  };
  // Set when the per-source loop starts (R2-m10).
  let reading = false;
  // Read at most once per run, and only once a reader has been built (R2-M2).
  let context: Promise<RoutingContext> | undefined;
  const loadContext = () => (context ??= loadRoutingContext(db, tenantId));
  try {
    for (const source of sources) {
      const pass = await beginPass(db, { tenantId, sourceId: source.id, jobId: null, runId, startedAt: runStartedAt }, worker);
      pass.attach({ provider: source.provider });
      passes.set(source.id, pass);
    }

    if (!(await discoveryEnabled(db))) {
      await finishOpen({ status: READER_PASS_STATUS.DISABLED, reason: READER_PASS_REASON.FLAG_OFF });
      return { tenantId, status: 'skipped', reason: 'flag_disabled', passes: passRefs() };
    }

    // One pass per provider that has an active registration (C2). A provider
    // without one is not read at all.
    const providers = await activeProviders(db, tenantId);
    if (providers.length === 0) {
      await finishOpen({ status: READER_PASS_STATUS.SKIPPED, reason: SOURCE_SKIP_REASON.NO_PROVIDER });
      return { tenantId, status: 'skipped', reason: 'no_active_registration', passes: passRefs() };
    }

    const mirror = mirrorFor(mode, db, options.mirror);
    // Each team source's check, before the groups it is compared in are read (audit item 10).
    await checkTeamSources(db, sources.filter((source) => providers.includes(source.provider)), mode, options.teamVerifier);
    const providerPasses: ProviderPass[] = [];
    for (const provider of providers) providerPasses.push(await providerPass(db, tenantId, provider, mode, mirror));

    // A source whose provider has no active registration is not read: no reader
    // is built, so there is nothing to guard, and the pass reports why.
    const unregistered: RefusedSource[] = sources
      .filter((source) => !providers.includes(source.provider))
      .map((source) => ({ sourceId: source.id, reason: MAILBOX_REFUSAL_REASON.REGISTRATION_INACTIVE }));
    for (const { sourceId, reason } of unregistered) {
      await passes.get(sourceId)?.finish({ status: READER_PASS_STATUS.REFUSED, reason });
    }

    reading = true;
    let itemsRead = 0;
    let fetched = 0;
    let excluded = 0;
    const screening = { screened: 0, flagged: 0 };
    const storedKeys = new Set<string>();
    const routing = emptyRoutingTally();
    let read = 0;
    let readWhole = 0;
    const providerRuns: ProviderRun[] = [];
    const skipped: SkippedSource[] = [];
    for (const providerRun of providerPasses) {
      const own = sources.filter((source) => source.provider === providerRun.provider);
      const refused: RefusedSource[] = [];
      for (const source of own) {
        const pass = passes.get(source.id)!;
        const readTally = emptyReadTally();
        const out = await runPass(pass, () =>
          readOneSource(db, {
            source,
            providerRun,
            mode,
            readerFor: options.readerFor,
            teamVerifier: options.teamVerifier,
            loadContext,
            pass,
            reread: options.reread,
            propose,
            read: readTally,
          }),
        );
        if (out.status === 'skipped' || out.status === 'refused') {
          // A stop mid-read still counts what was read before it, as the pass end does (R1), routing included (#460).
          fetched += out.fetched ?? 0;
          excluded += out.excluded ?? 0;
          itemsRead += readTally.itemsRead;
          addRouting(routing, readTally.routing);
          if (out.status === 'skipped') skipped.push({ sourceId: source.id, kind: source.kind, reason: out.skipReason });
          else refused.push({ sourceId: source.id, reason: out.reason });
        } else {
          itemsRead += out.itemsRead;
          fetched += out.fetched;
          excluded += out.excluded;
          screening.screened += out.screening.screened;
          screening.flagged += out.screening.flagged;
          for (const key of out.storedKeys) storedKeys.add(key);
          addRouting(routing, out.routing);
          read += 1;
          if (out.fullRead) readWhole += 1;
        }
      }
      providerRuns.push({ provider: providerRun.provider, allowlist: providerRun.group.status, sources: own.length, refused });
    }
    const refused = [...providerRuns.flatMap((run) => run.refused), ...unregistered];

    const candidates = await discoverTenant(db, { tenantId, runId });
    return {
      tenantId,
      status: 'ok',
      runId,
      sources: sources.length,
      itemsRead,
      itemsStored: storedKeys.size,
      fetched,
      excluded,
      screening,
      candidates,
      refused,
      skipped,
      allowlist: worstOf(providerRuns.map((run) => run.allowlist)),
      providers: providerRuns,
      passes: passRefs(),
      routing: {
        read: itemsRead,
        routed: routing.routed,
        unrouted: routing.unrouted,
        skipped: routing.skipped,
        collisions: routing.collisions,
        codenames: routing.codenameKeys.size,
        fullRead: read > 0 && readWhole === read,
        scopeBlocked: routing.scopeBlocked,
      },
      ...(propose
        ? {
            proposed: {
              ...propose.tally,
              stopped: propose.stopped,
              ...(propose.stoppedBy ? { stoppedBy: propose.stoppedBy } : {}),
              sourcesSkipped: propose.sources.skipped,
              sourcesRefused: propose.sources.refused,
            },
          }
        : {}),
    };
  } catch (error) {
    // Before the loop, the failure applies to every source: each open pass is failed with its code.
    // Inside it, runPass has already failed the source that threw; the ones never read were aborted.
    // A pass already finished is not finished again.
    await finishOpen(
      reading ? { status: READER_PASS_STATUS.SKIPPED, reason: READER_PASS_REASON.RUN_ABORTED } : outcomeOfFailure(error),
    );
    throw error;
  }
}

// ── The long-running consumer ────────────────────────────────────────────────

/** discovery_worker_enabled, read with the service role. Missing or unreadable means off. */
export async function workerEnabled(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from('feature_flags').select('enabled').eq('key', WORKER_FLAG).maybeSingle();
  if (error) return false;
  return (data as { enabled?: boolean } | null)?.enabled === true;
}

/**
 * Both switches: deal_discovery (the product flag; off means no read at all)
 * and discovery_worker_enabled (the worker's own pause). Either off stops it.
 */
async function readsEnabled(db: SupabaseClient): Promise<boolean> {
  return (await discoveryEnabled(db)) && (await workerEnabled(db));
}

/**
 * The accept step's switches (G-02b #173): reads are enabled (deal_discovery and discovery_worker_enabled, as for every
 * read) AND the demo flag behind the proposals is on. Either off and the step claims nothing and reads nothing.
 */
async function acceptEnabled(db: SupabaseClient): Promise<boolean> {
  return (await readsEnabled(db)) && (await isEnabled(PROPOSE_FLAG, flagSourceFor(db)));
}

// ── Deleting stored mail (#461) ──────────────────────────────────────────────

/**
 * The backstop: every tenant's stored messages no mailbox holds, older than the in-flight guard, are deleted
 * (discovery_collect_orphans_all, one discovery.content_collected row per tenant where something went). Run before
 * the flag gate: a kill switch stops reading, never deletion.
 */
async function collectOrphans(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('discovery_collect_orphans_all', {});
  if (error) throw new Error(`orphan collection failed (${errorCodeOf(error)})`);
}

/**
 * Reads each tenant's provider groups whatever its sources' status (461-R2-03): only a successful check records
 * how long a consented address has been missing from its group, and a sync runs only for an active, unhalted
 * source, so a tenant whose sources are all paused or halted would never be checked. Group membership only, never
 * mail. A provider group removal does not cover (live Microsoft, groupRemovalExcludes) is skipped.
 */
async function checkGroups(db: SupabaseClient, tenants: string[], mirror: ProviderAllowlistMirror): Promise<void> {
  for (const tenantId of tenants) {
    for (const provider of await activeProviders(db, tenantId)) {
      if (!groupRemovalExcludes(provider, mirror)) await readableMailboxes(db, tenantId, provider, mirror);
    }
  }
}

/**
 * Withdraws the consent of a banker missing from their source's provider group for 72 hours, as seen by a check
 * within the hour (discovery_withdraw_group_removed). The withdrawal purges like any other, with reason
 * group_removed. With no fresh check (a failing mirror), nothing qualifies. A tenant where too many consents are due
 * at once is held by the database (the breaker, GROUP_REMOVAL_BREAKER_ACTIVE: under the pilot rule, every one). A hold
 * is the expected pilot state, not a failure: each held tenant is one group_removal_held line (a notice), naming the
 * tenant id and how many withdrawals wait, nothing else. A hold still unreleased 24 hours after it fell due is
 * group_removal_overdue instead, which the deletion-stuck alarm counts, so it is never forgotten.
 */
/** One held tenant, as discovery_withdraw_group_removed returns it: ids and counts only. */
type GroupRemovalHold = { tenant?: unknown; due?: unknown; overdue?: unknown };

async function withdrawGroupRemoved(db: SupabaseClient): Promise<void> {
  const { data, error } = await db.rpc('discovery_withdraw_group_removed', {
    p_max_share: GROUP_REMOVAL_BREAKER_ACTIVE.maxShare,
    p_min_due: GROUP_REMOVAL_BREAKER_ACTIVE.minDue,
  });
  if (error) throw new Error(`group removal failed (${errorCodeOf(error)})`);
  const holds = (data as { holds?: unknown } | null)?.holds;
  for (const hold of Array.isArray(holds) ? (holds as GroupRemovalHold[]) : []) {
    const evt = hold.overdue === true ? 'group_removal_overdue' : 'group_removal_held';
    console.warn(JSON.stringify({ evt, tenant: String(hold.tenant), due: Number(hold.due) } satisfies JobLine));
  }
}

/**
 * Runs one of the tick's two deletion steps, the backstop or the group-removal withdrawal. A failure is logged and
 * the tick goes on: the banker's own purge is synchronous, so reading never depends on these, and a database that
 * is down stops the reads on its own. The deletion is retried on the next tick. The line names what failed and
 * nothing else, no id and no error text.
 */
async function bestEffort(
  evt: 'orphan_collection_failed' | 'group_removal_failed' | 'accept_expiry_failed',
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch {
    console.warn(JSON.stringify({ evt }));
  }
}

/**
 * The tick's backstop for accept requests no job will finish (G-02b #173, design R4), in ONE call over every tenant
 * (p_tenant null): a pending request nobody claimed, and an in-flight one whose lease lapsed, when its source is no
 * longer an active live mailbox or the request is over a day old. A pending one fails as source_unavailable; an
 * in-flight one ends through the finish, so its purge runs. It reads no mail. Like the orphan collector it is deletion
 * housekeeping, not a read: it runs every tick, before the flag gates and whether or not the tenant has an active reader
 * registration (a paused or halted source is exactly where a crashed claim is stranded), and not behind the demo flag.
 * The function takes no lock when there is nothing to do, so a deployment that never turned the feature on pays one
 * indexed existence check. It replaces the per-tenant calls.
 */
async function expireAccepts(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('discovery_expire_model_proposal_accepts', { p_tenant: null, p_max_age: ACCEPT_MAX_AGE });
  if (error) throw new Error(`accept expiry failed (${errorCodeOf(error)})`);
}

/**
 * The accept step inside a SYNC job (G-02b #173): claims this source's due accept requests and serves them with one
 * guarded read. It never throws, so a request that cannot be served leaves the job's own result alone; the request
 * keeps its claim until the lease runs out. Prints ids and counts only.
 */
async function serveAccepts(a: {
  db: SupabaseClient;
  tenantId: string;
  source: SyncSource;
  pass: ReaderPass;
  providerRun: ProviderPass;
  pageBudget: number;
  read: (accept: AcceptRead) => Promise<AcceptReadResult>;
}): Promise<void> {
  try {
    if (!(await acceptEnabled(a.db))) return;
    const result = await acceptStep({
      db: a.db,
      source: a.source,
      // Per attempt, not the pg-boss job id: a retry keeps its job id, so a stale first attempt still alive when the
      // lease lapses would pass every token check as the retry. beginPass draws a new pass id for every sync() call, a
      // retry included (#370), so no two attempts ever share one.
      token: a.pass.passId,
      runId: a.pass.runId,
      onRequestError: (request, error) =>
        // The request id and a code or class name only: never the message, which can quote a value.
        logEvent({ evt: 'accept', tenant: a.tenantId, source: a.source.id, request, status: 'failed', reason: failureReason(error) }),
      read: a.read,
      admitted: () => sourceAdmitted(a.providerRun, a.source),
      pageBudget: a.pageBudget,
      lease: ACCEPT_LEASE,
    });
    if (result.claimed > 0) {
      logEvent({ evt: 'accept', tenant: a.tenantId, source: a.source.id, claimed: result.claimed, finished: result.finished });
    }
  } catch (error) {
    logEvent({ evt: 'accept', tenant: a.tenantId, source: a.source.id, status: 'failed', reason: failureReason(error) });
  }
}

/** What one discovery.sync job did. */
export type SyncJobResult = {
  status: SyncResult['status'] | 'skipped' | 'disabled' | 'refused';
  pages?: number;
  /** Counts for the job line (#344, design R12): bodies retrieved, excluded by policy, distinct items stored. */
  fetched?: number;
  excluded?: number;
  stored?: number;
  /** Incoming-mail screening counts for the job line (plan v5 W3): screened by the send-time rules, and flagged. */
  screened?: number;
  flagged?: number;
  /** Sightings skipped as already processed under the same digest and rules (#461). A count. */
  unchanged?: number;
  reason?: SourceRefusalReason;
  /** Set with status 'skipped': no reader serves the source in this mode (C8), it was archived, it is gone, or the tenant has no registration. */
  skipReason?: SourceSkipReason;
};

export type WorkerHandlers = {
  tick(): Promise<{ queued: number }>;
  census(): Promise<{ tenants: number; rows: number; failed: number; unattributed: number }>;
  /**
   * `meta.jobId` is pg-boss's job id: a retry keeps it, and gets a new reader pass (#370). `meta.signal` is pg-boss's
   * job signal, aborted when the job's heartbeat went stale and it was failed for a retry.
   */
  sync(data: SyncJobData, meta?: { jobId?: string | null; signal?: AbortSignal }): Promise<SyncJobResult>;
  discover(data: DiscoverJobData): Promise<{ candidates: number }>;
};

export function createWorkerHandlers(options: {
  db: SupabaseClient;
  boss: Pick<PgBoss, 'send'>;
  provider: ReaderMode;
  /** The provider group. Defaults to the fixture mirror in fixture mode; required otherwise. */
  mirror?: ProviderAllowlistMirror;
  readerFor?: ReaderFactory;
  /** Overrides the team inbox Directory check (tests); see RunOnceOptions.teamVerifier. */
  teamVerifier?: TeamMailboxVerifier;
  maxPages?: number;
  /** How often a running pass re-reads the flags (ms); tests set 0. */
  flagRecheckMs?: number;
}): WorkerHandlers {
  const { db, boss, provider: mode } = options;
  // Resolved now, so a live worker without a mirror fails at start, not per job.
  const mirror = mirrorFor(mode, db, options.mirror);
  const worker = workerIdentity(mode);

  // One sync attempt, under its pass. Develop's order: flags, providers, source row, registration, providerPass, then
  // readOneSource (reader, then routing context, then syncSource).
  async function attempt(
    { tenantId, sourceId }: SyncJobData,
    pass: ReaderPass,
    signal: AbortSignal | undefined,
  ): Promise<SyncJobResult> {
    if (!(await readsEnabled(db))) return { status: 'disabled' };
    const providers = await activeProviders(db, tenantId);
    if (providers.length === 0) return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.NO_PROVIDER };
    const { data: row, error } = await db
      .from(TABLE.CONTENT_SOURCES)
      .select(SOURCE_COLUMNS)
      .eq('id', sourceId)
      .eq('tenant_id', tenantId)
      .eq('status', SOURCE_STATUS.ACTIVE)
      .maybeSingle();
    if (error) throw new Error(`content source lookup failed (${errorCodeOf(error)})`);
    if (!row) return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.SOURCE_INACTIVE };

    const source = toSyncSource(row as SourceDbRow);
    pass.attach({ provider: source.provider });
    // After disabled, no_provider and source_inactive (unchanged); before the registration refusal, so a halted source
    // with an inactive registration records source_halted (harmless).
    if (isHalted(row as SourceDbRow)) return { status: 'skipped', skipReason: SOURCE_SKIP_REASON.SOURCE_HALTED };
    // No reader is built for a provider without an active registration (C2).
    if (!providers.includes(source.provider)) {
      return { status: 'refused', reason: MAILBOX_REFUSAL_REASON.REGISTRATION_INACTIVE };
    }
    // The team source's check, before its group is read (audit item 10).
    await checkTeamSources(db, [source], mode, options.teamVerifier);
    const providerRun = await providerPass(db, tenantId, source.provider, mode, mirror);
    // Re-read the flags at most every 30 s while a long backfill runs.
    let checkedAt = Date.now();
    let enabled = true;
    // The one place this job reads a source: the normal pass below, and the accept step's keyed read after it, go
    // through the same guarded path (readOneSource), so neither can read around the guard (G-02b #173).
    const readSource = (extra: { accept?: AcceptRead; reread?: boolean; pass?: ReaderPass }) =>
      readOneSource(db, {
        source,
        providerRun,
        mode,
        readerFor: options.readerFor,
        teamVerifier: options.teamVerifier,
        pass,
        loadContext: () => loadRoutingContext(db, tenantId),
        maxPages: options.maxPages ?? SYNC_MAX_PAGES,
        shouldContinue: async () => {
          // pg-boss gave up on this job (a stale heartbeat) and will retry it: stop at this page boundary rather than
          // run a second sync beside the retry. A page already in flight can still write its checkpoint once.
          if (signal?.aborted) return false;
          if (Date.now() - checkedAt > (options.flagRecheckMs ?? 30_000)) {
            enabled = await readsEnabled(db);
            checkedAt = Date.now();
          }
          return enabled;
        },
        ...extra,
      });
    const out = await readSource({});

    // G-02b (#173): after the normal pass, the accept step serves this source's requested accepts. It never fails the
    // job: whatever it could not finish stays claimed until its lease runs out, and the next job claims it again. A
    // source the pass skipped is not read, so it has nothing to serve; a refused one is, so its requests end now.
    if (out.status !== 'skipped' && !signal?.aborted) {
      await serveAccepts({
        db,
        tenantId,
        source,
        pass,
        providerRun,
        pageBudget: options.maxPages ?? SYNC_MAX_PAGES,
        read: async (accept) => {
          // A pass of its own: the accept read must not overwrite the normal pass's counts.
          const outcome = await readSource({
            accept,
            reread: true,
            pass: { ...pass, counts: emptyCounts(), attach: () => undefined },
          });
          if (outcome.status === 'skipped' || outcome.status === 'refused' || !outcome.accepted) return { status: 'unavailable' };
          return { status: 'read', buffer: outcome.accepted };
        },
      });
    }
    if (out.status === 'skipped' || out.status === 'refused') return out;

    // An aborted job queues nothing: pg-boss's retry of it already carries the source on.
    if (signal?.aborted) {
      return { status: out.status, pages: out.pages, fetched: out.fetched, excluded: out.excluded, stored: out.storedKeys.size };
    }
    // A longer backfill queues its own continuation; so does a reset (the
    // provider dropped the incremental cursor and the source backfills again).
    // A halted source queues nothing: a reset would only repeat.
    if (out.status === 'page_limit' || out.status === 'reset') {
      await boss.send(QUEUE.SYNC, { tenantId, sourceId }, { singletonKey: sourceId });
    }
    if (out.storedKeys.size > 0 || out.status === 'complete') {
      await boss.send(QUEUE.DISCOVER, { tenantId }, { singletonKey: tenantId });
    }
    return {
      status: out.status,
      pages: out.pages,
      fetched: out.fetched,
      excluded: out.excluded,
      stored: out.storedKeys.size,
      screened: out.screening.screened,
      flagged: out.screening.flagged,
      unchanged: out.unchanged,
    };
  }

  return {
    async census() {
      if (!(await readsEnabled(db))) return { tenants: 0, rows: 0, failed: 0, unattributed: 0 };
      const tenants = await tenantsWithActiveRegistration(db);
      let rows = 0;
      let failed = 0;
      let unattributed = 0;
      for (const tenantId of tenants) {
        const { data, error } = await db.rpc('send_census_refresh', { p_tenant: tenantId, p_weeks: SEND_CENSUS_WEEKS });
        if (error) {
          failed += 1;
          // The tenant and a fixed code only (#425): logEvent prints nothing that is not id- or code-shaped.
          logEvent({ evt: 'census', tenant: tenantId, status: 'failed', reason: errorCodeOf(error) });
          continue;
        }
        const out = (data ?? {}) as { rows?: unknown; unattributed?: unknown };
        rows += typeof out.rows === 'number' ? out.rows : 0;
        unattributed += typeof out.unattributed === 'number' ? out.unattributed : 0;
      }
      return { tenants: tenants.length, rows, failed, unattributed };
    },
    async tick() {
      await bestEffort('orphan_collection_failed', () => collectOrphans(db));
      // Before the flag gates and the registration lookup, like the collector: it ends stranded requests (G-02b J).
      await bestEffort('accept_expiry_failed', () => expireAccepts(db));
      if (!(await readsEnabled(db))) return { queued: 0 };
      const tenants = await tenantsWithActiveRegistration(db);
      if (tenants.length === 0) return { queued: 0 };
      await checkGroups(db, tenants, mirror);
      await bestEffort('group_removal_failed', () => withdrawGroupRemoved(db));
      const { data: sources, error: sourceError } = await db
        .from(TABLE.CONTENT_SOURCES)
        .select('id, tenant_id, last_error')
        .in('tenant_id', tenants)
        .eq('status', SOURCE_STATUS.ACTIVE);
      if (sourceError) throw new Error(`content source lookup failed (${errorCodeOf(sourceError)})`);
      let queued = 0;
      for (const source of (sources ?? []) as Array<{ id: string; tenant_id: string; last_error: string | null }>) {
        if (isHalted(source)) continue;
        const id = await boss.send(QUEUE.SYNC, { tenantId: source.tenant_id, sourceId: source.id }, { singletonKey: source.id });
        if (id) queued += 1;
      }
      return { queued };
    },

    async sync(data, meta = {}) {
      // The pass starts first, before any flag, registration or provider call (#370 RQ2). A start that cannot be
      // written throws here, and nothing is read.
      const pass = await beginPass(db, { tenantId: data.tenantId, sourceId: data.sourceId, jobId: meta.jobId ?? null }, worker);
      // The claim token of an accept is this attempt's pass id (serveAccepts), never the job id a retry keeps.
      return runPass(pass, () => attempt(data, pass, meta.signal));
    },

    async discover({ tenantId }) {
      const candidates = await discoverTenant(db, { tenantId, runId: randomUUID() });
      return { candidates: candidates.length };
    },
  };
}

/** Starts the consumer: queues, the tick schedule and the three workers. */
export async function startWorker(options: {
  db: SupabaseClient;
  connectionString: string;
  provider: ReaderMode;
  mirror?: ProviderAllowlistMirror;
  readerFor?: ReaderFactory;
  maxPages?: number;
  flagRecheckMs?: number;
  schedule?: boolean;
}): Promise<{ boss: PgBoss; handlers: WorkerHandlers; stop: () => Promise<void> }> {
  // Before the queue starts: a live worker without a mirror fails here, holding nothing.
  const mirror = mirrorFor(options.provider, options.db, options.mirror);
  const boss = createBoss(options.connectionString, { schedule: options.schedule });
  // A pg error can quote a value: the line carries a code, never the message (#344, design R12).
  boss.on('error', (error) => logEvent({ evt: 'queue_error', reason: failureReason(error) }));
  await boss.start();
  await ensureQueues(boss);
  const handlers = createWorkerHandlers({
    db: options.db,
    boss,
    provider: options.provider,
    mirror,
    readerFor: options.readerFor,
    maxPages: options.maxPages,
    flagRecheckMs: options.flagRecheckMs,
  });
  if (options.schedule !== false) await boss.schedule(QUEUE.TICK, TICK_CRON);
  if (options.schedule !== false) await boss.schedule(QUEUE.CENSUS, CENSUS_CRON);
  // One JSON line per job (A7), and a failed job leaves only its fixed code in pgboss.job.output (R13).
  // The sync handler gets pg-boss's job id: a retry keeps it, and gets a new reader pass (#370).
  await boss.work<Record<string, never>>(QUEUE.TICK, async () => runJob('tick', {}, () => handlers.tick()));
  await boss.work<Record<string, never>>(QUEUE.CENSUS, async () => runJob('census', {}, () => handlers.census()));
  await boss.work<SyncJobData>(QUEUE.SYNC, { batchSize: 1 }, async ([job]) =>
    runJob('sync', { tenant: job.data.tenantId, source: job.data.sourceId }, () =>
      handlers.sync(job.data, { jobId: job.id, signal: job.signal }),
    ),
  );
  await boss.work<DiscoverJobData>(QUEUE.DISCOVER, { batchSize: 1 }, async ([job]) =>
    runJob('discover', { tenant: job.data.tenantId }, () => handlers.discover(job.data)),
  );
  return { boss, handlers, stop: () => boss.stop({ graceful: true, timeout: 30_000 }) };
}

/** The fixed codes of an argument list that cannot run; printed alone, before anything is read. */
export const CLASSIFY_USAGE = {
  /** --recount is one pass over the sources; the service reads from each source's checkpoint and owns it. */
  RECOUNT_WITH_SERVE: 'recount_with_serve',
  /** Demo-only (#460): the service never holds the proposal step, and a propose run is one pass, like --recount. */
  PROPOSE_WITH_SERVE: 'propose_with_serve',
} as const;

/** The usage error of an argument list, as a fixed code, or null when it can run. */
export function usageError(argv: readonly string[]): string | null {
  if (argv.includes('--serve') && argv.includes('--recount')) return CLASSIFY_USAGE.RECOUNT_WITH_SERVE;
  if (argv.includes('--serve') && argv.includes('--propose')) return CLASSIFY_USAGE.PROPOSE_WITH_SERVE;
  return null;
}

/** Which read the Routing counts describe: the whole of every source read, or only what is new since its last pass. */
export const ROUTING_READ_LABEL = {
  FULL: 'full read',
  NEW_ONLY: 'new mail only since the last pass',
} as const;

/**
 * The line classify-once prints for one tenant: UUIDs, integers and fixed words only (#344, design R12). The Routing
 * part (#460) is the coverage answer: the items read, split by what routing decided, and how many codenames it found.
 */
export function summaryLine(summary: RunSummary): string {
  if (summary.status === 'skipped' && summary.reason === 'propose_refused') {
    return `Tenant ${summary.tenantId}: propose refused (${codeShaped(summary.code)}).`;
  }
  if (summary.status === 'skipped') return `Tenant ${summary.tenantId}: skipped (${summary.reason}).`;
  const created = summary.candidates.filter((c) => c.created).length;
  const r = summary.routing;
  const label = r.fullRead ? ROUTING_READ_LABEL.FULL : ROUTING_READ_LABEL.NEW_ONLY;
  return (
    `Tenant ${summary.tenantId}: read ${summary.itemsRead} items from ${summary.sources} sources, ` +
    `stored ${summary.itemsStored}, fetched ${summary.fetched}, excluded ${summary.excluded}, screened ${summary.screening.screened} (${summary.screening.flagged} flagged by the rules), ${summary.candidates.length} candidates (${created} new), ${summary.refused.length} refused, ${summary.skipped.length} skipped (no reader), allowlist ${summary.allowlist} (${summary.providers.map((p) => `${p.provider} ${p.allowlist}`).join(', ')}). ` +
    `Routing (${label}): of ${r.read} read, routed ${r.routed}, unrouted ${r.unrouted}, skipped ${r.skipped}, collisions ${r.collisions}; codenames ${r.codenames}. Scope-blocked routes ${r.scopeBlocked}. Run ${summary.runId}.` +
    (summary.proposed ? ` ${proposedLine(summary.proposed)}` : '')
  );
}

/** A lock's code as printed: a lowercase code, or `unexpected`, so nothing else can reach the line. */
const codeShaped = (code: string | undefined) => (code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unexpected');

/** G-01 (#173): the sources the step did not read and the ones a pass refusal stopped, as numbers. Absent counts print nothing. */
function sourcesPart(t: Pick<ProposedSummary, 'sourcesSkipped' | 'sourcesRefused'>): string {
  const skipped = t.sourcesSkipped === undefined ? '' : `, sources skipped ${t.sourcesSkipped}`;
  const refused = t.sourcesRefused === undefined ? '' : `, sources refused ${t.sourcesRefused}`;
  return skipped + refused;
}

/** Demo-only (#460): the propose run's counts and its cost (priced from tokens; a replay costs nothing). */
export function proposedLine(t: ProposedSummary): string {
  const stop =
    t.stoppedBy === 'zdr_unavailable'
      ? ' Stopped: the AI Gateway refused zero data retention, so AI is off; nothing after it was asked.'
      : t.stoppedBy === 'ledger'
        ? ' Stopped: an AI usage row could not be written; nothing after it was asked. The cost is recorded spend only: the attempt whose row was refused is not in it.'
        : t.stopped
          ? ` Stopped after ${MAX_CONSECUTIVE_FAILURES} failed calls in a row; nothing after them was asked.`
          : '';
  return (
    `Proposed: called ${t.called}, deal ${t.deal}, new names ${t.newNames}, not deal ${t.notDeal}, ` +
    `failed ${t.failed}, invalid ${t.invalid}, cost $${t.costUsd.toFixed(4)}` +
    sourcesPart(t) +
    '.' +
    stop
  );
}

/** The CLI's one pass over every tenant. `deps` lets a test hand in the client and the per-tenant run. */
export async function once(
  argv: string[],
  deps: { db?: SupabaseClient; runOnce?: (options: RunOnceOptions) => Promise<RunSummary> } = {},
): Promise<void> {
  const db = deps.db ?? serviceClientFromEnv();
  const run = deps.runOnce ?? runOnce;
  // A full re-read that moves no checkpoint (#460): the coverage count of a source something already read.
  const reread = argv.includes('--recount');
  // Demo-only (#460): --propose is a re-read that also runs the proposal step, configured from the environment.
  const propose: ProposeOptions | undefined = argv.includes('--propose') ? {} : undefined;
  const flag = argv.indexOf('--tenant');
  let tenants: string[];
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (!value) throw new Error('--tenant needs a tenant id');
    tenants = [value];
  } else {
    tenants = await tenantsWithActiveRegistration(db);
  }

  for (const tenantId of tenants) {
    const summary = await run({ tenantId, db, reread, propose });
    console.log(summaryLine(summary));
    // A ZDR refusal is key-wide: AI is off, so no other tenant is asked and the task exits 1, like extract (#462).
    // So is a ledger stop (#645): every tenant writes to the one ai_usage table, so the next would fail the same way.
    const stoppedBy = summary.status !== 'skipped' ? summary.proposed?.stoppedBy : undefined;
    if (stoppedBy === 'zdr_unavailable' || stoppedBy === 'ledger') {
      process.exitCode = 1;
      return;
    }
  }
  if (tenants.length === 0) console.log('No active reader registration. Nothing to classify.');
}

/**
 * The service's start from its environment. The queue URL is read once, by
 * createBoss, so it leaves process.env as soon as the boss is built (#344,
 * design R18). SUPABASE_SECRET_KEY stays: the guard builds its client from the
 * environment on every call (guard.ts).
 */
export async function startWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { schedule?: boolean } = {},
): ReturnType<typeof startWorker> {
  const worker = await startWorker({
    db: serviceClientFromEnv(env),
    connectionString: databaseUrlFromEnv(env),
    provider: readerModeFromEnv(env),
    schedule: options.schedule,
  });
  delete env.DISCOVERY_QUEUE_DATABASE_URL;
  return worker;
}

/** The fixed codes of an environment the service refuses to start in; printed alone, before any client is built. */
export const SERVE_REFUSAL = {
  /**
   * Demo-only (#460): the model gateway key belongs to the one-off classify-propose task alone
   * (infra/discovery-worker/ecs.tf). A service that holds it next to the mailbox credentials is a misconfigured deploy.
   */
  GATEWAY_KEY_PRESENT: 'gateway_key_present',
} as const;

/** Why the service must not start in this environment, as a fixed code, or null. Reads names only, never a value. */
export function serveRefusal(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.AI_GATEWAY_API_KEY !== undefined) return SERVE_REFUSAL.GATEWAY_KEY_PRESENT;
  return null;
}

async function serve(): Promise<void> {
  const refusal = serveRefusal();
  if (refusal) {
    // The code alone: fail loudly instead of quietly widening the reader's reach.
    logEvent({ evt: 'fatal', reason: refusal });
    process.exit(1);
  }
  const worker = await startWorkerFromEnv();
  console.log('Discovery classification worker started.');
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Discovery classification worker stopping (${signal}).`);
    worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1]?.endsWith('classify.ts') || process.argv[1]?.endsWith('classify.mjs')) {
  const argv = process.argv.slice(2);
  const usage = usageError(argv);
  if (usage) {
    // The code alone, never the arguments; nothing is built or read.
    logEvent({ evt: 'fatal', reason: usage });
    process.exit(2);
  } else {
    (argv.includes('--serve') ? serve() : once(argv)).catch((error) => {
      // A code, never the message: a thrown PostgREST or pg message can quote values (#344, design R12).
      logEvent({ evt: 'fatal', reason: failureReason(error) });
      process.exit(1);
    });
  }
}
