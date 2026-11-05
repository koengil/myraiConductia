// First import, on purpose: it claims the reader capability before any other
// module loads (tests/mailbox-access/boot-claim.test.ts pins the order). The
// registration's credential is used only inside it (#262).
import { probeReaderScope } from '../../src/lib/mailboxAccess/readers';

import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { isProductionAppEnv } from '../../src/lib/appEnv';
import { TABLE } from '../../src/lib/constants/tables';
import { GraphHttpError } from '../../src/lib/graph/http';
import type { ExchangeMailboxType, GroupProbeReport, ScopeProbeResult, ScopeProbeTarget } from '../../src/lib/graph/reader/probe';

// The owner's live check of the Exchange scope group (#275, design R9 and the
// Oct 19 checklist). With the registration's own certificate credential it
// answers, read-only:
//
//   Q1  does Graph list exactly the Exchange group's mailbox members, per
//       type, shared mailboxes included? (object ids against an Exchange export)
//   R1  are mail and UPN readable under the granted role? (counts)
//   R4  do the UPN and the object id reach the same inbox, do two members'
//       inboxes differ, and which key form do Graph's delta links use?
//   Q3  is a mailbox outside the group refused, and, optionally, are aliases
//       refused for a non-member? (statuses)
//
//   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
//     npm run m365:probe-group -- --tenant <Conductia tenant uuid> --confirm-ms-tenant <Entra tenant id> --preflight-only
//   env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY \
//     npm run m365:probe-group -- --tenant <Conductia tenant uuid> \
//     --confirm-ms-tenant <Entra tenant id> --group <scope group object id> \
//     --exchange-ids <file outside the repo> --out-of-scope <mailbox outside the group> \
//     [--alias-in-scope <secondary smtp of a member>] [--alias-out-of-scope <secondary smtp of a non-member>]
//
// The npm script loads `.env.local` with `node --env-file`, which never
// overrides a variable the shell already exports, so the `env -u` prefix drops
// the profile's hosted Supabase variables first. Run it as the owner checklist
// in scripts/m365/README.md ("Prove the group read") does.
//
// --preflight-only reads the registration, prints the Supabase host and the
// certificate scheme, and stops before any token is signed or Graph is
// called; it exits 1 unless the scheme is env: (a keyvault: certificate signs
// only where the worker runs).
//
// The export is a text file with one line per mailbox member, in the form
// `<ExternalDirectoryObjectId>,<RecipientTypeDetails>`, for example
// `0f8fad5b-d9cb-469f-a165-70867728950e,SharedMailbox`. Blank lines are
// ignored; nothing else is accepted.
//
// It prints only statuses, Graph error codes, counts, yes/no answers, Exchange
// mailbox types, the Supabase host and the certificate scheme: never an
// address, a name, an id or a body. A failure prints a fixed category with a
// status and a known Graph, MSAL or AADSTS code, never the underlying message,
// which can name the app or the directory. A code that is not on the fixed
// lists below prints as `other`: Graph's own shape check lets a GUID through.
// It refuses production, a mismatched Entra tenant, a --group that is not a
// GUID and a malformed export, all before any Graph call. Exit 0 when every answer is the expected one, 1
// otherwise.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_LINE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}),([A-Za-z]+)$/i;

// Every type the probe reports, in print order. A record, so a type added to the probe fails to compile here.
const TYPE_NAMES: Record<ExchangeMailboxType, true> = { UserMailbox: true, SharedMailbox: true, RoomMailbox: true, EquipmentMailbox: true, Other: true };
const TYPES = Object.keys(TYPE_NAMES) as ExchangeMailboxType[];

const USAGE =
  'Usage: probe-group-mirror.ts --tenant <uuid> --confirm-ms-tenant <guid> --preflight-only | ' +
  '--tenant <uuid> --confirm-ms-tenant <guid> --group <guid> --exchange-ids <file> --out-of-scope <mailbox> ' +
  '[--alias-in-scope <address>] [--alias-out-of-scope <address>]';

/** A failure whose message the script wrote itself, so it is safe to print as it is. */
export class ProbeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefusal';
  }
}

// The codes the probe may print, and nothing else (no identifiers on the owner's screen). Graph's error codes for the
// requests it makes (group listing, mailbox and inbox reads, delta), Exchange's, and the generic ones.
const KNOWN_GRAPH_CODES: ReadonlySet<string> = new Set([
  'Authorization_RequestDenied',
  'Authorization_IdentityNotFound',
  'Request_ResourceNotFound',
  'Request_BadRequest',
  'Request_UnsupportedQuery',
  'Request_ThrottledTemporarily',
  'Directory_ResultSizeLimitExceeded',
  'ResourceNotFound',
  'ErrorAccessDenied',
  'ErrorInvalidUser',
  'ErrorItemNotFound',
  'ErrorNonExistentMailbox',
  'ErrorInvalidIdMalformed',
  'ErrorInvalidRequest',
  'ErrorInternalServerError',
  'ErrorServerBusy',
  'ErrorMailboxStoreUnavailable',
  'ErrorMailboxMoveInProgress',
  'MailboxNotEnabledForRESTAPI',
  'MailboxNotSupportedForRESTAPI',
  'InvalidAuthenticationToken',
  'AccessDenied',
  'Forbidden',
  'NotFound',
  'BadRequest',
  'InvalidRequest',
  'TooManyRequests',
  'ApplicationThrottled',
  'ServiceUnavailable',
  'ServiceNotAvailable',
  'UnknownError',
  'generalException',
  'syncStateNotFound',
  'resyncRequired',
]);
// MSAL's error codes for a client-credential token request.
const KNOWN_MSAL_CODES: ReadonlySet<string> = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_grant',
  'invalid_scope',
  'invalid_resource',
  'access_denied',
  'temporarily_unavailable',
  'server_error',
  'network_error',
  'endpoints_resolution_error',
  'untrusted_authority',
  'invalid_client_credential',
]);
// Entra's sign-in error codes a certificate app-only token can meet.
const KNOWN_AADSTS_CODES: ReadonlySet<string> = new Set([
  'AADSTS700016', // application not found in the directory
  'AADSTS700024', // client assertion outside its valid time range
  'AADSTS700027', // client assertion signature did not validate
  'AADSTS7000215', // invalid client secret
  'AADSTS7000222', // client secret expired
  'AADSTS7000112', // application disabled
  'AADSTS90002', // tenant not found
  'AADSTS900023', // tenant identifier not valid
  'AADSTS90023', // invalid request
  'AADSTS500011', // resource principal not found
  'AADSTS70011', // invalid scope
  'AADSTS53003', // blocked by Conditional Access
  'AADSTS50013', // assertion audience or signature invalid
  'AADSTS50011', // reply address mismatch
]);

/** A Graph error code as the probe may print it: a known one as it is, any other as `other`, none as null. */
export function printableGraphCode(code: string | null): string | null {
  if (code === null || code === '') return null;
  return KNOWN_GRAPH_CODES.has(code) ? code : 'other';
}

const withCode = (status: number, code: string | null) => {
  const printable = printableGraphCode(code);
  return `${status}${printable ? ` ${printable}` : ''}`;
};

// Messages of our own certificate and token code that carry no tenant value (certificateSource.ts, token.ts). Each is
// printed as the fixed text on the right, never as the message itself, so an operator-chosen name (the env: variable
// a registration names) cannot be echoed.
const OWN_SAFE_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/^The reader certificate key variable \S+ is not set$/, "the reader certificate key variable that cert_secret_ref names is not set"],
  [/^The reader certificate key is not a readable PEM private key$/, 'the reader certificate key is not a readable PEM private key'],
  [/^Key Vault sign failed: (\d{3})$/, 'Key Vault sign failed with status $1'],
  [/^Key Vault sign returned no signature$/, 'Key Vault sign returned no signature'],
  [/^The reader registration has no cert_secret_ref$/, 'the reader registration has no cert_secret_ref'],
  [/^The reader registration has no cert_thumbprint$/, 'the reader registration has no cert_thumbprint'],
  [/^cert_secret_ref must name a secret, never hold key material$/, 'cert_secret_ref must name a secret, never hold key material'],
  [/^cert_secret_ref env: must name an environment variable$/, 'cert_secret_ref env: must name an environment variable'],
  [/^cert_secret_ref must start with keyvault: or env:$/, 'cert_secret_ref must start with keyvault: or env:'],
  [/^env: certificate references are refused in production$/, 'env: certificate references are refused in production'],
  [/^MSAL returned no Graph token$/, 'MSAL returned no Graph token'],
];
/**
 * What a failure may say on the owner's screen (audit item 1, verify item 1): a ProbeRefusal as written, a Graph
 * status with a known code, a token refusal by its known MSAL and AADSTS codes, or the fixed text for one of our own
 * certificate messages. Any code off the fixed lists prints as `other`, and anything else is named by category
 * only: an Entra message can quote the app's client id and the directory's name.
 */
export function safeFailure(error: unknown): string {
  if (error instanceof ProbeRefusal) return error.message;
  if (error instanceof GraphHttpError) return `Graph request failed with status ${withCode(error.status, error.code)}`;
  const message = error instanceof Error ? error.message : '';
  for (const [pattern, text] of OWN_SAFE_MESSAGES) {
    if (pattern.test(message)) return `certificate or token setup: ${message.replace(pattern, text)}`;
  }
  const { errorCode, errorMessage } = (error ?? {}) as { errorCode?: unknown; errorMessage?: unknown };
  const aadsts = /AADSTS\d+/.exec(`${typeof errorMessage === 'string' ? errorMessage : ''} ${message}`)?.[0];
  if (typeof errorCode === 'string' || aadsts) {
    const code = typeof errorCode !== 'string' || errorCode === '' ? 'no code' : KNOWN_MSAL_CODES.has(errorCode) ? errorCode : 'other';
    const entra = aadsts ? `, ${KNOWN_AADSTS_CODES.has(aadsts) ? aadsts : 'AADSTS other'}` : '';
    return `token request refused (${code}${entra}); look the code up in Entra sign-in logs`;
  }
  return 'probe stopped on an unexpected error (details withheld so no tenant value is printed)';
}

type Registration = {
  tenant_id: string;
  ms_tenant_id: string;
  client_id: string;
  cert_thumbprint: string | null;
  cert_secret_ref: string | null;
};

export type ProbeGroupDeps = {
  env?: Record<string, string | undefined>;
  db?: SupabaseClient;
  probe?: typeof probeReaderScope;
  readFile?: (path: string) => string;
  log?: (line: string) => void;
};

function arg(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new ProbeRefusal(`${name} needs a value`);
  return value;
}

/** The Exchange export as object ids and types. Refuses a missing, empty or malformed file; names a line number, never its content. */
export function parseExchangeExport(text: string): Array<{ id: string; type: ExchangeMailboxType }> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const members: Array<{ id: string; type: ExchangeMailboxType }> = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = EXPORT_LINE.exec(line);
    if (!match) throw new ProbeRefusal(`Refusing: line ${index + 1} of the Exchange export is not <object id>,<RecipientTypeDetails>`);
    const type = TYPES.find((name) => name !== 'Other' && name.toLowerCase() === match[2].toLowerCase()) ?? 'Other';
    members.push({ id: match[1].toLowerCase(), type });
  }
  if (members.length === 0) throw new ProbeRefusal('Refusing: the Exchange export is empty');
  return members;
}

function certScheme(ref: string | null): 'env' | 'keyvault' | 'unknown' {
  if (ref?.startsWith('keyvault:')) return 'keyvault';
  if (ref?.startsWith('env:')) return 'env';
  return 'unknown';
}

const yesNo = (value: boolean | null) => (value === null ? 'not checked' : value ? 'yes' : 'no');

type Q1 = 'yes' | 'no' | 'not answered';

function groupLines(result: ScopeProbeResult): { lines: string[]; q1: Q1; report: GroupProbeReport | null } {
  const lines = [`group: status ${withCode(result.status, result.code)}`];
  const report = result.status === 200 && result.group ? result.group : null;
  // A refused or failed listing is a non-answer, not a "no" (audit item 2): a fresh grant can take minutes to apply.
  if (!report) return { lines, q1: 'not answered', report: null };
  lines.push(`group members: users ${report.users}, with mail ${report.withMail}, with UPN ${report.withUpn}, other member types ${report.otherTypes}`);
  for (const type of TYPES) {
    const row = report.byType[type];
    lines.push(`  ${type}: exchange ${row.exchange}, in both ${row.both}, only in Exchange ${row.onlyInExchange}`);
  }
  lines.push(`only in Graph ${report.onlyInGraph}, sets equal ${report.equal ? 'yes' : 'no'}`);
  const q1 = TYPES.every((type) => report.byType[type].onlyInExchange === 0) ? 'yes' : 'no';
  return { lines, q1, report };
}

function checkedLine(report: GroupProbeReport): string {
  const { checked } = report;
  if (!checked) return 'checked member: none (no member in both lists has mail and a UPN)';
  const upn = checked.upnDiffersFromMail ? 'UPN differs from mail' : 'UPN equals mail';
  return `checked member: ${checked.type}, ${upn}; control: ${checked.controlType ?? 'none'}`;
}

export async function main(argv: string[], deps: ProbeGroupDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (isProductionAppEnv(env)) throw new ProbeRefusal('Refusing: the group probe never runs in production');

  const preflightOnly = argv.includes('--preflight-only');
  const tenantId = arg(argv, '--tenant');
  const confirmMsTenant = arg(argv, '--confirm-ms-tenant');
  const groupId = arg(argv, '--group');
  const exportPath = arg(argv, '--exchange-ids');
  const outOfScope = arg(argv, '--out-of-scope');
  const aliasInScope = arg(argv, '--alias-in-scope');
  const aliasOutOfScope = arg(argv, '--alias-out-of-scope');
  if (!tenantId || !confirmMsTenant) throw new ProbeRefusal(USAGE);
  // The out-of-scope check is the scope's own negative control, so a full run always makes it (audit item 5b).
  if (!preflightOnly && (!groupId || !exportPath || !outOfScope)) throw new ProbeRefusal(USAGE);
  if (!GUID.test(tenantId)) throw new ProbeRefusal('Refusing: --tenant must be the Conductia tenant uuid');
  if (!GUID.test(confirmMsTenant)) throw new ProbeRefusal("Refusing: --confirm-ms-tenant must be the bank's Entra tenant id (a GUID)");
  if (groupId !== null && !GUID.test(groupId)) throw new ProbeRefusal("Refusing: --group must be the scope group's object id (a GUID)");

  let exchange: Array<{ id: string; type: ExchangeMailboxType }> = [];
  if (!preflightOnly && exportPath) {
    let exportText: string;
    try {
      exportText = (deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')))(exportPath);
    } catch {
      throw new ProbeRefusal('Refusing: the Exchange export cannot be read');
    }
    exchange = parseExchangeExport(exportText);
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new ProbeRefusal('NEXT_PUBLIC_SUPABASE_URL must be set');
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new ProbeRefusal('NEXT_PUBLIC_SUPABASE_URL is not a URL');
  }
  let db = deps.db;
  if (!db) {
    const key = env.SUPABASE_SECRET_KEY;
    if (!key) throw new ProbeRefusal('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
    db = createClient(url, key, { auth: { persistSession: false } });
  }
  // Checklist step 0: the shell profile can point these at another project, so say which one answered.
  log(`registration read from ${host}`);

  const { data, error } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id, ms_tenant_id, client_id, cert_thumbprint, cert_secret_ref')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  // A PostgREST (PGRST123) or Postgres (SQLSTATE, 5 characters) code only.
  const dbCode = typeof error?.code === 'string' && /^(PGRST\d{3}|[0-9A-Z]{5})$/.test(error.code) ? error.code : 'other';
  if (error) throw new ProbeRefusal(`registration lookup failed (${dbCode})`);
  if (!data) throw new ProbeRefusal('No reader registration for this tenant');
  const registration = data as Registration;
  const scheme = certScheme(registration.cert_secret_ref);
  log(`cert scheme ${scheme}`);
  if (registration.ms_tenant_id.toLowerCase() !== confirmMsTenant.toLowerCase()) {
    throw new ProbeRefusal("Refusing: --confirm-ms-tenant does not match the registration's Entra tenant");
  }

  // Checklist step 0 (audit item 4): stop here, before any token is signed or Graph is called.
  if (preflightOnly) {
    log('Entra tenant matches the registration');
    if (scheme !== 'env') {
      log(`STOP cert scheme ${scheme}: this machine cannot sign for it. Run the probe where the worker runs, and report it.`);
      return 1;
    }
    log('Preflight passed. Nothing was signed and Graph was not called.');
    return 0;
  }

  type Expectation = { label: string; target: ScopeProbeTarget; expected: readonly number[] | null };
  const expectations: Expectation[] = [
    { label: 'out-of-scope by address', target: { kind: 'mailbox', address: outOfScope! }, expected: [403] },
  ];
  if (aliasInScope) expectations.push({ label: 'alias of member', target: { kind: 'mailbox', address: aliasInScope }, expected: null });
  // A non-member alias refused as unknown (404) is refused all the same (audit item 5e).
  if (aliasOutOfScope) expectations.push({ label: 'alias of non-member', target: { kind: 'mailbox', address: aliasOutOfScope }, expected: [403, 404] });

  const targets: ScopeProbeTarget[] = [{ kind: 'group', groupId: groupId!, exchange }, ...expectations.map((e) => e.target)];
  let groupResult: ScopeProbeResult;
  let results: ScopeProbeResult[];
  try {
    [groupResult, ...results] = await (deps.probe ?? probeReaderScope)(
      {
        tenantId: registration.tenant_id,
        msTenantId: registration.ms_tenant_id,
        clientId: registration.client_id,
        certThumbprint: registration.cert_thumbprint,
        certSecretRef: registration.cert_secret_ref,
      },
      targets,
    );
  } catch (failure) {
    throw new ProbeRefusal(safeFailure(failure));
  }

  let failed = 0;
  const { lines, q1, report } = groupLines(groupResult);
  for (const line of lines) log(line);
  log(q1 === 'not answered' ? `Q1: not answered (listing status ${groupResult.status})` : `Q1: ${q1}`);
  if (q1 !== 'yes') failed += 1;
  // Q1 asks whether Graph misses a member Exchange admits; a member only Graph lists does not change it, because the
  // Exchange RBAC scope, not this list, decides which mailboxes Mail.Read reaches. Shown so it is not missed.
  if (report && report.onlyInGraph > 0) {
    log(
      `WARN only in Graph ${report.onlyInGraph}: Graph lists members the Exchange export does not. Q1 is unchanged, since ` +
        'the Exchange scope still decides what is read. Check the export was taken from the same group just now, and report the count',
    );
  }
  // Q1 must cover shared mailboxes, the team inbox shape (audit item 5a).
  if (!exchange.some((member) => member.type === 'SharedMailbox')) {
    log('FAIL the Exchange export has no SharedMailbox: add one to the group, export again and rerun (checklist step 3)');
    failed += 1;
  }
  // The group mirror (#591) refuses a group in which any member has no UPN, or no member has mail: every live pass
  // would then show "Group unreadable", whatever Q1 says (#590-#593 audit, item 3).
  // No user listed at all: an empty group, or a role that returns no user objects. The mirror would then bind nothing,
  // so every allowlisted address would show as missing and no mailbox would be read.
  if (report && report.users === 0) {
    log(
      'WARN no users listed: Graph returned no user members for the group, so the mirror would read no mailbox. ' +
        'Check the --group id and the granted role (checklist steps 2 and 3), then rerun',
    );
    failed += 1;
  } else if (report && (report.withUpn < report.users || report.withMail === 0)) {
    log(
      `WARN with UPN ${report.withUpn} of ${report.users} users, with mail ${report.withMail}: the group mirror needs a UPN on ` +
        'every member and mail on at least one, or it reads no mailbox. Grant User.ReadBasic.All (checklist step 5) and rerun before going on',
    );
    failed += 1;
  }
  if (report) {
    log(`binding hazards: UPN differs from mail ${report.upnDiffersFromMail}, UPN equals another member's mail ${report.upnEqualsOtherMail}`);
    log(checkedLine(report));
    log(`same mailbox by UPN and id: ${yesNo(report.sameMailboxByUpnAndId)}`);
    log(`different members differ: ${yesNo(report.differentMembersDiffer)}`);
    log(`link key form: ${report.linkKeyForm ?? 'not checked'}`);
    if (report.checkStatus !== null) log(`a check request failed with status ${report.checkStatus}`);
    if (report.sameMailboxByUpnAndId !== true) failed += 1;
    if (report.differentMembersDiffer !== true) failed += 1;
    if (report.linkKeyForm !== 'upn' && report.linkKeyForm !== 'id') failed += 1;
  }

  for (const [index, expectation] of expectations.entries()) {
    const { status, code } = results[index];
    const shown = withCode(status, code);
    if (expectation.expected === null) {
      log(`INFO ${expectation.label}: ${shown}`);
      continue;
    }
    const ok = expectation.expected.includes(status);
    if (!ok) failed += 1;
    log(`${ok ? 'PASS' : 'FAIL'} ${expectation.label}: ${shown} (expected ${expectation.expected.join(' or ')})`);
  }

  if (failed > 0) {
    log(`${failed} answer(s) need attention. Paste this output back before the next slice is built.`);
    return 1;
  }
  log('Every answer is the expected one.');
  return 0;
}

if (process.argv[1]?.endsWith('probe-group-mirror.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(safeFailure(error));
      process.exit(1);
    },
  );
}
