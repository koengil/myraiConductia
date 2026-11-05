// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The Google primitives come through
// the operator door, never from a reader module (tests/mailbox-access-pins.test.ts).
import { googleOperatorKit } from '../../../src/lib/mailboxAccess/readers';

import {
  DIRECTORY_SCOPES,
  GMAIL_PROBE_RAW_FIELDS,
  GMAIL_PROBE_SEARCH_FIELDS,
  GMAIL_READER_SCOPE,
  GOOGLE_TOOL_SCOPE,
} from '../../../src/lib/constants/googleReader';
import { MAILBOX_REFUSAL_REASON } from '../../../src/lib/constants/discovery';
import { isProductionAppEnv } from '../../../src/lib/appEnv';
import type { CallerTokenSource } from '../../../src/lib/google/reader/credentials';
import type { GoogleSigningIdentity } from '../../../src/lib/google/reader/token';
import { assertSecretsFolderKeyless } from './live';

const {
  GoogleHttpError,
  GoogleTokenError,
  assertKeylessCredentialFile,
  createDelegatedTokenCache,
  googleFetch,
  googleJson,
  googleUrl,
  serviceAccountAccessToken,
} = googleOperatorKit();

// The connection probe (#259 plan 1.8; #344 design R15). Each check prints one line with ids,
// statuses and reason codes only, never mail content or an address. The PASS list doubles as
// the credential checklist sent to a bank's super admin.
//
// The #262 guard comes first, asked the way the worker asks it (owner bound, group decision
// applied): P14 admits the persona before any request that names it, and P13 only mints (never
// reads) a token for an out-of-scope test account the guard refuses as not allowlisted.

export type ProbeStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'MANUAL' | 'PENDING' | 'RECORDED' | 'SKIPPED';
export type ProbeResult = { id: string; status: ProbeStatus; label: string; detail?: string };

/**
 * Checks that must PASS for the probe to exit 0: a FAIL, and any inconclusive status (PENDING,
 * SKIPPED, UNAVAILABLE), makes it exit 1, except the documented exceptions below. P04 to P06, P10
 * and P11 are recorded, not gating.
 */
export const REQUIRED_CHECKS = ['P01', 'P02', 'P03', 'P07', 'P08', 'P09', 'P12', 'P13', 'P14'] as const;

/**
 * The one inconclusive status each of these required checks may end on without failing the run
 * (runbook step 10). P09 UNAVAILABLE: IAM denied signJwt as the directory service account (a 403
 * permission denial, nothing else), so the probe could not ask Google; the G9 delegation
 * inspection stands in. P12 UNAVAILABLE: no Drive
 * probe identity was configured (production has none); P12 is not part of G5.
 */
export const INCONCLUSIVE_ALLOWED: Readonly<Partial<Record<(typeof REQUIRED_CHECKS)[number], ProbeStatus>>> = {
  P09: 'UNAVAILABLE',
  P12: 'UNAVAILABLE',
};

/**
 * Every probe failure prints one of these, never a message (design R12, round 2 item 15).
 * `internal:<error class name>` covers anything else.
 */
export const PROBE_ERROR_CODE = {
  ARG_LIVE_REQUIRED: 'arg_live_required',
  ARG_CONFIRM_DOMAIN: 'arg_confirm_domain',
  ARG_MISSING: 'arg_missing',
  ARG_CONFLICT: 'arg_conflict',
  ARG_MALFORMED_TENANT: 'arg_malformed_tenant',
  ARG_MALFORMED_ADDRESS: 'arg_malformed_address',
  ARG_MALFORMED_MESSAGE_ID: 'arg_malformed_message_id',
  ARG_OUT_OF_DOMAIN: 'arg_out_of_domain',
  ARG_ON_ARGV_IN_TENANT_MODE: 'arg_on_argv_in_tenant_mode',
  ARG_REMOTE_DB: 'arg_remote_db',
  ARG_GUARD_REQUIRED: 'arg_guard_required',
  ARG_OUT_DIR: 'arg_out_dir',
  OUT_OF_SCOPE_NOT_REGISTERED: 'out_of_scope_not_registered',
  OUT_OF_SCOPE_LOOKUP_FAILED: 'out_of_scope_lookup_failed',
  REGISTRATION_NOT_FOUND: 'registration_not_found',
  REGISTRATION_LOOKUP_FAILED: 'registration_lookup_failed',
  REGISTRATION_FILE_UNREADABLE: 'registration_file_unreadable',
  SOURCE_LOOKUP_FAILED: 'source_lookup_failed',
  GROUP_UNAVAILABLE: 'group_unavailable',
  GUARD_UNAVAILABLE: 'guard_unavailable',
  SECRET_KEY_SHAPE: 'secret_key_shape',
  REPORT_WRITE_FAILED: 'report_write_failed',
} as const;
export type ProbeErrorCode = (typeof PROBE_ERROR_CODE)[keyof typeof PROBE_ERROR_CODE];

/**
 * A probe failure that carries a fixed code and nothing else. `cause` is kept for a check's own
 * status line (P08 reports the group read's HTTP status), never printed as a message.
 */
export class ProbeCodeError extends Error {
  override readonly name = 'ProbeCodeError';
  constructor(
    readonly code: ProbeErrorCode,
    readonly underlying?: unknown,
  ) {
    super(code);
  }
}

/** The fixed code for any failure: a ProbeCodeError's own, else the error's class name. */
export function probeErrorCode(error: unknown): string {
  if (error instanceof ProbeCodeError) return error.code;
  return `internal:${error instanceof Error ? error.constructor.name || 'Error' : typeof error}`;
}

/** The one line a failed probe prints: a code, never a message. */
export function probeErrorLine(error: unknown): string {
  return JSON.stringify({ evt: 'probe_error', reason: probeErrorCode(error) });
}

// A mailbox address the probe may name: lower-cased, one @, a dotted domain, and only the
// characters a Workspace address uses. Anything else (a second @, a newline, a wildcard the
// database lookups would read as a pattern) is refused before it reaches a lookup or a request.
const ADDRESS = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9_+-])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The address lower-cased, or ProbeCodeError arg_malformed_address. Never echoes the input. */
export function normalizeProbeAddress(raw: string): string {
  const address = raw.trim().toLowerCase();
  if (address.length > 254 || !ADDRESS.test(address)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MALFORMED_ADDRESS);
  return address;
}

// A Gmail API message id: lower-case hex. Anything else is refused before it reaches a URL.
const MESSAGE_ID = /^[0-9a-f]{8,32}$/;

/** The designated test message id, or ProbeCodeError arg_malformed_message_id. Never echoes the input. */
export function normalizeProbeMessageId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!MESSAGE_ID.test(id)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_MALFORMED_MESSAGE_ID);
  return id;
}

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export type ProbeRegistration = {
  tenantId: string;
  workspaceDomain: string;
  serviceAccountEmail: string;
  clientId: string;
  directoryServiceAccountEmail: string;
  allowlistGroup: string;
};

/** The allowlist group, read once through the live mirror (the worker's providerPass read). */
export type ProbeGroupRead = { count: number; providerCheck: (address: string) => string | null };

export type ProbeDeps = {
  env?: Record<string, string | undefined>;
  callerToken: CallerTokenSource;
  fetchImpl?: typeof fetch;
  registration: ProbeRegistration;
  /** The dedicated test persona: opted in, allowlisted, in the group, inside the domain. */
  mailbox: string;
  secretsDir: string;
  /**
   * P05: the Gmail id of a test message seeded in the persona's mailbox for this check alone. P05
   * reads nothing else: without it P05 is SKIPPED and no raw request is made, so the probe never
   * fetches a message the exclusion policy has not judged (the first in the inbox, say).
   */
  rawTestMessageId?: string;
  driveId?: string;
  driveProbeServiceAccountEmail?: string;
  /**
   * P13: a dedicated out-of-scope test account inside the domain, never allowlisted and never a
   * Conductia user. Its token is minted and discarded; it is never read.
   */
  outOfScope?: { address: string };
  /**
   * Asks the #262 guard for an address with its content_sources owner and the group's providerReason
   * bound, exactly as the worker asks it. Returns the refusal reason, or null when admitted. Throws
   * when it cannot be asked. Absent: P14 and P13 are PENDING (a laptop run without --guard-db only).
   */
  guardFor?: (address: string) => Promise<string | null>;
  /** The group read, from the live mirror (directory source). Reused by P08. */
  group?: () => Promise<ProbeGroupRead>;
  /** The directory identity's own token (GOOGLE_DIRECTORY_CREDENTIALS), when configured. */
  directoryToken?: CallerTokenSource;
  /** True when the address is no users, invites or allowed_mailboxes row anywhere, and no mailbox source in the tenant. */
  registeredOutOfScope?: (address: string) => Promise<boolean>;
  onResult?: (result: ProbeResult) => void;
};

/** Status and reason only. Never a message that could carry a body or an address. */
export function describeError(error: unknown): string {
  if (error instanceof GoogleHttpError) return `${error.status}${error.reason ? ` ${error.reason}` : ''}`;
  if (error instanceof GoogleTokenError) return `${error.status}${error.reason ? ` ${error.reason}` : ''}`;
  if (error instanceof ProbeCodeError) return error.code;
  return error instanceof Error ? error.name : 'unknown error';
}

const P13_LABEL = 'out-of-scope account: the guard refuses it as not allowlisted, delegation alone would not';
const P13_HINT = 'set the out-of-scope test account (PROBE_OUT_OF_SCOPE, or --out-of-scope with --guard-db)';
const P14_LABEL = 'the mailbox guard admits the persona with its owner and the group decision';
const P14_HINT = 'the guard was not asked: pass --guard-db (mandatory with --tenant and in production)';
const NOT_ADMITTED = 'the guard did not admit the persona mailbox';

/** The refusals that mean "not allowlisted", the only ones P13 accepts as the guard standing in the way. */
const NOT_ALLOWLISTED: ReadonlySet<string> = new Set([
  MAILBOX_REFUSAL_REASON.NO_SOURCE,
  MAILBOX_REFUSAL_REASON.NO_INVITE,
  MAILBOX_REFUSAL_REASON.NO_CONSENT,
  MAILBOX_REFUSAL_REASON.SEAT_INACTIVE,
]);

const PERSONA_CHECKS = [
  ['P02', 'signJwt on the DWD service account'],
  ['P03', 'gmail.readonly token and profile'],
  ['P04', 'gmail.metadata token'],
  ['P05', 'metadata token cannot read raw'],
  ['P06', 'metadata token cannot search'],
  ['P07', 'gmail.modify is refused (over-grant)'],
] as const;
/**
 * The machine reasons of an IAM permission denial on signJwt: the IAM Credentials API's
 * error.status, or a legacy errors[0].reason. A rate-limit 403 is not one of them.
 */
const IAM_PERMISSION_DENIED: ReadonlySet<string> = new Set(['PERMISSION_DENIED', 'forbidden']);
const P08_LABEL = 'directory group members';
const P09_LABEL = 'directory service account has no delegation';

const mailboxUrl = (mailbox: string, path: string): string =>
  `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}${path}`;

/**
 * P13's first step, before any Google call: the out-of-scope address must be the registered test
 * account. In the domain, not the persona, no users, invites or allowed_mailboxes row anywhere, and
 * no content_sources mailbox row in the tenant, so a real person is never its subject.
 */
async function assertOutOfScopeRegistered(deps: ProbeDeps, address: string, persona: string): Promise<void> {
  const refuse = () => new ProbeCodeError(PROBE_ERROR_CODE.OUT_OF_SCOPE_NOT_REGISTERED);
  if (domainOf(address) !== deps.registration.workspaceDomain.toLowerCase()) throw refuse();
  if (address === persona) throw refuse();
  if (!deps.registeredOutOfScope) throw refuse();
  let registered: boolean;
  try {
    registered = await deps.registeredOutOfScope(address);
  } catch {
    throw new ProbeCodeError(PROBE_ERROR_CODE.OUT_OF_SCOPE_LOOKUP_FAILED);
  }
  if (registered !== true) throw refuse();
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeResult[]> {
  const env = deps.env ?? process.env;
  const results: ProbeResult[] = [];
  const push = (id: string, status: ProbeStatus, label: string, detail?: string): void => {
    const result = { id, status, label, ...(detail ? { detail } : {}) };
    results.push(result);
    deps.onResult?.(result);
  };
  const reg = deps.registration;
  const persona = normalizeProbeAddress(deps.mailbox);
  const outOfScope = deps.outOfScope ? normalizeProbeAddress(deps.outOfScope.address) : null;
  const rawTestMessageId = deps.rawTestMessageId ? normalizeProbeMessageId(deps.rawTestMessageId) : null;

  // Before any Google call. In production the guard is mandatory (P14), and the out-of-scope
  // address must be the registered test account (P13 step 1).
  if (!deps.guardFor && isProductionAppEnv(env)) throw new ProbeCodeError(PROBE_ERROR_CODE.ARG_GUARD_REQUIRED);
  if (outOfScope) await assertOutOfScopeRegistered(deps, outOfScope, persona);

  const dwd: GoogleSigningIdentity = { tenantId: reg.tenantId, serviceAccountEmail: reg.serviceAccountEmail };
  const directory: GoogleSigningIdentity = { tenantId: reg.tenantId, serviceAccountEmail: reg.directoryServiceAccountEmail };
  const callerHttp = { getToken: deps.callerToken, fetchImpl: deps.fetchImpl };
  const tokens = createDelegatedTokenCache({ callerToken: deps.callerToken, fetchImpl: deps.fetchImpl });
  const directoryTokenFor = (scopes: readonly string[]): Promise<string> =>
    deps.directoryToken ? deps.directoryToken() : serviceAccountAccessToken(deps.callerToken, reg.directoryServiceAccountEmail, [...scopes], deps.fetchImpl);

  // P01: the worker's own identity, keyless, then a real caller token.
  let callerOk = false;
  try {
    const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
    assertKeylessCredentialFile(path, env);
    assertSecretsFolderKeyless(deps.secretsDir);
    await deps.callerToken();
    callerOk = true;
    push('P01', 'PASS', 'caller token (keyless credential)');
  } catch (error) {
    push('P01', 'FAIL', 'caller token (keyless credential)', describeError(error));
  }
  if (!callerOk) {
    for (const [id, label] of [
      ...PERSONA_CHECKS,
      ['P08', P08_LABEL],
      ['P09', P09_LABEL],
      ['P10', 'Reports token activity'],
      ['P12', 'Drive probe service account is a Viewer'],
    ] as const) {
      push(id, 'SKIPPED', label, 'no caller token');
    }
    push('P11', 'MANUAL', 'IAM Credentials Data Access log records the signJwt sub');
    push('P13', deps.outOfScope && deps.guardFor ? 'SKIPPED' : 'PENDING', P13_LABEL, deps.outOfScope && deps.guardFor ? 'no caller token' : P13_HINT);
    push('P14', deps.guardFor ? 'SKIPPED' : 'PENDING', P14_LABEL, deps.guardFor ? 'no caller token' : P14_HINT);
    results.sort((a, b) => a.id.localeCompare(b.id));
    return results;
  }

  // The group read, once, through the directory source. P14 applies its decision and P08 reports it.
  let group: { read: ProbeGroupRead } | { error: unknown } | null = null;
  if (deps.group) {
    try {
      group = { read: await deps.group() };
    } catch (error) {
      group = { error };
    }
  }

  // P14: the guard admits the persona with its real owner and the group decision bound. Until it
  // does, nothing below names the persona: no signJwt payload, no token, no Gmail request.
  let personaAdmitted = false;
  if (!deps.guardFor) {
    push('P14', 'PENDING', P14_LABEL, P14_HINT);
  } else {
    try {
      const refusal = await deps.guardFor(persona);
      if (refusal === null) {
        personaAdmitted = true;
        push('P14', 'PASS', P14_LABEL, 'admitted');
      } else {
        push('P14', 'FAIL', P14_LABEL, `refused ${refusal}`);
      }
    } catch (error) {
      push('P14', 'FAIL', P14_LABEL, `the guard could not be asked: ${describeError(error)}`);
    }
  }

  if (!personaAdmitted) {
    for (const [id, label] of PERSONA_CHECKS) push(id, 'SKIPPED', label, NOT_ADMITTED);
  } else {
    // P02: signJwt on the DWD SA (the payload is signed, not exchanged).
    try {
      const iat = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        iss: reg.serviceAccountEmail,
        sub: persona,
        scope: GMAIL_READER_SCOPE.READONLY,
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3_600,
      });
      const url = googleUrl(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(reg.serviceAccountEmail)}:signJwt`,
      );
      await googleJson(url, callerHttp, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
      push('P02', 'PASS', 'signJwt on the DWD service account');
    } catch (error) {
      push('P02', 'FAIL', 'signJwt on the DWD service account', describeError(error));
    }

    // P03: a gmail.readonly delegated token, then the profile. No message is listed or read.
    try {
      const getToken = tokens.forSubject(dwd, persona, GMAIL_READER_SCOPE.READONLY);
      const profile = await googleJson<{ messagesTotal?: number }>(mailboxUrl(persona, '/profile'), {
        getToken,
        fetchImpl: deps.fetchImpl,
      });
      push('P03', 'PASS', 'gmail.readonly token and profile', `200, ${profile.messagesTotal ?? 0} messages in the mailbox`);
    } catch (error) {
      push('P03', 'FAIL', 'gmail.readonly token and profile', describeError(error));
    }

    // P04 to P06: the metadata subset (settles R13; informs the deferred metadata level).
    let metadataToken: (() => Promise<string>) | null = null;
    try {
      const getToken = tokens.forSubject(dwd, persona, GMAIL_READER_SCOPE.METADATA);
      await getToken();
      metadataToken = () => getToken();
      push('P04', 'PASS', 'gmail.metadata token');
    } catch (error) {
      push('P04', 'FAIL', 'gmail.metadata token', describeError(error));
    }
    const metadataHttp = metadataToken
      ? { getToken: tokens.forSubject(dwd, persona, GMAIL_READER_SCOPE.METADATA), fetchImpl: deps.fetchImpl, maxAttempts: 2 }
      : null;
    if (!metadataHttp) {
      push('P05', 'SKIPPED', 'metadata token cannot read raw', 'no metadata token');
      push('P06', 'SKIPPED', 'metadata token cannot search', 'no metadata token');
    } else {
      if (!rawTestMessageId) {
        push('P05', 'SKIPPED', 'metadata token cannot read raw', 'no designated test message');
      } else {
        try {
          await googleFetch(mailboxUrl(persona, `/messages/${encodeURIComponent(rawTestMessageId)}?format=raw&fields=${GMAIL_PROBE_RAW_FIELDS}`), {}, metadataHttp);
          push('P05', 'RECORDED', 'metadata token cannot read raw', '200: the metadata token read a raw body (finding for F1)');
        } catch (error) {
          const status = error instanceof GoogleHttpError ? error.status : 0;
          push('P05', status === 403 ? 'PASS' : 'RECORDED', 'metadata token cannot read raw', describeError(error));
        }
      }
      try {
        await googleFetch(mailboxUrl(persona, `/threads?q=in%3Ainbox&maxResults=1&fields=${GMAIL_PROBE_SEARCH_FIELDS}`), {}, metadataHttp);
        push('P06', 'RECORDED', 'metadata token cannot search', '200: the metadata token searched (finding for F1)');
      } catch (error) {
        const status = error instanceof GoogleHttpError ? error.status : 0;
        push('P06', status === 403 || status === 400 ? 'PASS' : 'RECORDED', 'metadata token cannot search', describeError(error));
      }
    }

    // P07: the over-grant probe. A gmail.modify token must never be issued.
    try {
      await tokens.forSubject(dwd, persona, GOOGLE_TOOL_SCOPE.GMAIL_MODIFY_OVERGRANT_PROBE)();
      push('P07', 'FAIL', 'gmail.modify is refused (over-grant)', 'a gmail.modify token was issued: delegation is wider than gmail.metadata and gmail.readonly');
    } catch (error) {
      if (error instanceof GoogleTokenError && error.reason === 'unauthorized_client') {
        push('P07', 'PASS', 'gmail.modify is refused (over-grant)', 'unauthorized_client');
      } else {
        push('P07', 'FAIL', 'gmail.modify is refused (over-grant)', describeError(error));
      }
    }
  }

  // P08: the directory identity lists the group. With the guard wired, it reports the group read
  // P14 used; otherwise it lists the group itself, through the directory credential when one is set.
  if (group) {
    if ('read' in group) push('P08', 'PASS', P08_LABEL, `200, ${group.read.count} members`);
    else {
      const { error } = group;
      push('P08', 'FAIL', P08_LABEL, describeError(error instanceof ProbeCodeError && error.underlying ? error.underlying : error));
    }
  } else {
    try {
      // The group mirror's own mint: the members scope and the Users read the team inbox check adds (#581).
      const token = await directoryTokenFor(DIRECTORY_SCOPES);
      let count = 0;
      let pageToken: string | undefined;
      do {
        const query = `maxResults=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const page = await googleJson<{ members?: unknown[]; nextPageToken?: string }>(
          `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(reg.allowlistGroup)}/members?${query}`,
          { getToken: async () => token, fetchImpl: deps.fetchImpl },
        );
        count += page.members?.length ?? 0;
        pageToken = page.nextPageToken;
      } while (pageToken);
      push('P08', 'PASS', P08_LABEL, `200, ${count} members`);
    } catch (error) {
      push('P08', 'FAIL', P08_LABEL, describeError(error));
    }
  }

  // P09: the directory identity must have no domain-wide delegation. Its JWT names the persona, so
  // it runs only once the guard has admitted it. PASS needs Google's own refusal: an IAM denial on
  // signJwt (a 403 permission denial, and only that) means the probe could not ask; throttling,
  // a 5xx, a network error or anything else is a failure, never a pass and never an exception.
  if (!personaAdmitted) {
    push('P09', 'SKIPPED', P09_LABEL, NOT_ADMITTED);
  } else {
    try {
      await tokens.forSubject(directory, persona, GMAIL_READER_SCOPE.READONLY)();
      push('P09', 'FAIL', P09_LABEL, 'a delegated token was issued for the directory service account');
    } catch (error) {
      if (error instanceof GoogleTokenError && error.reason === 'unauthorized_client') {
        push('P09', 'PASS', P09_LABEL, 'refused: unauthorized_client');
      } else if (
        error instanceof GoogleHttpError &&
        error.status === 403 &&
        !error.throttled &&
        error.reason !== null &&
        IAM_PERMISSION_DENIED.has(error.reason)
      ) {
        push('P09', 'UNAVAILABLE', P09_LABEL, `the caller may not sign as the directory service account: ${describeError(error)}`);
      } else {
        push('P09', 'FAIL', P09_LABEL, describeError(error));
      }
    }
  }

  // P10: is the token audit visible in Reports? Never PASS by default.
  try {
    const token = await directoryTokenFor([GOOGLE_TOOL_SCOPE.REPORTS_AUDIT]);
    const filters = encodeURIComponent(`client_id==${reg.clientId}`);
    const page = await googleJson<{ items?: unknown[] }>(
      `https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/token?maxResults=10&filters=${filters}`,
      { getToken: async () => token, fetchImpl: deps.fetchImpl, maxAttempts: 2 },
    );
    push('P10', 'PASS', 'Reports token activity', `200, ${page.items?.length ?? 0} events`);
  } catch (error) {
    push('P10', 'UNAVAILABLE', 'Reports token activity', describeError(error));
  }

  push('P11', 'MANUAL', 'IAM Credentials Data Access log records the signJwt sub', 'check Cloud Logging and record yes or no');

  // P12: the Drive probe identity lists the seeded shared drive as a Viewer.
  if (!deps.driveId || !deps.driveProbeServiceAccountEmail) {
    push('P12', 'UNAVAILABLE', 'Drive probe service account is a Viewer', 'pass --drive-id and a drive probe service account');
  } else {
    try {
      const token = await serviceAccountAccessToken(
        deps.callerToken,
        deps.driveProbeServiceAccountEmail,
        [GOOGLE_TOOL_SCOPE.DRIVE_READONLY_PROBE],
        deps.fetchImpl,
      );
      const drive = await googleJson<{ id?: string; capabilities?: { canAddChildren?: boolean; canEdit?: boolean } }>(
        `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(deps.driveId)}?fields=id,capabilities(canAddChildren,canEdit)`,
        { getToken: async () => token, fetchImpl: deps.fetchImpl },
      );
      const viewer = !drive.capabilities?.canAddChildren && !drive.capabilities?.canEdit;
      push(
        'P12',
        viewer ? 'PASS' : 'FAIL',
        'Drive probe service account is a Viewer',
        viewer ? `200, drive ${drive.id}, viewer` : `200, but the identity can write to drive ${drive.id}`,
      );
    } catch (error) {
      push('P12', 'FAIL', 'Drive probe service account is a Viewer', describeError(error));
    }
  }

  // P13: a token-only delegation check. It passes only when the guard refuses the registered
  // out-of-scope account as not allowlisted AND Google would issue a token for it: the guard, not
  // delegation, is then what stands in the way. The token is discarded; no Gmail request is made.
  if (!outOfScope || !deps.guardFor) {
    push('P13', 'PENDING', P13_LABEL, P13_HINT);
  } else {
    let refusal: string | null = null;
    let asked = false;
    try {
      refusal = await deps.guardFor(outOfScope);
      asked = true;
    } catch (error) {
      push('P13', 'FAIL', P13_LABEL, `the guard could not be asked: ${describeError(error)}`);
    }
    if (asked && refusal === null) {
      push('P13', 'FAIL', P13_LABEL, 'the guard ADMITTED an address outside the allowlist');
    } else if (asked && refusal !== null && !NOT_ALLOWLISTED.has(refusal)) {
      push('P13', 'UNAVAILABLE', P13_LABEL, `inconclusive: refused ${refusal}, a reason other than not being allowlisted`);
    } else if (asked && refusal !== null) {
      // A cache of its own, dropped with this block: the token is never stored beside the persona's.
      const mint = createDelegatedTokenCache({ callerToken: deps.callerToken, fetchImpl: deps.fetchImpl });
      try {
        await mint.forSubject(dwd, outOfScope, GMAIL_READER_SCOPE.READONLY)();
        push('P13', 'PASS', P13_LABEL, `refused ${refusal}; delegation alone would have issued a token (discarded unused)`);
      } catch (error) {
        const uncovered = error instanceof GoogleTokenError && error.reason === 'unauthorized_client';
        push(
          'P13',
          'UNAVAILABLE',
          P13_LABEL,
          uncovered
            ? `refused ${refusal}, but delegation does not cover this address, so the guard was not the only barrier`
            : `refused ${refusal}; the token mint could not be asked: ${describeError(error)}`,
        );
      }
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

/** True when a required check is missing or ended on anything but PASS or its allowed inconclusive status. */
export function probeFailed(results: ProbeResult[]): boolean {
  return REQUIRED_CHECKS.some((id) => {
    const status = results.find((r) => r.id === id)?.status;
    return status === undefined || (status !== 'PASS' && status !== INCONCLUSIVE_ALLOWED[id]);
  });
}

export function formatProbeLine(r: ProbeResult): string {
  return `${r.id} ${r.status.padEnd(11)} ${r.label}${r.detail ? ` (${r.detail})` : ''}`;
}
