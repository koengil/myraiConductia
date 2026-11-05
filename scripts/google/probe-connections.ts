// First import, on purpose: it claims the reader capability before any other
// module loads (tests/mailbox-access/boot-claim.test.ts pins the order). P14 and
// P13 ask the guard, and the guard lives beside the readers. The Google
// primitives come through the operator door, never from a reader module.
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '../../src/lib/constants/tables';
import { REGISTRATION_STATUS } from '../../src/lib/constants/discovery';
import type { CallerTokenSource } from '../../src/lib/google/reader/credentials';
import type { GoogleRegistrationRow } from '../../src/lib/google/reader/registration';
import { createLiveAllowlistMirror, type ProviderAllowlistMirror } from '../../src/lib/mailboxAccess';
import { createSupabaseAdminClient } from '../../src/lib/supabase/server';
import { isProductionAppEnv } from '../../src/lib/appEnv';
import { assertWorkerSecretKeyShape } from '../../src/lib/supabase/secretKeyShape';
import { argValue, assertOutsideRepo, defaultProbeDir, requireLiveRun } from './lib/live';
import {
  domainOf,
  formatProbeLine,
  normalizeProbeAddress,
  normalizeProbeMessageId,
  PROBE_ERROR_CODE,
  ProbeCodeError,
  probeErrorLine,
  probeFailed,
  runProbe,
  type ProbeDeps,
  type ProbeRegistration,
} from './lib/probe';
import { buildProbeGuard, type ProbeGuard } from './lib/probeGuard';

const { GOOGLE_REGISTRATION_COLUMNS, createCallerTokenSource, createDirectoryTokenSource, googleRegistrationFromRow } =
  googleOperatorKit();

// The Google connection probe. The PASS list doubles as the bank's credential
// checklist. Prints ids, statuses and reason codes only, never mail content or
// an address; every failure prints one {"evt":"probe_error","reason":<code>} line.
//
// From the worker image (#344, design R15), the probe task family's fixed command:
//
//   probe --live --confirm-domain <domain> --tenant <tenant id> --allow-remote-db --out /tmp/probe
//
//   The registration is the google_reader_registrations row the worker reads. The
//   two test addresses come from PROBE_MAILBOX and PROBE_OUT_OF_SCOPE (SSM
//   parameters), never from the command line, which CloudTrail records. P14 is
//   mandatory: the guard admits the persona, with its owner and the group decision
//   bound, before any request that names it. P05 reads only the designated test
//   message PROBE_RAW_TEST_MESSAGE_ID names; the probe family injects none, so in
//   the task P05 is SKIPPED and no raw message is ever requested.
//
// From a laptop, against a trial domain:
//
//   npm run google:probe -- --live --confirm-domain <domain> \
//     --registration .secrets/google/registration.json --mailbox <persona@domain> \
//     [--guard-db] [--out-of-scope <registered out-of-scope test account>] \
//     [--drive-id <shared drive id> --drive-probe-sa <email>] [--out <dir outside the repo>]
//
//   Without --guard-db (or --out-of-scope, which implies it), P14 and P13 are
//   PENDING and nothing names the persona. The registration file may carry
//   rawTestMessageId, a test message seeded for P05; without it P05 is SKIPPED.
//   The guard is asked on the database the environment points at, which must be
//   a local Supabase (127.0.0.1 or localhost) unless --allow-remote-db is passed.
//   In production (NEXT_PUBLIC_APP_ENV prod or production, any case or spacing)
//   the guard is mandatory in both modes, and any run that asks it refuses a key
//   that is not an sb_secret_ key (secret_key_shape).
//
// Exits 1 when the probe refuses, or when a required check is not PASS: a FAIL, or
// an inconclusive PENDING, SKIPPED or UNAVAILABLE (only P09 and P12 UNAVAILABLE are
// allowed, lib/probe.ts INCONCLUSIVE_ALLOWED). Announce the run to the owner first.

type Env = Record<string, string | undefined>;

export type ProbeCliIo = { log: (line: string) => void };

export type ProbeCliDeps = {
  env?: Env;
  io?: ProbeCliIo;
  cwd?: string;
  /** The service client for the registration, the guard and the group read. Built from env by default. */
  db?: () => SupabaseClient;
  /** The allowlist group mirror. The worker's live mirror by default. */
  mirror?: () => ProviderAllowlistMirror;
  callerToken?: () => CallerTokenSource;
  directoryToken?: () => CallerTokenSource | null;
  fetchImpl?: typeof fetch;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

/** argValue, with a missing value as a fixed code (its message names the flag only, but no message is printed). */
function flag(argv: string[], name: string): string | null {
  try {
    return argValue(argv, name);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  }
}

/** An address inside the registered domain, or a fixed code. */
function addressIn(raw: string, domain: string): string {
  const address = normalizeProbeAddress(raw);
  if (domainOf(address) !== domain.toLowerCase()) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_OUT_OF_DOMAIN);
  return address;
}

/** In production, the key the guard is asked with must be a revocable sb_secret_ key, in either mode. */
function assertGuardKeyShape(env: Env): void {
  try {
    assertWorkerSecretKeyShape(env);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.SECRET_KEY_SHAPE);
  }
}

/**
 * The database the guard is asked on: local, or remote only with --allow-remote-db. Returns its
 * host. The key shape is checked first, so no guard database is ever asked with a legacy key.
 */
function guardDatabaseHost(argv: string[], env: Env): string {
  assertGuardKeyShape(env);
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url || !env.SUPABASE_SECRET_KEY?.trim()) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  }
  if (!LOCAL_HOSTS.includes(host) && !argv.includes('--allow-remote-db')) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_REMOTE_DB);
  return host;
}

function confirmLiveRun(argv: string[], domain: string): void {
  try {
    requireLiveRun(argv, domain);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_CONFIRM_DOMAIN);
  }
}

/** The tenant's active Google registration, read the way the worker's registry reads it. */
async function registrationForTenant(db: SupabaseClient, tenantId: string): Promise<ProbeRegistration> {
  let result: { data: unknown; error: unknown };
  try {
    result = await db
      .from(TABLE.GOOGLE_READER_REGISTRATIONS)
      .select(GOOGLE_REGISTRATION_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('status', REGISTRATION_STATUS.ACTIVE)
      .maybeSingle();
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_LOOKUP_FAILED);
  }
  if (result.error) throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_LOOKUP_FAILED);
  if (!result.data) throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_NOT_FOUND);
  const row = googleRegistrationFromRow(result.data as GoogleRegistrationRow);
  return {
    tenantId: row.tenantId,
    workspaceDomain: row.workspaceDomain,
    serviceAccountEmail: row.serviceAccountEmail,
    clientId: row.clientId,
    directoryServiceAccountEmail: row.directoryServiceAccountEmail,
    allowlistGroup: row.allowlistGroup,
  };
}

function registrationFromFile(path: string): ProbeRegistration & { rawTestMessageId: string | null } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_FILE_UNREADABLE);
  }
  const fields = ['tenantId', 'workspaceDomain', 'serviceAccountEmail', 'clientId', 'directoryServiceAccountEmail', 'allowlistGroup'] as const;
  if (!raw || fields.some((field) => typeof raw[field] !== 'string' || !(raw[field] as string).trim())) {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_FILE_UNREADABLE);
  }
  const value = (field: (typeof fields)[number]) => raw[field] as string;
  if (raw.rawTestMessageId !== undefined && typeof raw.rawTestMessageId !== 'string') {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MALFORMED_MESSAGE_ID);
  }
  return {
    rawTestMessageId: raw.rawTestMessageId ? normalizeProbeMessageId(raw.rawTestMessageId) : null,
    tenantId: value('tenantId'),
    workspaceDomain: value('workspaceDomain'),
    serviceAccountEmail: value('serviceAccountEmail'),
    clientId: value('clientId'),
    directoryServiceAccountEmail: value('directoryServiceAccountEmail'),
    allowlistGroup: value('allowlistGroup'),
  };
}

/** Runs the probe; returns the exit code. Every refusal prints one fixed-code line and nothing else. */
export async function probeMain(argv: string[], deps: ProbeCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.io?.log ?? ((line: string) => console.log(line));
  try {
    return await probe(argv, env, log, deps);
  } catch (error) {
    log(probeErrorLine(error));
    return 1;
  }
}

async function probe(argv: string[], env: Env, log: (line: string) => void, deps: ProbeCliDeps): Promise<number> {
  // Before anything is read: the live-run flag, then exactly one registration source.
  if (!argv.includes('--live')) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_LIVE_REQUIRED);
  const tenantId = flag(argv, '--tenant');
  const registrationPath = flag(argv, '--registration');
  if (tenantId && registrationPath) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_CONFLICT);
  if (!tenantId && !registrationPath) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  const cwd = deps.cwd ?? process.cwd();
  let outDir: string;
  try {
    outDir = assertOutsideRepo(flag(argv, '--out') ?? defaultProbeDir(), cwd);
  } catch (error) {
    if (error instanceof ProbeCodeError) throw error;
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_OUT_DIR);
  }
  let client: SupabaseClient | null = null;
  const db = (): SupabaseClient => (client ??= deps.db ? deps.db() : createSupabaseAdminClient());

  let registration: ProbeRegistration;
  let mailbox: string;
  let outOfScope: string | null;
  let rawTestMessageId: string | null;
  let guardHost: string | null;
  if (tenantId) {
    // --tenant: the worker image's mode. The key shape first, then the arguments, then the row.
    assertGuardKeyShape(env);
    if (!UUID.test(tenantId)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MALFORMED_TENANT);
    if (argv.includes('--mailbox') || argv.includes('--out-of-scope')) {
      throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_ON_ARGV_IN_TENANT_MODE);
    }
    const rawMailbox = env.PROBE_MAILBOX?.trim();
    if (!rawMailbox) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
    const rawOutOfScope = env.PROBE_OUT_OF_SCOPE?.trim() || null;
    // Shape first, so a malformed value is refused before any lookup.
    normalizeProbeAddress(rawMailbox);
    if (rawOutOfScope) normalizeProbeAddress(rawOutOfScope);
    const rawMessageId = env.PROBE_RAW_TEST_MESSAGE_ID?.trim() || null;
    rawTestMessageId = rawMessageId ? normalizeProbeMessageId(rawMessageId) : null;
    guardHost = guardDatabaseHost(argv, env);
    registration = await registrationForTenant(db(), tenantId);
    confirmLiveRun(argv, registration.workspaceDomain);
    mailbox = addressIn(rawMailbox, registration.workspaceDomain);
    outOfScope = rawOutOfScope ? addressIn(rawOutOfScope, registration.workspaceDomain) : null;
  } else {
    ({ rawTestMessageId, ...registration } = registrationFromFile(registrationPath as string));
    confirmLiveRun(argv, registration.workspaceDomain);
    const rawMailbox = flag(argv, '--mailbox');
    if (!rawMailbox) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
    mailbox = addressIn(rawMailbox, registration.workspaceDomain);
    const rawOutOfScope = flag(argv, '--out-of-scope');
    outOfScope = rawOutOfScope ? addressIn(rawOutOfScope, registration.workspaceDomain) : null;
    const wantsGuard = argv.includes('--guard-db') || outOfScope !== null;
    if (!wantsGuard && isProductionAppEnv(env)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_GUARD_REQUIRED);
    guardHost = wantsGuard ? guardDatabaseHost(argv, env) : null;
  }

  let guard: ProbeGuard | null = null;
  if (guardHost) {
    guard = buildProbeGuard(db(), registration.tenantId, deps.mirror ? deps.mirror() : createLiveAllowlistMirror());
    log(`Guard database: ${guardHost}`);
  }

  // The announce line names the tenant and the domain, never an address or a service account in --tenant mode.
  log(
    tenantId
      ? `LIVE Google run: google:probe against ${registration.workspaceDomain} for tenant ${registration.tenantId}`
      : `LIVE Google run: google:probe against ${registration.workspaceDomain} as ${registration.serviceAccountEmail}`,
  );
  const probeDeps: ProbeDeps = {
    env,
    callerToken: deps.callerToken ? deps.callerToken() : createCallerTokenSource(env),
    fetchImpl: deps.fetchImpl,
    registration,
    mailbox,
    rawTestMessageId: rawTestMessageId ?? undefined,
    secretsDir: resolve(cwd, '.secrets'),
    driveId: flag(argv, '--drive-id') ?? undefined,
    driveProbeServiceAccountEmail: flag(argv, '--drive-probe-sa') ?? undefined,
    outOfScope: outOfScope ? { address: outOfScope } : undefined,
    directoryToken: (deps.directoryToken ? deps.directoryToken() : createDirectoryTokenSource(env)) ?? undefined,
    onResult: (r) => log(formatProbeLine(r)),
  };
  if (guard) {
    probeDeps.guardFor = guard.guardFor;
    probeDeps.group = guard.group;
    probeDeps.registeredOutOfScope = guard.registeredOutOfScope;
  }
  const results = await runProbe(probeDeps);

  // The report holds ids, statuses and codes: never the persona or the out-of-scope address.
  let file: string;
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(
      file,
      JSON.stringify({ domain: registration.workspaceDomain, tenantId: registration.tenantId, results }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REPORT_WRITE_FAILED);
  }
  log(`Report: ${file}`);
  return probeFailed(results) ? 1 : 0;
}

if (process.argv[1]?.endsWith('probe-connections.ts') || process.argv[1]?.endsWith('probe.mjs')) {
  probeMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.log(probeErrorLine(error));
      process.exitCode = 1;
    },
  );
}
