// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The Google primitives come through
// the operator door, never from a reader module (tests/mailbox-access-pins.test.ts).
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DIRECTORY_SCOPES, GMAIL_READER_SCOPE } from '../../src/lib/constants/googleReader';
import type { CallerTokenSource } from '../../src/lib/google/reader/credentials';
import type { GoogleHttpOptions } from '../../src/lib/google/reader/http';
import type { GoogleSigningIdentity } from '../../src/lib/google/reader/token';
import { argValue, assertSecretsFolderKeyless, requireLiveRun } from './lib/live';
import { domainOf, normalizeProbeAddress, PROBE_ERROR_CODE, ProbeCodeError, probeErrorLine } from './lib/probe';

const {
  GoogleHttpError,
  GoogleTokenError,
  assertKeylessCredentialFile,
  createCallerTokenSource,
  createDelegatedTokenCache,
  createDirectoryTokenSource,
  googleJson,
  serviceAccountAccessToken,
} = googleOperatorKit();

// The live check of the team inbox design (#581, thread T1, design R7 and R13). The owner runs it by hand
// and pastes the rows back: first planned on the emailmask.uk trial (expired 2026-10-20), now a gate on a
// firm's first live connect (ADR-0026), and runnable on the paid dev Workspace
// (docs/04-operations/dev-google-workspace-setup.md).
//
//   npm run google:probe-team -- --live --confirm-domain <domain> --registration .secrets/google/registration.json \
//     [--alias <address>] [--group <address>] [--suspended <address>] [--shared <address>]
//
//   alias      an alias of a user                       group      a Google Group that is NOT the allowlist group
//   suspended  a suspended user                         shared     a real shared user mailbox (the team inbox)
//
// Each address gets four rows: (1) Directory users.get with a directory token minted with BOTH scopes, (2) Directory
// members.list(maxResults=1) on the address, (3) a DWD token mint for the address with gmail.readonly, and (4) the
// Gmail profile, only where step 3 succeeded. The shared mailbox gets a fifth: (5) whether it is a DIRECT member of the
// allowlist (ingest) group, which the live mirror requires (audit item 3). Once per run, before the addresses, the
// allowlist group is listed with the same two-scope token, which confirms that adding the Users scope does not break
// the group mirror.
//
// What it prints: a role name, HTTP statuses, Google's machine reasons, counts and yes/no. Never an address, an id, a
// name, a token or mail. The DWD token (step 3) is used for the profile (step 4) and dropped; no message or thread is
// listed or read, and the profile request asks for the address field only. Like scripts/google/lib/probe.ts it
// reaches Google through the operator kit, not through a reader, so it is not a mail read and the #262 guard is not
// asked: it runs by hand against addresses the owner names inside the trial domain (--live, --confirm-domain).
//
// Exits 1 when it refuses to run, or when any row deviates from the expected pattern (thread T1): the owner reads
// the rows against design R7 before phase 7 merges.

type Env = Record<string, string | undefined>;

export type TeamProbeDeps = {
  env?: Env;
  io?: { log: (line: string) => void };
  cwd?: string;
  callerToken?: () => CallerTokenSource;
  directoryToken?: () => CallerTokenSource | null;
  fetchImpl?: typeof fetch;
  /** Overrides for the request loop (tests: no sleeping). */
  http?: Pick<GoogleHttpOptions, 'sleep' | 'random' | 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs'>;
};

export const TEAM_PROBE_ROLES = ['alias', 'group', 'suspended', 'shared'] as const;
export type TeamProbeRole = (typeof TEAM_PROBE_ROLES)[number];

const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1';
const USER_FIELDS = 'id,primaryEmail,suspended,archived,isMailboxSetup';
/** A probe should say what Google answered, not wait out a retry ladder. */
const PROBE_HTTP = { maxAttempts: 2, timeoutMs: 20_000 } as const;

/** One request's outcome: the HTTP status (0: no HTTP answer), the body on success, and the code-shaped detail. */
type Call<T> = { status: number; body: T | null; detail: string };

/** Only code-shaped text is ever printed. Anything else is dropped, so a message cannot carry an address into a row. */
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const safe = (value: string | null | undefined): string | null => (value && CODE.test(value) ? value : null);

async function call<T>(run: () => Promise<T>): Promise<Call<T>> {
  try {
    return { status: 200, body: await run(), detail: '' };
  } catch (error) {
    if (error instanceof GoogleHttpError) {
      const reason = safe(error.reason);
      return { status: error.status, body: null, detail: reason ? ` reason=${reason}` : '' };
    }
    if (error instanceof GoogleTokenError) {
      const reason = safe(error.reason);
      return { status: error.status, body: null, detail: reason ? ` error=${reason}` : '' };
    }
    const name = safe(error instanceof Error ? error.constructor.name : typeof error) ?? 'unknown';
    return { status: 0, body: null, detail: ` error=${name}` };
  }
}

const statusText = (status: number): string => (status === 0 ? 'none' : String(status));
/** yes/no, or absent when Google did not send the field as a boolean. */
const yesNo = (value: unknown): string => (value === true ? 'yes' : value === false ? 'no' : 'absent');

function flag(argv: string[], name: string): string | null {
  try {
    return argValue(argv, name);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  }
}

type TeamProbeRegistration = {
  tenantId: string;
  workspaceDomain: string;
  serviceAccountEmail: string;
  directoryServiceAccountEmail: string;
  allowlistGroup: string;
};

/** The registration file `write-registration.ts` writes: the five fields this probe uses, nothing else is read. */
function registrationFromFile(path: string): TeamProbeRegistration {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_FILE_UNREADABLE);
  }
  const fields = ['tenantId', 'workspaceDomain', 'serviceAccountEmail', 'directoryServiceAccountEmail', 'allowlistGroup'] as const;
  if (!raw || fields.some((field) => typeof raw[field] !== 'string' || !(raw[field] as string).trim())) {
    throw new ProbeCodeError(PROBE_ERROR_CODE.REGISTRATION_FILE_UNREADABLE);
  }
  return Object.fromEntries(fields.map((field) => [field, raw[field] as string])) as TeamProbeRegistration;
}

type UsersGet = { id?: unknown; primaryEmail?: unknown; suspended?: unknown; archived?: unknown; isMailboxSetup?: unknown };

/** What one address answered, for the row text and the expected-pattern check. */
type Observed = {
  users: Call<UsersGet>;
  equals: boolean | null;
  members: Call<unknown>;
  token: Call<string> | null;
  profile: Call<{ emailAddress?: unknown }> | null;
  profileEquals: boolean | null;
  /** Whether the address is a direct USER member of the ingest group (the live mirror's test); null when unknown. */
  inIngestGroup: boolean | null;
};

/**
 * The pattern thread T1 expects for each kind of address. A deviation goes back to design R7.
 *  - alias:     users.get 200, and the primary address is not the input.
 *  - group:     users.get 404, then members.list 200.
 *  - suspended: users.get 200 with suspended true.
 *  - shared:    users.get 200, primary address is the input, not suspended or archived, mailbox set up; the token and
 *               the profile succeed and the profile address is the input; and the address is a DIRECT member of the
 *               ingest group (audit item 3): the live mirror reads direct USER members only, and nobody signs in as a
 *               team inbox to be added, so the Workspace admin adds it by its primary address.
 */
const EXPECTED: Record<TeamProbeRole, (o: Observed) => boolean> = {
  alias: (o) => o.users.status === 200 && o.equals === false,
  group: (o) => o.users.status === 404 && o.members.status === 200,
  suspended: (o) => o.users.status === 200 && o.users.body?.suspended === true,
  shared: (o) =>
    o.users.status === 200 &&
    o.equals === true &&
    o.users.body?.suspended === false &&
    o.users.body?.archived === false &&
    o.users.body?.isMailboxSetup === true &&
    o.token?.status === 200 &&
    o.profile?.status === 200 &&
    o.profileEquals === true &&
    o.inIngestGroup === true,
};

export async function teamProbeMain(argv: string[], deps: TeamProbeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.io?.log ?? ((line: string) => console.log(line));
  try {
    return await teamProbe(argv, env, log, deps);
  } catch (error) {
    log(probeErrorLine(error));
    return 1;
  }
}

async function teamProbe(argv: string[], env: Env, log: (line: string) => void, deps: TeamProbeDeps): Promise<number> {
  // Before anything is read: the live-run flag, the registration, then the domain confirmation.
  if (!argv.includes('--live')) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_LIVE_REQUIRED);
  const registrationPath = flag(argv, '--registration');
  if (!registrationPath) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);
  const registration = registrationFromFile(registrationPath);
  try {
    requireLiveRun(argv, registration.workspaceDomain);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_CONFIRM_DOMAIN);
  }

  // Every address is shaped, inside the registered domain and named once, before any Google call.
  const addresses = new Map<TeamProbeRole, string>();
  for (const role of TEAM_PROBE_ROLES) {
    const raw = flag(argv, `--${role}`);
    if (raw === null) continue;
    const address = normalizeProbeAddress(raw);
    if (domainOf(address) !== registration.workspaceDomain.toLowerCase()) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_OUT_OF_DOMAIN);
    if ([...addresses.values()].includes(address)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_CONFLICT);
    addresses.set(role, address);
  }
  if (addresses.size === 0) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MISSING);

  // The worker's own identity, keyless, as the connection probe's P01 requires it.
  const credentials = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!credentials) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
  assertKeylessCredentialFile(credentials, env);
  assertSecretsFolderKeyless(resolve(deps.cwd ?? process.cwd(), '.secrets'));
  const callerToken = deps.callerToken ? deps.callerToken() : createCallerTokenSource(env);

  // The announce line names the domain, never an address or a service account.
  log(`LIVE Google run: google:probe-team against ${registration.workspaceDomain} for tenant ${registration.tenantId}`);

  const http = (getToken: GoogleHttpOptions['getToken']): GoogleHttpOptions => ({
    ...PROBE_HTTP,
    ...deps.http,
    getToken,
    fetchImpl: deps.fetchImpl,
  });

  // The directory token, minted once with both scopes on whichever path the worker uses: the directory credential
  // when GOOGLE_DIRECTORY_CREDENTIALS is set, else generateAccessToken on the directory service account.
  const directorySource = (deps.directoryToken ? deps.directoryToken() : createDirectoryTokenSource(env)) ?? undefined;
  const minted = await call(() =>
    directorySource
      ? directorySource()
      : serviceAccountAccessToken(callerToken, registration.directoryServiceAccountEmail, [...DIRECTORY_SCOPES], deps.fetchImpl),
  );
  log(`T1 directoryToken scopes=${DIRECTORY_SCOPES.length} status=${statusText(minted.status)}${minted.detail}`);
  const directory = minted.body;

  const dwd: GoogleSigningIdentity = { tenantId: registration.tenantId, serviceAccountEmail: registration.serviceAccountEmail };
  const tokens = createDelegatedTokenCache({ callerToken, fetchImpl: deps.fetchImpl });
  const directoryHttp = directory === null ? null : http(async () => directory);

  // Once per run, first: the ingest (allowlist) group's members, with the same two-scope token, as the live mirror reads
  // them: direct members of type USER (groupMirror.ts). The count is compared by the owner with the connection probe's
  // P08 line from before the Users scope was added; the set answers whether a team inbox is in the group.
  let groupMirrorOk = false;
  const directUsers = new Set<string>();
  if (directoryHttp) {
    let count = 0;
    let pageToken: string | undefined;
    let last: Call<{ members?: Array<{ email?: unknown; type?: unknown }>; nextPageToken?: string }>;
    do {
      const query = `maxResults=200&fields=members(email,type),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      last = await call(() =>
        googleJson<{ members?: Array<{ email?: unknown; type?: unknown }>; nextPageToken?: string }>(
          `${DIRECTORY_API}/groups/${encodeURIComponent(registration.allowlistGroup)}/members?${query}`,
          directoryHttp,
        ),
      );
      for (const member of last.body?.members ?? []) {
        count += 1;
        if (member.type === 'USER' && typeof member.email === 'string') directUsers.add(member.email.trim().toLowerCase());
      }
      pageToken = last.status === 200 ? last.body?.nextPageToken : undefined;
    } while (pageToken);
    groupMirrorOk = last.status === 200;
    log(`T1 groupMirror status=${statusText(last.status)}${last.detail}${groupMirrorOk ? ` members=${count}` : ''}`);
  } else {
    log('T1 groupMirror skipped=no_directory_token');
  }

  let deviations = 0;
  for (const [role, address] of addresses) {
    const row = (step: string, text: string): void => log(`T1 ${role} ${step} ${text}`);
    const none: Call<never> = { status: 0, body: null, detail: ' skipped=no_directory_token' };

    // 1. users.get with the two-scope token.
    const users = directoryHttp
      ? await call(() => googleJson<UsersGet>(`${DIRECTORY_API}/users/${encodeURIComponent(address)}?fields=${USER_FIELDS}`, directoryHttp))
      : none;
    const equals = typeof users.body?.primaryEmail === 'string' ? users.body.primaryEmail.trim().toLowerCase() === address : null;
    row(
      'users.get',
      users.status === 200
        ? `status=200 primaryEmailEqualsInput=${yesNo(equals)} suspended=${yesNo(users.body?.suspended)} archived=${yesNo(users.body?.archived)} isMailboxSetup=${yesNo(users.body?.isMailboxSetup)}`
        : `status=${statusText(users.status)}${users.detail}`,
    );

    // 2. members.list on the address: a 403 here is the directory role reading the allowlist group alone.
    const members = directoryHttp
      ? await call(() => googleJson<unknown>(`${DIRECTORY_API}/groups/${encodeURIComponent(address)}/members?maxResults=1&fields=kind`, directoryHttp))
      : none;
    row('members.list', `status=${statusText(members.status)}${members.detail}`);

    // 3. A DWD token for the address, gmail.readonly. The token endpoint's status and error code, nothing else.
    const getMailToken = tokens.forSubject(dwd, address, GMAIL_READER_SCOPE.READONLY);
    const token = await call(() => getMailToken());
    row('dwd.token', `status=${statusText(token.status)}${token.detail}`);

    // 4. The Gmail profile (the address field only), where step 3 succeeded.
    let profile: Call<{ emailAddress?: unknown }> | null = null;
    let profileEquals: boolean | null = null;
    if (token.status === 200) {
      profile = await call(() =>
        googleJson<{ emailAddress?: unknown }>(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(address)}/profile?fields=emailAddress`,
          http(getMailToken),
        ),
      );
      profileEquals = typeof profile.body?.emailAddress === 'string' ? profile.body.emailAddress.trim().toLowerCase() === address : null;
      row('gmail.profile', profile.status === 200 ? `status=200 emailAddressEqualsInput=${yesNo(profileEquals)}` : `status=${statusText(profile.status)}${profile.detail}`);
    } else {
      row('gmail.profile', 'skipped=no_token');
    }

    // 5. A team inbox must be a direct member of the ingest group, or every live pass is refused not_in_provider_group.
    let inIngestGroup: boolean | null = null;
    if (role === 'shared') {
      inIngestGroup = groupMirrorOk ? directUsers.has(address) : null;
      row('ingestGroup', inIngestGroup === null ? 'directMember=unknown' : `directMember=${yesNo(inIngestGroup)}`);
    }

    const matches = EXPECTED[role]({ users, equals, members, token, profile, profileEquals, inIngestGroup });
    if (!matches) deviations += 1;
    row('verdict', matches ? 'matches=yes' : 'matches=no');
  }

  const matched = addresses.size - deviations;
  log(`T1 summary addresses=${addresses.size} matches=${matched} groupMirror=${groupMirrorOk ? 'ok' : 'failed'}`);
  return deviations === 0 && groupMirrorOk ? 0 : 1;
}

if (process.argv[1]?.endsWith('probe-team-mailbox.ts')) {
  teamProbeMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.log(probeErrorLine(error));
      process.exitCode = 1;
    },
  );
}
