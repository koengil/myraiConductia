// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). replayReaderFor builds its readers through it, and
// runOnce wraps each one in the mailbox guard.
import '../../src/lib/mailboxAccess/readers';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  READER_MODE,
  REGISTRATION_STATUS,
  SOURCE_STATUS,
  type RegistrationStatus,
  type SourceKind,
} from '../../src/lib/constants/discovery';
import { DEAL_ROLE } from '../../src/lib/constants/roles';
import { TABLE } from '../../src/lib/constants/tables';
import { createFixtureAllowlistMirror } from '../../src/lib/mailboxAccess/mirror';
import { runOnce, type RunSummary } from '../../worker/classify';
import { loadCassette, replayReaderFor, type Cassette } from './cassette/replayFetch';
import { assertSupabaseTarget } from './cassette/target';
import { normalizeMailboxDomains, resolveFirmCompany } from './write-registration';

// Replays a Graph cassette into one Conductia tenant and runs the full discovery pass twice:
// a backfill, then a delta. Offline: no certificate, no tenant, no network beyond Supabase.
//   npm run m365:replay-discovery -- --cassette <dir> --tenant <uuid> (--owners <file.json> | --no-owners)
//     --firm-company <id|name> --mailbox-domains <domain[,domain]> [--reset-replay-tenant]
//     [--activate-for-optin [--app-url <origin>] [--optin-timeout <seconds>]] [--allow-remote-supabase <host>]
// It loads no .env.local: that file names a hosted project. The operator maps the local stack's env
// explicitly (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY), and a non-loopback host is refused.
// The owners file is {"<address>": "<email>" | null, ...}, or the registration config the
// cassette was recorded with (its sources[].ownerEmail). Every cassette source must be named.
// The firm and the mail domains are what the mailbox allowlist joins on (#262): the replay registration names
// the tenant's bank company (by id or name) and the domains, exactly as write-registration does, because a
// registration that names neither reads nothing. The owners must be seated in that company with an accepted
// invite and their own opt-in; a source without them is refused by the guard and the run says how many.
// --activate-for-optin OPENS THE WINDOW ONLY (D68, owner decision). A person's opt-in is theirs alone, and it needs
// an active registration, which the replay one is not at rest. So the flag holds the replay registration active,
// lists the seeded owners who have not opted in, and waits while they do it themselves on /profile, with their own
// session. It reads their consent (read-only, service role) and never writes it, never opens a session for anyone,
// and never calls an opt-in function. The window closes (the registration is set back to disabled) when every owner
// has opted in, at --optin-timeout, on Enter (a terminal only), on Ctrl-C, and on failure. The replay pass runs only
// if at least one owner opted in. It runs on a loopback Supabase only, even with --allow-remote-supabase.

export const REPLAY_MS_TENANT_ID = 'replay';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (step: string, error: { message: string } | null) => {
  if (error) throw new Error(`replay-discovery: ${step} failed: ${error.message}`);
};

type CountQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>;

const keyOf = (kind: string, address: string) => `${kind}:${address.toLowerCase()}`;

type CountFilter = (query: CountQuery) => CountQuery;

async function countRows(db: SupabaseClient, table: string, filter: CountFilter): Promise<number> {
  const { count, error } = await filter(db.from(table).select('*', { count: 'exact', head: true }));
  fail(`${table} count`, error);
  return count ?? 0;
}

export async function seedReplayTenant(
  db: SupabaseClient,
  options: {
    tenantId: string;
    cassette: Cassette;
    owners: Map<string, string | null>;
    /** The tenant's bank company, by id or name: the firm the allowlist joins on. */
    firmCompany: string;
    /** The mail domains the replay registration reads. */
    mailboxDomains: string[];
    resetReplayTenant?: boolean;
  },
): Promise<void> {
  const { tenantId, cassette, owners } = options;
  // Before anything is written: a firm that is not the tenant's bank company, or no domain, reads nothing.
  const firmCompanyId = await resolveFirmCompany(db, tenantId, options.firmCompany);
  const domains = normalizeMailboxDomains(options.mailboxDomains);
  if (domains.errors.length > 0) throw new Error(`replay-discovery: ${domains.errors.join('; ')}`);

  // 1. A live tenant's tables are never mixed with replayed mail.
  const { data: existing, error: lookupError } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('ms_tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  fail('registration lookup', lookupError);
  if (existing && (existing as { ms_tenant_id: string }).ms_tenant_id !== REPLAY_MS_TENANT_ID) {
    throw new Error(`Tenant ${tenantId} has a live reader registration; replay writes only into a replay tenant`);
  }

  // 1b. The printed counts must come from the printed cassette alone: the tenant must hold no discovery
  // data. A reset is allowed only when the registration already reads 'replay' (checked above).
  const { data: ownRows, error: ownError } = await db.from(TABLE.CONTENT_SOURCES).select('id').eq('tenant_id', tenantId);
  fail('source lookup', ownError);
  const ownSourceIds = ((ownRows ?? []) as Array<{ id: string }>).map((row) => row.id);
  const held = async () =>
    (await countRows(db, TABLE.SOURCE_ITEMS, (q) => q.eq('tenant_id', tenantId))) +
    (await countRows(db, TABLE.DEAL_CANDIDATES, (q) => q.eq('tenant_id', tenantId))) +
    (ownSourceIds.length ? await countRows(db, TABLE.ROUTING_LEDGER, (q) => q.in('source_id', ownSourceIds)) : 0);
  if ((await held()) > 0) {
    if (!options.resetReplayTenant || !existing) {
      throw new Error(
        `Tenant ${tenantId} already holds discovery data; replay into a fresh --tenant, or pass --reset-replay-tenant`,
      );
    }
    // Links, texts and visibility cascade from candidates and items; ledger rows hang off the sources.
    const { error: candidateError } = await db.from(TABLE.DEAL_CANDIDATES).delete().eq('tenant_id', tenantId);
    fail('candidate reset', candidateError);
    const { error: itemError } = await db.from(TABLE.SOURCE_ITEMS).delete().eq('tenant_id', tenantId);
    fail('item reset', itemError);
    if (ownSourceIds.length) {
      const { error: ledgerError } = await db.from(TABLE.ROUTING_LEDGER).delete().in('source_id', ownSourceIds);
      fail('ledger reset', ledgerError);
    }
    // The message index too (#461): left behind, it would skip every message the replay reads again.
    const { error: indexError } = await db.from(TABLE.DISCOVERY_MESSAGE_INDEX).delete().eq('tenant_id', tenantId);
    fail('index reset', indexError);
  }

  // 2. Written DISABLED: the worker selects only 'active' registrations, so a replay tenant is never picked up by
  // one running with GRAPH_READER_PROVIDER=fixture. replayDiscovery activates it for the two runs only. The value
  // is not a GUID either, so a live worker that did find it would fail at readerMsalConfiguration.
  const { error: registrationError } = await db.from(TABLE.GRAPH_READER_REGISTRATIONS).upsert(
    {
      tenant_id: tenantId,
      ms_tenant_id: REPLAY_MS_TENANT_ID,
      client_id: 'replay',
      status: REGISTRATION_STATUS.DISABLED,
      firm_company_id: firmCompanyId,
      mailbox_domains: domains.domains,
    },
    { onConflict: 'tenant_id' },
  );
  fail('registration upsert', registrationError);

  // 3. Each cassette source, restarted from the backfill: a cassette holds exactly one delta round.
  const { data: rows, error: sourcesError } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, kind, address, status')
    .eq('tenant_id', tenantId);
  fail('source lookup', sourcesError);
  const stored = (rows ?? []) as Array<{ id: string; kind: SourceKind; address: string; status: string }>;
  const byKey = new Map(stored.map((row) => [keyOf(row.kind, row.address), row]));

  const wanted = new Set<string>();
  for (const source of cassette.manifest.sources) {
    wanted.add(keyOf(source.kind, source.address));
    const values = {
      owner_user_id: owners.get(source.address.toLowerCase()) ?? null,
      status: SOURCE_STATUS.ACTIVE,
      delta_checkpoint: null,
      backfill_completed_at: null,
    };
    const row = byKey.get(keyOf(source.kind, source.address));
    const { error } = row
      ? await db.from(TABLE.CONTENT_SOURCES).update(values).eq('id', row.id)
      : await db
          .from(TABLE.CONTENT_SOURCES)
          .insert({ tenant_id: tenantId, kind: source.kind, address: source.address, ...values });
    fail('source upsert', error);
  }

  // 4. runOnce never asks the cassette for a source it lacks.
  for (const row of stored) {
    if (wanted.has(keyOf(row.kind, row.address)) || row.status === SOURCE_STATUS.PAUSED) continue;
    const { error } = await db.from(TABLE.CONTENT_SOURCES).update({ status: SOURCE_STATUS.PAUSED }).eq('id', row.id);
    fail('source pause', error);
  }

  // 5. The owners opt in themselves later (--activate-for-optin), and the opt-in needs MD or deal team on a deal of
  // the tenant (#262 round 3, A2). Seat each seeded owner on one replay deal as deal_team. Idempotent; it writes no
  // consent and touches no source.
  await seatOwnersOnReplayDeal(db, tenantId, firmCompanyId, [...new Set([...owners.values()])].filter((id): id is string => id !== null));
}

/** One replay deal of the tenant, banked by the firm, with each owner a deal_team member. */
async function seatOwnersOnReplayDeal(db: SupabaseClient, tenantId: string, bankId: string, ownerIds: string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  const code = `REPLAY-${tenantId}`;
  const { data: existing, error: dealLookupError } = await db.from(TABLE.DEALS).select('id').eq('code', code).maybeSingle();
  fail('replay deal lookup', dealLookupError);
  let dealId = (existing as { id: string } | null)?.id ?? null;
  if (!dealId) {
    const inserted = await db
      .from(TABLE.DEALS)
      .insert({ tenant_id: tenantId, code, codename: 'Replay', bank_id: bankId })
      .select('id')
      .single();
    fail('replay deal insert', inserted.error);
    dealId = (inserted.data as { id: string }).id;
  }
  const { data: role, error: roleError } = await db.from(TABLE.ROLES).select('id').eq('slug', DEAL_ROLE.DEAL_TEAM).single();
  fail('role lookup', roleError);
  const { error } = await db.from(TABLE.DEAL_MEMBERSHIPS).upsert(
    ownerIds.map((userId) => ({
      deal_id: dealId,
      user_id: userId,
      role_id: (role as { id: string }).id,
      deal_role: DEAL_ROLE.DEAL_TEAM,
    })),
    { onConflict: 'deal_id,user_id', ignoreDuplicates: true },
  );
  fail('replay deal membership', error);
}

/** Flips a REPLAY registration's status; a registration that is not one is never touched. */
async function setReplayRegistrationStatus(
  db: SupabaseClient,
  tenantId: string,
  status: RegistrationStatus,
  /** When given, the request is abandoned after this long (an unanswered database cannot hold the window open). */
  timeoutMs?: number,
): Promise<void> {
  let query = db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .update({ status })
    .eq('tenant_id', tenantId)
    .eq('ms_tenant_id', REPLAY_MS_TENANT_ID);
  if (timeoutMs !== undefined) query = query.abortSignal(AbortSignal.timeout(timeoutMs));
  const { data, error } = await query.select('tenant_id');
  fail(`registration ${status}`, error);
  if (!data || data.length === 0) throw new Error(`Tenant ${tenantId} has no replay registration; seed it first`);
}

/** The bounds of the cleanup after a failed activation: how often it tries, how long each request may take, the pause between. */
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_REQUEST_MS = 10_000;
const CLEANUP_RETRY_MS = 250;

/**
 * Leaves the tenant's REPLAY registration not `active`, for when the activation reported an error: the update may
 * have committed before the response failed, so the error proves nothing about the state. A conditional disable
 * (`set status = 'disabled' where tenant_id = .. and ms_tenant_id = 'replay' and status = 'active'`, scoped as every
 * other write here is) matches nothing when the activation never landed, and is then no harm. Each attempt is
 * verified by reading the registration back; a failed or unverified attempt is retried, a bounded number of times.
 * Resolves whether the registration is verified not active; it never throws, so the error that came first is the
 * one the caller reports.
 */
async function disableAfterFailedActivation(db: SupabaseClient, tenantId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await new Promise<void>((resolveWait) => setTimeout(resolveWait, CLEANUP_RETRY_MS));
    try {
      const { error } = await db
        .from(TABLE.GRAPH_READER_REGISTRATIONS)
        .update({ status: REGISTRATION_STATUS.DISABLED })
        .eq('tenant_id', tenantId)
        .eq('ms_tenant_id', REPLAY_MS_TENANT_ID)
        .eq('status', REGISTRATION_STATUS.ACTIVE)
        .abortSignal(AbortSignal.timeout(CLEANUP_REQUEST_MS))
        .select('tenant_id');
      if (error) continue;
      const { data, error: readError } = await db
        .from(TABLE.GRAPH_READER_REGISTRATIONS)
        .select('status')
        .eq('tenant_id', tenantId)
        .eq('ms_tenant_id', REPLAY_MS_TENANT_ID)
        .abortSignal(AbortSignal.timeout(CLEANUP_REQUEST_MS))
        .maybeSingle();
      // No replay row at all is as good as disabled: nothing a worker could select.
      if (!readError && (data as { status: string } | null)?.status !== REGISTRATION_STATUS.ACTIVE) return true;
    } catch {
      // The next attempt, or the report below.
    }
  }
  return false;
}

/** Where the signal handlers go: `process` in the script, an EventEmitter in a test. */
export type SignalSource = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/** The exit code a shell reports for a process ended by the signal: 128 + its number. */
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof SIGNAL_EXIT_CODE;

/**
 * Holds the tenant's replay registration `active` for the length of `work`, then sets it back to `disabled`,
 * on failure too, so no worker that shares the database ever selects it. The pause must not hide the failure
 * that came first, and must not be skipped because of it.
 *
 * While it is active, SIGINT and SIGTERM set it back to `disabled` and then exit (130 and 143): the default
 * action would end the process with the registration still selectable. The handlers are removed on the way out.
 * `hooks.onSignal` replaces that: the signal is handed to the caller, which ends its own work and returns, and the
 * registration is disabled on the normal way out (the opt-in window uses it, so Ctrl-C closes the window and the
 * process is never killed mid-state). The process is not exited by the handler then.
 * An activation that reports an error is not taken to mean the registration is still disabled (the update can commit
 * and the response fail): disableAfterFailedActivation sets it back, verified, and the activation's own error is the
 * one thrown.
 * `hooks.requestTimeoutMs` bounds the activation and the final disable: a request unanswered that long is abandoned.
 * SIGKILL and a crash before this returns cannot be handled: scripts/m365/README.md gives the fix-up.
 */
export async function withActiveReplayRegistration<T>(
  db: SupabaseClient,
  tenantId: string,
  work: () => Promise<T>,
  hooks: {
    signals?: SignalSource;
    exit?: (code: number) => void;
    onSignal?: (signal: 'SIGINT' | 'SIGTERM') => void;
    requestTimeoutMs?: number;
  } = {},
): Promise<T> {
  const signals = hooks.signals ?? process;
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  let activation: Promise<void> = Promise.resolve();
  let interrupted = false;
  const onSignal = (signal: HandledSignal) => {
    if (hooks.onSignal) return hooks.onSignal(signal);
    if (interrupted) return; // a second signal while the first is disabling changes nothing
    interrupted = true;
    // A signal that lands while the activation is in flight must disable AFTER it, or the tenant stays active.
    activation
      .catch(() => undefined)
      .then(() => setReplayRegistrationStatus(db, tenantId, REGISTRATION_STATUS.DISABLED))
      .then(
        () => console.error(`replay interrupted by ${signal}: the replay registration is disabled`),
        () =>
          console.error(
            `replay interrupted by ${signal}, and the registration could not be set to disabled: run the fix-up in scripts/m365/README.md`,
          ),
      )
      .finally(() => exit(SIGNAL_EXIT_CODE[signal]));
  };
  const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
  // Installed before the registration is touched, so there is no moment it is active without them.
  signals.on('SIGINT', handlers.SIGINT);
  signals.on('SIGTERM', handlers.SIGTERM);

  try {
    activation = setReplayRegistrationStatus(db, tenantId, REGISTRATION_STATUS.ACTIVE, hooks.requestTimeoutMs);
    try {
      await activation;
    } catch (activationError) {
      if (!(await disableAfterFailedActivation(db, tenantId))) {
        console.error(
          'the replay registration could not be verified disabled after a failed activation: run the fix-up in scripts/m365/README.md',
        );
      }
      throw activationError;
    }
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await work() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let pauseError: unknown = null;
    try {
      await setReplayRegistrationStatus(db, tenantId, REGISTRATION_STATUS.DISABLED, hooks.requestTimeoutMs);
    } catch (error) {
      pauseError = error;
    }
    if (!outcome.ok) throw outcome.error;
    if (pauseError) throw pauseError;
    return outcome.value;
  } finally {
    signals.off('SIGINT', handlers.SIGINT);
    signals.off('SIGTERM', handlers.SIGTERM);
  }
}

/** Where the Enter key comes from: a terminal's stdin in the script, an EventEmitter in a test. */
export type LineSource = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  off(event: 'data', listener: (chunk: unknown) => void): unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

/** How the opt-in window ended. */
export type OptinEnd = 'all_consented' | 'none_pending' | 'timeout' | 'enter' | 'signal';
/** One owner, numbered in the order the owners appear. `address` is the seated invitation's mailbox; null when there is none. */
export type OwnerOptin = { label: number; userId: string; address: string | null; consented: boolean };
export type OptinWindowResult = { endedBy: OptinEnd; owners: OwnerOptin[] };

const DEFAULT_APP_URL = 'http://localhost:3000';
const DEFAULT_OPTIN_TIMEOUT_SECONDS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_OPTIN_TIMEOUT_SECONDS = 86_400;

/** The page an owner opts in on: the app's /profile, from the origin of --app-url. No request is made to it. */
export function optinProfileUrl(appUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error(`--app-url must be an http(s) URL, for example ${DEFAULT_APP_URL}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--app-url must be an http(s) URL, for example ${DEFAULT_APP_URL}`);
  }
  return `${parsed.origin}/profile`;
}

/** --optin-timeout is whole seconds (default 600, at most a day). */
export function parseOptinTimeoutSeconds(value: string | null): number {
  if (value === null) return DEFAULT_OPTIN_TIMEOUT_SECONDS;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_OPTIN_TIMEOUT_SECONDS) {
    throw new Error(`--optin-timeout must be a whole number of seconds from 1 to ${MAX_OPTIN_TIMEOUT_SECONDS}`);
  }
  return seconds;
}

/**
 * Each owner's seated invitation and whether it holds an open consent. A READ: two selects with the service role,
 * on the seated-invites view and the consent rows, and nothing else. The view lists a seat only while a registration
 * naming the firm is active, so this is meaningful inside the window and empty outside it.
 */
export async function readOwnerConsents(
  db: SupabaseClient,
  tenantId: string,
  ownerIds: string[],
  /** Abandons both reads when it aborts (the deadline, a signal, a request that takes too long). */
  signal?: AbortSignal,
): Promise<Array<{ userId: string; address: string | null; consented: boolean }>> {
  let seatQuery = db
    .from(TABLE.MAILBOX_SEATED_INVITES)
    .select('address, user_id, invite_id')
    .eq('tenant_id', tenantId)
    .in('user_id', ownerIds);
  if (signal) seatQuery = seatQuery.abortSignal(signal);
  const { data: seats, error: seatError } = await seatQuery;
  fail('seated invite read', seatError);
  const seated = (seats ?? []) as Array<{ address: string; user_id: string; invite_id: string }>;

  const open = new Set<string>();
  if (seated.length > 0) {
    let consentQuery = db
      .from(TABLE.MAILBOX_CONSENTS)
      .select('invite_id')
      .eq('tenant_id', tenantId)
      .in('invite_id', seated.map((seat) => seat.invite_id))
      .is('withdrawn_at', null);
    if (signal) consentQuery = consentQuery.abortSignal(signal);
    const { data: consents, error: consentError } = await consentQuery;
    fail('consent read', consentError);
    for (const row of (consents ?? []) as Array<{ invite_id: string }>) open.add(row.invite_id);
  }
  return ownerIds.map((userId) => {
    const seat = seated.find((candidate) => candidate.user_id === userId);
    return { userId, address: seat?.address ?? null, consented: seat ? open.has(seat.invite_id) : false };
  });
}

/**
 * --activate-for-optin: OPENS THE WINDOW ONLY (D68, owner decision). The replay registration is `disabled` at rest and
 * an opt-in needs an active one, so this holds it active (withActiveReplayRegistration, the path the replay pass uses;
 * a registration whose ms_tenant_id is 'replay' and no other), tells the operator which seeded owners have no open
 * consent and where each opts in, and waits while THEY opt in on /profile. It never opens a session for anyone and
 * never writes a consent: the wait is a read-only poll.
 *
 * It ends when every seated owner has opted in, at `timeoutMs`, on Enter (only if `stdin` is given: a line, not the
 * end of input), or on SIGINT/SIGTERM, which end the wait and do not exit the process. The registration is set back to
 * `disabled` on all of these and on failure. Resolves null, touching nothing, when no source has an owner. An owner
 * with no seated invitation cannot opt in; it is reported and not waited for.
 *
 * The wait is bounded in time, not only by the loop: the deadline is fixed before the first poll, and every request
 * the window makes (the activation, each poll, the final disable) is abandoned after `requestTimeoutMs`. The deadline,
 * Enter and a signal abort a poll that is in flight, so a database that stops answering cannot hold the registration
 * active past them: the wait ends and the registration is disabled. A poll that merely takes longer than
 * `requestTimeoutMs` is a failure, which closes the window and is reported.
 */
export async function openOptinWindow(
  db: SupabaseClient,
  tenantId: string,
  owners: Map<string, string | null>,
  options: {
    timeoutMs: number;
    appUrl: string;
    pollMs?: number;
    /** The longest any one request may take (default 10 seconds). */
    requestTimeoutMs?: number;
    stdin?: LineSource | null;
    log?: (line: string) => void;
    signals?: SignalSource;
  },
): Promise<OptinWindowResult | null> {
  const ownerIds = [...new Set([...owners.values()].filter((id): id is string => id !== null))];
  if (ownerIds.length === 0) return null;
  const profileUrl = optinProfileUrl(options.appUrl); // before the registration is touched
  const log = options.log ?? ((line: string) => console.log(line));
  const pollMs = options.pollMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stdin = options.stdin ?? null;
  const labels = new Map(ownerIds.map((id, index) => [id, index + 1]));

  // Aborted when the wait ends for any reason but consent, so a poll in flight does not outlive it.
  const inFlight = new AbortController();
  const state: { ended: OptinEnd | null; wake: (() => void) | null } = { ended: null, wake: null };
  const end = (reason: OptinEnd) => {
    state.ended ??= reason;
    inFlight.abort();
    state.wake?.();
  };
  const onData = (chunk: unknown) => {
    if (String(chunk).includes('\n')) end('enter');
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolveSleep) => {
      const done = () => {
        clearTimeout(timer);
        state.wake = null;
        resolveSleep();
      };
      const timer = setTimeout(done, ms);
      state.wake = done;
    });
  const poll = async (): Promise<OwnerOptin[]> =>
    (await readOwnerConsents(db, tenantId, ownerIds, AbortSignal.any([inFlight.signal, AbortSignal.timeout(requestTimeoutMs)]))).map(
      (status) => ({ label: labels.get(status.userId)!, ...status }),
    );

  return withActiveReplayRegistration(
    db,
    tenantId,
    async () => {
      // Fixed before the first poll, and enforced by a timer, not by the loop: a poll that never answers is
      // aborted when it fires.
      const deadline = Date.now() + options.timeoutMs;
      const deadlineTimer = setTimeout(() => end('timeout'), options.timeoutMs);
      stdin?.on('data', onData);
      stdin?.resume?.();
      let current: OwnerOptin[] = ownerIds.map((userId) => ({ label: labels.get(userId)!, userId, address: null, consented: false }));
      // An aborted poll is the wait ending, not a failure; any other error is still reported.
      const pollOrEnd = async (): Promise<OwnerOptin[] | null> => {
        try {
          return await poll();
        } catch (error) {
          if (state.ended) return null;
          throw error;
        }
      };
      try {
        const first = await pollOrEnd();
        if (first === null) return { endedBy: state.ended!, owners: current };
        current = first;
        const waiting = () => current.filter((owner) => owner.address !== null && !owner.consented);

        log('opt-in window open: the replay registration is active, and each owner opts in themselves.');
        for (const owner of current) {
          if (owner.address === null) {
            log(`  owner ${owner.label}: no seated invitation, so this owner cannot opt in (not waited for)`);
          } else if (!owner.consented) {
            log(`  owner ${owner.label}: ${owner.address} opens ${profileUrl} and selects Connect my mailbox`);
          }
        }
        if (waiting().length === 0) return { endedBy: 'none_pending', owners: current };
        log(
          `Waiting for ${waiting().length} owner(s), up to ${Math.round(options.timeoutMs / 1000)}s. ` +
            `${stdin ? 'Press Enter to stop waiting, or Ctrl-C.' : 'Ctrl-C stops waiting.'}`,
        );

        for (;;) {
          if (waiting().length === 0) return { endedBy: 'all_consented', owners: current };
          if (state.ended) return { endedBy: state.ended, owners: current };
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { endedBy: 'timeout', owners: current };
          await sleep(Math.min(pollMs, remaining));
          const previous = current;
          const next = await pollOrEnd();
          if (next === null) return { endedBy: state.ended!, owners: previous };
          current = next;
          for (const owner of current) {
            if (owner.consented && !previous.find((before) => before.userId === owner.userId)?.consented) {
              log(`  owner ${owner.label}: opted in`);
            }
          }
        }
      } finally {
        clearTimeout(deadlineTimer);
        stdin?.off('data', onData);
        stdin?.pause?.();
      }
    },
    { signals: options.signals, onSignal: () => end('signal'), requestTimeoutMs },
  );
}

/**
 * The window runs on a local stack only: it is the operator's rehearsal of the opt-in, and this flag never reaches an
 * environment that holds real people, whatever --allow-remote-supabase says.
 */
export function assertOptinTarget(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not a URL');
  }
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return;
  throw new Error(
    `Refusing --activate-for-optin against ${host}: it opens the replay registration for the owners' opt-in, so it runs on a local Supabase only (the owners opt in themselves elsewhere)`,
  );
}

/** What the owners' opt-in and the replay passes came to, per owner: counts only, never an address, subject or text. */
export type OwnerResult = { label: number; consented: boolean; read: number; refused: number };

/**
 * Per owner: whether they opted in, how many items their sources' ledger holds (read) and how many times the guard
 * refused one of their sources across the given runs. Owners are numbered as in the window.
 */
export async function ownerReplayResults(
  db: SupabaseClient,
  tenantId: string,
  owners: OwnerOptin[],
  runs: Array<{ refused: Array<{ sourceId: string }> }>,
): Promise<OwnerResult[]> {
  const { data, error } = await db.from(TABLE.CONTENT_SOURCES).select('id, owner_user_id').eq('tenant_id', tenantId);
  fail('source read', error);
  const sources = (data ?? []) as Array<{ id: string; owner_user_id: string | null }>;
  const results: OwnerResult[] = [];
  for (const owner of owners) {
    const ids = sources.filter((source) => source.owner_user_id === owner.userId).map((source) => source.id);
    const read = ids.length ? await countRows(db, TABLE.ROUTING_LEDGER, (q) => q.in('source_id', ids)) : 0;
    const refused = runs.reduce((sum, run) => sum + run.refused.filter((r) => ids.includes(r.sourceId)).length, 0);
    results.push({ label: owner.label, consented: owner.consented, read, refused });
  }
  return results;
}

const OPTIN_END_TEXT: Record<OptinEnd, string> = {
  all_consented: 'every owner opted in',
  none_pending: 'no owner to wait for',
  timeout: 'timed out',
  enter: 'stopped with Enter',
  signal: 'interrupted',
};

/**
 * Runs the discovery pass twice over the cassette. The replay registration is active only while it runs
 * (runOnce needs an active one): withActiveReplayRegistration sets it to 'disabled' afterwards, on failure and
 * on SIGINT/SIGTERM too.
 */
export async function replayDiscovery(
  db: SupabaseClient,
  options: { tenantId: string; cassette: Cassette; signals?: SignalSource; exit?: (code: number) => void },
): Promise<{
  first: Extract<RunSummary, { status: 'ok' }>;
  second: Extract<RunSummary, { status: 'ok' }>;
}> {
  const readerFor = replayReaderFor(options.cassette);
  // provider is required by runOnce even with readerFor (worker/classify.ts:162); readerFor wins. The pass asks
  // for a provider group mirror in any mode but the fixture one; a replay has no provider, so its group is the
  // allowlist itself (the fixture mirror, refused in production, where replay is refused too).
  const run = () =>
    runOnce({ tenantId: options.tenantId, db, provider: READER_MODE.GRAPH, readerFor, mirror: createFixtureAllowlistMirror(db) });

  return withActiveReplayRegistration(
    db,
    options.tenantId,
    async () => {
      const first = await run();
      const second = await run();
      if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Replay skipped: no active registration');
      return { first, second };
    },
    { signals: options.signals, exit: options.exit },
  );
}

/** Row counts for the tenant: ids and totals only, never a subject, address or text. */
export async function replayCounts(
  db: SupabaseClient,
  tenantId: string,
): Promise<{
  sources: number;
  ledger: { routed: number; unrouted: number; skipped: number };
  items: number;
  candidates: number;
  links: number;
}> {
  const count = (table: string, filter: CountFilter) => countRows(db, table, filter);

  const { data: sourceRows, error: sourceError } = await db.from(TABLE.CONTENT_SOURCES).select('id').eq('tenant_id', tenantId);
  fail('source read', sourceError);
  const sourceIds = ((sourceRows ?? []) as Array<{ id: string }>).map((row) => row.id);
  const { data: candidateRows, error: candidateError } = await db
    .from(TABLE.DEAL_CANDIDATES)
    .select('id')
    .eq('tenant_id', tenantId);
  fail('candidate read', candidateError);
  const candidateIds = ((candidateRows ?? []) as Array<{ id: string }>).map((row) => row.id);

  const ledger = async (decision: string) =>
    sourceIds.length
      ? count(TABLE.ROUTING_LEDGER, (q) => q.in('source_id', sourceIds).eq('decision', decision))
      : 0;

  return {
    sources: sourceIds.length,
    ledger: { routed: await ledger('routed'), unrouted: await ledger('unrouted'), skipped: await ledger('skipped') },
    items: await count(TABLE.SOURCE_ITEMS, (q) => q.eq('tenant_id', tenantId)),
    candidates: candidateIds.length,
    links: candidateIds.length ? await count(TABLE.EVIDENCE_LINKS, (q) => q.in('candidate_id', candidateIds)) : 0,
  };
}

/**
 * Reads the owners file: a plain {address: email|null} map, or a registration config whose
 * sources[] carry ownerEmail. Every cassette source must be named. Returns address (lower-cased) → email.
 */
export function readOwners(path: string, cassette: Cassette): Map<string, string | null> {
  const text = readFileSync(resolve(path), 'utf8');
  if (text.includes('-----BEGIN')) throw new Error('The owners file holds key material. It must only name owners.');
  const raw = JSON.parse(text) as Record<string, unknown>;

  const owners = new Map<string, string | null>();
  if (Array.isArray(raw.sources)) {
    for (const entry of raw.sources as Array<{ address?: unknown; ownerEmail?: unknown }>) {
      if (typeof entry?.address === 'string') {
        owners.set(entry.address.toLowerCase(), typeof entry.ownerEmail === 'string' ? entry.ownerEmail.trim().toLowerCase() : null);
      }
    }
  } else {
    for (const [address, email] of Object.entries(raw)) {
      owners.set(address.toLowerCase(), typeof email === 'string' ? email.trim().toLowerCase() : null);
    }
  }

  const missing = cassette.manifest.sources.filter((s) => !owners.has(s.address.toLowerCase()));
  if (missing.length > 0) {
    // Counted, not listed: an address is the tenant's data.
    throw new Error(`The owners file does not name ${missing.length} of the cassette's ${cassette.manifest.sources.length} sources`);
  }
  return owners;
}

/** Each owner email must be an internal user of the tenant. Returns email → user id. */
export async function resolveOwnerIds(
  db: SupabaseClient,
  tenantId: string,
  owners: Map<string, string | null>,
): Promise<Map<string, string>> {
  const emails = [...new Set([...owners.values()].filter((e): e is string => e !== null))];
  const ids = new Map<string, string>();
  if (emails.length === 0) return ids;
  const { data, error } = await db.from(TABLE.USERS).select('id, email, tenant_id, is_external').in('email', emails);
  fail('owner lookup', error);
  for (const row of (data ?? []) as Array<{ id: string; email: string; tenant_id: string; is_external: boolean }>) {
    if (row.tenant_id === tenantId && !row.is_external) ids.set(row.email.toLowerCase(), row.id);
  }
  const missing = emails.filter((email) => !ids.has(email));
  if (missing.length > 0) throw new Error(`No internal user in tenant ${tenantId} for ${missing.length} owner email(s)`);
  return ids;
}

function argValue(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

async function main(argv: string[]): Promise<void> {
  // Before anything else: replay never touches prod.
  if (process.env.NEXT_PUBLIC_APP_ENV === 'prod') throw new Error('Refusing to replay a cassette into prod');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set explicitly (no .env.local is loaded; ' +
        'map the local stack: NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY")',
    );
  }
  assertSupabaseTarget(url, argValue(argv, '--allow-remote-supabase')); // before createClient (loopback, or https and the named host)
  const activateForOptinFlag = argv.includes('--activate-for-optin');
  if (activateForOptinFlag) assertOptinTarget(url); // loopback only, before createClient, whatever --allow-remote-supabase says

  const usage =
    'Usage: replay-discovery.ts --cassette <dir> --tenant <uuid> (--owners <file.json> | --no-owners) --firm-company <id|name> --mailbox-domains <domain[,domain]> [--reset-replay-tenant] [--activate-for-optin [--app-url <origin>] [--optin-timeout <seconds>]] [--allow-remote-supabase <host>]';
  const cassettePath = argValue(argv, '--cassette');
  const tenantId = argValue(argv, '--tenant');
  const ownersPath = argValue(argv, '--owners');
  const noOwners = argv.includes('--no-owners');
  const firmCompany = argValue(argv, '--firm-company');
  const domainList = argValue(argv, '--mailbox-domains');
  if (!cassettePath || !tenantId || (!ownersPath && !noOwners) || (ownersPath && noOwners) || !firmCompany || !domainList) {
    throw new Error(usage);
  }
  if (!UUID.test(tenantId)) throw new Error('--tenant must be a uuid');
  if (activateForOptinFlag && noOwners) throw new Error('--activate-for-optin needs --owners: with --no-owners there is nobody to opt in');
  const appUrl = argValue(argv, '--app-url');
  const timeoutArg = argValue(argv, '--optin-timeout');
  if (!activateForOptinFlag && (appUrl !== null || timeoutArg !== null)) {
    throw new Error('--app-url and --optin-timeout belong to --activate-for-optin');
  }
  // Both are checked before anything is written.
  const optinProfile = activateForOptinFlag ? optinProfileUrl(appUrl ?? DEFAULT_APP_URL) : null;
  const optinTimeoutSeconds = parseOptinTimeoutSeconds(timeoutArg);

  const cassette = loadCassette(resolve(cassettePath));
  console.log(`cassette sha256:${cassette.digestSha256}`);
  if (cassette.manifest.readerCommit && /^[0-9a-f]{40}$/.test(cassette.manifest.readerCommit)) {
    console.log(`recorded with reader ${cassette.manifest.readerCommit}`);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const byAddress = ownersPath
    ? readOwners(ownersPath, cassette)
    : new Map(cassette.manifest.sources.map((s) => [s.address.toLowerCase(), null as string | null]));
  const ids = await resolveOwnerIds(db, tenantId, byAddress);
  const owners = new Map([...byAddress].map(([address, email]) => [address, email ? ids.get(email)! : null]));

  await seedReplayTenant(db, {
    tenantId,
    cassette,
    owners,
    firmCompany,
    mailboxDomains: domainList.split(',').map((domain) => domain.trim()),
    resetReplayTenant: argv.includes('--reset-replay-tenant'),
  });
  // The seeded registration is `disabled`. With the flag it is active for the owners' own opt-in and disabled again
  // before anything is read; the pass runs only if at least one owner opted in.
  let window: OptinWindowResult | null = null;
  if (optinProfile !== null) {
    window = await openOptinWindow(db, tenantId, owners, {
      timeoutMs: optinTimeoutSeconds * 1000,
      appUrl: appUrl ?? DEFAULT_APP_URL,
      stdin: process.stdin.isTTY ? process.stdin : null,
    });
    if (!window) throw new Error('replay-discovery: --activate-for-optin has no owner to wait for: every source has a null owner');
    console.log(`opt-in window closed (${OPTIN_END_TEXT[window.endedBy]}): the replay registration is disabled again`);
    if (!window.owners.some((owner) => owner.consented)) {
      throw new Error('replay-discovery: no owner opted in; the replay pass was not run');
    }
  }
  const { first, second } = await replayDiscovery(db, { tenantId, cassette });
  const counts = await replayCounts(db, tenantId);

  const line = (n: number, run: typeof first) => {
    const created = run.candidates.filter((c) => c.created).length;
    console.log(
      `run ${n}: read ${run.itemsRead}, stored ${run.itemsStored}, candidates ${run.candidates.length} (${created} new), ` +
        `refused ${run.refused.length}`,
    );
  };
  line(1, first);
  line(2, second);
  console.log(JSON.stringify(counts));
  if (window) {
    for (const result of await ownerReplayResults(db, tenantId, window.owners, [first, second])) {
      console.log(
        `owner ${result.label}: ${result.consented ? 'consented' : 'did not opt in'}, read ${result.read}, refused ${result.refused}`,
      );
    }
  }
}

if (process.argv[1]?.endsWith('replay-discovery.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
