// First import, on purpose: record.ts reaches the reader through src/lib/mailboxAccess/readers.ts, which claims
// the reader capability when it loads (tests/mailbox-access/boot-claim.test.ts pins the order).
import { createGuardedRecording, createLiveAllowlistMirror } from '../../src/lib/mailboxAccess/readers';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isProductionAppEnv } from '../../src/lib/appEnv';
import { REGISTRATION_STATUS } from '../../src/lib/constants/discovery';
import { TABLE } from '../../src/lib/constants/tables';
import { GraphHttpError } from '../../src/lib/graph/http';
import type { ReaderTokenCache } from '../../src/lib/graph/reader/token';
import type { ProviderAllowlistMirror } from '../../src/lib/mailboxAccess/mirror';
import { getSupabaseAdminCredentials } from '../../src/lib/supabase/config';
import { createSupabaseAdminClient } from '../../src/lib/supabase/server';
import { saveCassette, type CassetteData } from './cassette/format';
import { CassetteLintError } from './cassette/lint';
import { captureReady, skippedLines } from './cassette/liveCapture';
import { assertOutsideRepo, gitIn, repoRoots } from './cassette/outsideRepo';
import { RECORD_EXTRACT, recordSources } from './cassette/record';
import { createRecorder } from './cassette/recordFetch';
import { assessReadiness, readinessLines, type Readiness } from './cassette/readiness';
import { RecorderRefusal } from './cassette/refusal';
import { scrub, ScrubDivergenceError } from './cassette/scrub';
import { assertSupabaseTarget } from './cassette/target';
import { normalizeMailboxDomains, parseRegistrationConfig } from './write-registration';

// Records the Graph traffic of a full read of every source in a registration config, for offline replay
// (CDT-277). Runs on the machine that can reach Graph, with the owner at the keyboard. No database.
//   npm run m365:record-graph -- --config <registration.json> --out <new dir outside the repo> [--allow-env-pem]
//
// --live (#318) is the guarded live mode: the registration and sources come from the database the mailbox guard
// asks, not from a config, and the run is bound to one tenant before any Graph call (assertLiveGates).
//   npm run m365:record-graph -- --live --tenant <uuid> --ms-tenant-id <guid> --confirm-domains <d[,d]>
//     --out <new dir outside the repo> --allow-env-pem [--allow-remote-supabase <host>] [--preflight]
// --preflight (#318 4/6) runs the gates and the readiness check the capture uses (cassette/readiness.ts), prints
// counts, and stops: no mail is read and no file is written. The provider group is read, and drift and any guard
// refusal are recorded in the database, as for any read.
// Without --preflight the capture (#318 5/6) reads exactly the sources the readiness check marks ready, through a
// guarded recording session (createGuardedRecording: the worker's own guarded read, with its responses shown to the
// recorder's observer), then runs the unchanged scrub, lint and seal. A source the guard refuses before it has
// recorded anything is skipped and counted; one refused after is an abort, and so is anything else that goes wrong.
// A blocked run, or one that recorded no source, refuses. A mailbox is recorded under the UPN it is read by, which
// is the address the manifest names and replay asks for.
//
// Record BEFORE rotating the certificate into Key Vault: the Key Vault signer needs a managed identity, which
// a laptop lacks, so a laptop records with the current env: PEM (--allow-env-pem). See scripts/m365/README.md,
// "Record and replay".
//
// What it prints: counts, the cassette id, the reader commit and the NAMES of the dropped response headers.
// Never an address, a subject, a token or a config value. A cassette that fails its credential check is not
// written; the refusal names the rule and the location only. A failure prints a fixed, value-free line
// (describeFailure): never the exception's own text, which can carry a request id or an address.
//
// The checkout is the one that holds THIS script, found from the script's own location: the working directory
// never decides which repository is checked, or whether the reader is clean.

export type RecordGraphDeps = {
  fetchImpl?: typeof fetch; // the injected path's transport to record: the fake tenant (a --live run reads through the guard)
  tokenCache?: ReaderTokenCache; // a static token, no MSAL (required with fetchImpl)
  now?: () => Date;
  repoRoots?: string[];
  /** `git <args>` in the checkout, trimmed stdout. Tests inject one. */
  git?: (args: string[]) => string;
  log?: (line: string) => void;
  /** --live: the database the mailbox guard asks. Tests inject a fake; otherwise built from the admin credentials. */
  db?: SupabaseClient;
  /** --live: the admin credentials the guard's own client uses (src/lib/supabase/config.ts). Tests inject them. */
  adminCredentials?: () => { url: string; secretKey: string } | null;
  /** --live: the environment the production fence reads. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** --live: the provider group the readiness check reads. Tests inject one; otherwise the live Exchange mirror. */
  mirror?: ProviderAllowlistMirror;
};

// Kept here for its callers; the git call itself lives in outsideRepo.ts, the one recorder file that runs a process.
export { gitIn };

/** `:/` is relative to the top of the checkout, so the check finds the reader from any subdirectory too. */
export const READER_PATHSPEC = ':/src/lib/graph';

/** A duplicate source names its address in the parser's message; the address is the tenant's data. */
const safeConfigError = (message: string): string => message.replace(/^(sources\[\d+\]) repeats [\s\S]*$/, '$1 repeats an earlier source');

export type RecordGraphResult = {
  digestSha256: string;
  interactions: number;
  bodies: number;
  bodyBytes: number;
  orphansDropped: number;
  droppedHeaders: string[];
  readerCommit: string;
};

/** `git rev-parse HEAD` of the checkout, which the cassette names as the reader that made it. */
function headSha(git: (args: string[]) => string): string {
  const readerCommit = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(readerCommit)) throw new RecorderRefusal('git rev-parse HEAD did not return a commit sha');
  return readerCommit;
}

/** The end of both paths: lint and write the cassette (digest last), then print counts, the cassette id and the reader. */
function sealAndReport(
  out: string,
  cassette: CassetteData,
  meta: { sourceCount: number; droppedHeaders: string[]; orphansDropped: number; readerCommit: string },
  log: (line: string) => void,
): RecordGraphResult {
  const { digestSha256 } = saveCassette(resolve(out), cassette); // lint, then refuse; wx 0600; digest last
  const bodyBytes = Object.values(cassette.manifest.bodies).reduce((sum, bytes) => sum + bytes, 0);
  const { sourceCount, droppedHeaders, orphansDropped, readerCommit } = meta;
  const result: RecordGraphResult = {
    digestSha256,
    interactions: cassette.interactions.length,
    bodies: cassette.bodies.size,
    bodyBytes,
    orphansDropped,
    droppedHeaders,
    readerCommit,
  };

  log(`sources ${sourceCount}`);
  log(`interactions ${result.interactions}`);
  log(`bodies ${result.bodies} (${bodyBytes} bytes)`);
  log(`orphans dropped ${orphansDropped}`);
  log(`cassette sha256:${digestSha256}`);
  log(`reader ${readerCommit}`);
  log(`dropped headers: ${droppedHeaders.join(', ') || 'none'}`);
  return result;
}

export async function recordGraph(
  options: { configPath: string; out: string; allowEnvPem: boolean },
  deps: RecordGraphDeps = {},
): Promise<RecordGraphResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const git = deps.git ?? gitIn(repoRoots()[0]);

  // Everything below runs before any network call.
  assertOutsideRepo(options.out, deps.repoRoots);
  if (existsSync(options.out)) throw new RecorderRefusal('--out already exists; a cassette is never overwritten');

  // The cassette names the reader that made it (design Q11): a dirty reader would name a commit that did not.
  if (git(['status', '--porcelain', '--', READER_PATHSPEC]) !== '') {
    throw new RecorderRefusal(
      'the Graph reader has uncommitted changes; commit or stash them so the cassette names the reader that made it',
    );
  }
  const readerCommit = headSha(git);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(options.configPath), 'utf8'));
  } catch {
    // The parser's own message quotes the file; the config is the tenant's data.
    throw new RecorderRefusal('The registration config could not be read as JSON');
  }
  // The recorder writes nothing to the database and never asks who owns a source, so a mailbox with no owner is
  // not a fault here (write-registration refuses it unless told otherwise).
  const parsed = parseRegistrationConfig(raw, { allowEnvPem: options.allowEnvPem, allowOwnerless: true });
  if (!parsed.ok) {
    throw new RecorderRefusal(`The registration config is not valid:\n${parsed.errors.map((e) => `- ${safeConfigError(e)}`).join('\n')}`);
  }
  const { config } = parsed;

  // A live read uses the registration's own credential, and no mailbox read may happen outside the guard (#262):
  // the credential is usable only behind the guard module. So this --config path reads only through a transport it
  // is handed (the fake tenant in tests and in the synthetic cassette), and a live tenant is read by --live, through
  // the guarded recording session (see D68).
  if (!deps.fetchImpl || !deps.tokenCache) {
    throw new RecorderRefusal(
      'Live recording is not available with --config: every mailbox read passes the mailbox guard (#262); use --live, which reads through the guarded recording',
    );
  }
  const { cassette, droppedHeaders, orphansDropped } = await recordSources({
    http: {
      getToken: deps.tokenCache.forRegistration({
        tenantId: config.tenantId,
        msTenantId: config.msTenantId,
        clientId: config.clientId,
        certThumbprint: config.certThumbprint,
        certSecretRef: config.certSecretRef,
      }),
      fetchImpl: deps.fetchImpl,
    },
    sources: config.sources.map(({ kind, address }) => ({ kind, address })),
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  cassette.manifest.readerCommit = readerCommit;

  return sealAndReport(options.out, cassette, { sourceCount: config.sources.length, droppedHeaders, orphansDropped, readerCommit }, log);
}

export type LiveRecordOptions = {
  /** --config is for the injected path: a live run reads its registration from the database. */
  configPath?: string | null;
  tenantId: string;
  /** The Microsoft tenant id the operator read from Entra, independently of Conductia. */
  msTenantId: string;
  /** The full list of the registration's mail domains, as typed. */
  confirmDomains: string[];
  /** Required unless --preflight. */
  out: string | null;
  allowEnvPem: boolean;
  allowRemoteSupabase: string | null;
  preflight: boolean;
};

/** What the gates established: the database they asked and the active registration row they bound the run to. */
export type LiveGateResult = {
  db: SupabaseClient;
  /** The row the run is bound to. `clientId`, `certThumbprint` and `certSecretRef` are what the capture authenticates with. */
  registration: {
    tenantId: string;
    msTenantId: string;
    clientId: string;
    certThumbprint: string | null;
    mailboxDomains: string[];
    certSecretRef: string;
    scopeGroupId: string | null;
  };
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every refusal of a --live run that needs no Graph call, in order. Each is fixed text, never a value (not the
 * tenant, the domains, the host or an address), and each runs before the first request to Microsoft: this function
 * makes none. It reads only the database the guard's own client reads (`getSupabaseAdminCredentials`, the same URL
 * and key), and only the registration row.
 *
 * Bound by the operator, not inferred: the Microsoft tenant id (read from Entra) and the FULL domain set must equal
 * the registration's, so a mistyped --tenant, or a registration repointed at another tenant, cannot be recorded.
 */
export async function assertLiveGates(options: LiveRecordOptions, deps: RecordGraphDeps = {}): Promise<LiveGateResult> {
  const git = deps.git ?? gitIn(repoRoots()[0]);

  // Local, pure checks first.
  if (options.configPath) {
    throw new RecorderRefusal('--live reads the registration from the database and takes no --config');
  }
  if (!GUID.test(options.tenantId)) throw new RecorderRefusal('--tenant must be the Conductia tenant uuid');
  if (!GUID.test(options.msTenantId)) throw new RecorderRefusal('--ms-tenant-id must be the Microsoft tenant id (a GUID) from Entra');
  const confirmed = normalizeMailboxDomains(options.confirmDomains);
  if (confirmed.errors.length > 0) {
    throw new RecorderRefusal('--confirm-domains must list every mail domain of the registration (bare domains, such as bank.example)');
  }
  if (!options.preflight) {
    if (!options.out) throw new RecorderRefusal('--live needs --out <new dir outside the repo> (or --preflight)');
    assertOutsideRepo(options.out, deps.repoRoots);
    if (existsSync(options.out)) throw new RecorderRefusal('--out already exists; a cassette is never overwritten');
  }

  // A secondary fence: it reads the operator's own environment, which the operator controls.
  if (isProductionAppEnv(deps.env ?? process.env)) {
    throw new RecorderRefusal('Refusing to record with a production environment (NEXT_PUBLIC_APP_ENV)');
  }
  // The whole tree, not only the reader: the guard module and this capture code are part of what the run trusts.
  if (git(['status', '--porcelain']) !== '') {
    throw new RecorderRefusal('the checkout has uncommitted changes; a live recording runs from a clean checkout');
  }

  // The database the guard asks is the database this run is bound to: the same URL and key.
  const credentials = (deps.adminCredentials ?? getSupabaseAdminCredentials)();
  if (!credentials) {
    throw new RecorderRefusal('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must both be set (the database the mailbox guard asks)');
  }
  try {
    assertSupabaseTarget(credentials.url, options.allowRemoteSupabase);
  } catch {
    throw new RecorderRefusal(
      'the Supabase target must be a loopback address, or an https host named exactly by --allow-remote-supabase',
    );
  }
  // The guard's own client, built from the credentials just checked.
  const db = deps.db ?? createSupabaseAdminClient();

  const { data, error } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id, ms_tenant_id, client_id, cert_thumbprint, mailbox_domains, cert_secret_ref, scope_group_id')
    .eq('tenant_id', options.tenantId)
    .eq('status', REGISTRATION_STATUS.ACTIVE)
    .maybeSingle();
  if (error) throw new RecorderRefusal('the registration lookup failed');
  const row = data as {
    tenant_id: string;
    ms_tenant_id: string;
    client_id: string;
    cert_thumbprint: string | null;
    mailbox_domains: unknown;
    cert_secret_ref: string | null;
    scope_group_id: string | null;
  } | null;
  if (!row) throw new RecorderRefusal('the tenant has no active Graph reader registration');

  if (String(row.ms_tenant_id).toLowerCase() !== options.msTenantId.toLowerCase()) {
    throw new RecorderRefusal('--ms-tenant-id does not match the registration; check the Microsoft tenant id in Entra');
  }
  const stored = normalizeMailboxDomains(row.mailbox_domains);
  const same =
    stored.errors.length === 0 &&
    stored.domains.length === confirmed.domains.length &&
    stored.domains.every((domain) => confirmed.domains.includes(domain));
  if (!same) throw new RecorderRefusal("--confirm-domains does not equal the registration's full set of mail domains");

  const certSecretRef = row.cert_secret_ref ?? '';
  if (!certSecretRef.startsWith('env:')) {
    throw new RecorderRefusal('a live recording is for a registration with an env: certificate (the owner laptop path)');
  }
  if (!options.allowEnvPem) {
    throw new RecorderRefusal('An env: certificate is for the Conductia test tenant only; pass --allow-env-pem to confirm');
  }
  // Checked here, not at the first token mint, where the failure prints only that the recording failed. Present or
  // not: the value is never read into a message.
  if (!(deps.env ?? process.env)[certSecretRef.slice('env:'.length)]) {
    throw new RecorderRefusal("the environment variable the registration's env: certificate names is not set");
  }

  return {
    db,
    registration: {
      tenantId: row.tenant_id,
      msTenantId: row.ms_tenant_id,
      clientId: row.client_id,
      certThumbprint: row.cert_thumbprint ?? null,
      mailboxDomains: stored.domains,
      certSecretRef,
      scopeGroupId: row.scope_group_id ?? null,
    },
  };
}

/** What a --live run did: the readiness it acted on, and the sealed cassette's counts (null for --preflight). */
export type LiveRecordResult = { readiness: Readiness; recorded: RecordGraphResult | null };

/**
 * --live: the gates, then the one readiness check. With --preflight it prints the counts and returns: no mail is read
 * and no file is written. Without it, a blocked run refuses; otherwise the counts are announced and every ready
 * source is read through one guarded recording (cassette/liveCapture.ts has the refusal accounting), then the
 * recording is scrubbed, linted and sealed as the injected path's is. A run that recorded no source refuses.
 *
 * Before the first Graph request: the gates, the readiness check (which reads the provider group and asks the guard
 * about each source) and the HEAD check. Nothing is written until the whole recording has succeeded.
 */
export async function recordGraphLive(options: LiveRecordOptions, deps: RecordGraphDeps = {}): Promise<LiveRecordResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { db, registration } = await assertLiveGates(options, deps);
  // The same function the capture reads its sources from, so the two cannot disagree. Built after the gates.
  const readiness = await assessReadiness(db, registration.tenantId, registration, deps.mirror ?? createLiveAllowlistMirror());
  if (options.preflight) {
    for (const line of readinessLines(readiness)) log(line);
    return { readiness, recorded: null };
  }
  const { pass } = readiness;
  if (readiness.blocked !== null || pass === null) {
    throw new RecorderRefusal(`the run is blocked (${readiness.blocked ?? 'no readiness'}); nothing is read`);
  }
  if (!options.out) throw new RecorderRefusal('--live needs --out <new dir outside the repo> (or --preflight)');
  for (const line of readinessLines(readiness)) log(line);

  const git = deps.git ?? gitIn(repoRoots()[0]);
  const readerCommit = headSha(git);

  // The session reads Graph and shows the recorder its responses; the recorder has no transport of its own, so
  // nothing it holds can reach the tenant around the guard.
  const noTransport = (async () => {
    throw new RecorderRefusal('the recorder has no transport of its own in a live run');
  }) as unknown as typeof fetch;
  const recorder = createRecorder(noTransport);
  const session = createGuardedRecording({ observe: recorder.observe, extract: RECORD_EXTRACT });

  const { sources, skipped } = await captureReady({
    session,
    ready: readiness.ready,
    observed: () => recorder.raw.length,
    ctx: {
      tenantId: registration.tenantId,
      // The same group and policy the verdicts came from.
      providerCheck: pass.group.providerCheck,
      readKey: pass.group.readKey,
      exclusion: { policy: pass.policy, threadTaint: new Map() },
      // The active row, and the env: PEM it names (read from the environment when the first token is minted).
      graphRegistration: {
        tenantId: registration.tenantId,
        msTenantId: registration.msTenantId,
        clientId: registration.clientId,
        certThumbprint: registration.certThumbprint,
        certSecretRef: registration.certSecretRef,
      },
    },
  });
  for (const line of skippedLines(skipped)) log(line);
  if (sources.length === 0) throw new RecorderRefusal('no source was recorded; nothing is written');

  const { cassette, droppedHeaders, orphansDropped } = scrub(recorder.raw, {
    sources,
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  cassette.manifest.readerCommit = readerCommit;
  const recorded = sealAndReport(options.out, cassette, { sourceCount: sources.length, droppedHeaders, orphansDropped, readerCommit }, log);
  return { readiness, recorded };
}

/**
 * The one line the CLI prints for a failure. Fixed text and never a value: a Graph error's message carries a
 * request id, a config error can name an address, and an unknown exception can carry anything. Known failures
 * print their class and a status code or a lint rule; anything else prints its class only.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof RecorderRefusal) return error.message; // fixed text by construction (refusal.ts)
  if (error instanceof CassetteLintError) {
    return `CassetteLintError: the cassette failed its credential check, nothing was written:\n${error.findings
      .map((f) => `  ${f.rule} at ${f.where}`)
      .join('\n')}`;
  }
  if (error instanceof ScrubDivergenceError) return `ScrubDivergenceError: the tenant changed during the recording (${error.keys} keys); re-record`;
  if (error instanceof GraphHttpError) return `GraphHttpError: Graph answered ${error.status}`;
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  return `${name}: the recording failed (no detail is printed: it may name a tenant value)`;
}

function argValue(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

async function main(argv: string[]): Promise<void> {
  const configPath = argValue(argv, '--config');
  const out = argValue(argv, '--out');
  if (argv.includes('--live')) {
    const tenantId = argValue(argv, '--tenant');
    const msTenantId = argValue(argv, '--ms-tenant-id');
    const confirmDomains = argValue(argv, '--confirm-domains');
    const preflight = argv.includes('--preflight');
    if (!tenantId || !msTenantId || !confirmDomains || (!out && !preflight)) {
      throw new RecorderRefusal(
        'Usage: record-graph.ts --live --tenant <uuid> --ms-tenant-id <guid> --confirm-domains <domain[,domain]> --out <new dir outside the repo> --allow-env-pem [--allow-remote-supabase <host>] [--preflight]',
      );
    }
    await recordGraphLive({
      configPath,
      tenantId,
      msTenantId,
      confirmDomains: confirmDomains.split(',').map((domain) => domain.trim()),
      out,
      allowEnvPem: argv.includes('--allow-env-pem'),
      allowRemoteSupabase: argValue(argv, '--allow-remote-supabase'),
      preflight,
    });
    return;
  }
  if (!configPath || !out) {
    throw new RecorderRefusal('Usage: record-graph.ts --config <registration.json> --out <new dir outside the repo> [--allow-env-pem]');
  }
  await recordGraph({ configPath, out, allowEnvPem: argv.includes('--allow-env-pem') });
}

if (process.argv[1]?.endsWith('record-graph.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describeFailure(error));
    process.exit(1);
  });
}
