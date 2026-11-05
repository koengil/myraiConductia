import { readFileSync } from 'node:fs';

// Checks the two Google service accounts' IAM policies against the exact
// entries design R7 allows for the signing mode in use (go-live gate G6). The
// owner runs it at runbook step 8, on `gcloud ... get-iam-policy --format=json`
// output saved to files:
//
//   node --import tsx scripts/infra/check-gcp-policy.ts --mode direct|self \
//     --principal-set <P> --sa-dwd <sa-dwd policy.json> --sa-directory <sa-directory policy.json> \
//     [--sa-dwd-email <sa-dwd email>] [--sign-role <role>] [--sign-role-definition <role.json>]
//
// P is the federation principalSet
// (principalSet://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/conductia-worker/attribute.aws_role/...).
// --sa-dwd-email is required in self mode (the self-grant names sa-dwd and
// nothing else). The signing role is the custom role holding exactly
// iam.serviceAccounts.signJwt: by default any projects/<id>/roles/signJwtOnly or
// organizations/<id>/roles/signJwtOnly; --sign-role names it exactly, and
// --sign-role-definition (`gcloud iam roles describe ... --format=json`) proves it
// holds that one permission.
//
// The allowed entries, per service account, and nothing else:
//   direct  sa-dwd        P                       signJwtOnly
//           sa-directory  P                       roles/iam.workloadIdentityUser
//   self    sa-dwd        P                       roles/iam.workloadIdentityUser
//           sa-dwd        serviceAccount:sa-dwd   signJwtOnly
//           sa-directory  P                       roles/iam.workloadIdentityUser
//
// Prints roles and member kinds only, never a member's identity. Exits 0 on an
// exact match, 1 on any missing or extra entry, 2 on a usage error.

export type SigningMode = 'direct' | 'self';

/** The JSON shape `gcloud iam service-accounts get-iam-policy --format=json` prints. */
export type IamPolicy = {
  bindings?: { role?: unknown; members?: unknown; condition?: unknown }[];
};

export type RoleDefinition = { name?: unknown; includedPermissions?: unknown };

export type PolicyCheckInput = {
  mode: SigningMode;
  principalSet: string;
  /** sa-dwd's email; the self-grant member. Required in self mode. */
  saDwdEmail?: string;
  /** The signing role's exact name; else any projects/<id>/roles/signJwtOnly or organizations/<id>/roles/signJwtOnly. */
  signRole?: string;
  saDwdPolicy: IamPolicy;
  saDirectoryPolicy: IamPolicy;
  /** `gcloud iam roles describe` output for the signing role, when given. */
  signRoleDefinition?: RoleDefinition;
};

export type PolicyCheckResult = { ok: boolean; lines: string[] };

const WORKLOAD_IDENTITY_USER = 'roles/iam.workloadIdentityUser';
const SIGN_JWT = 'iam.serviceAccounts.signJwt';
const DEFAULT_SIGN_ROLE = /^(projects|organizations)\/[a-z0-9-]+\/roles\/signJwtOnly$/;
const PRINCIPAL_SET = /^principalSet:\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/\S+$/;

type Expected = { member: 'P' | 'self'; role: 'workloadIdentityUser' | 'signRole' };
type Entry = { member: string; role: string; conditional: boolean };

const EXPECTED: Record<SigningMode, { saDwd: Expected[]; saDirectory: Expected[] }> = {
  direct: {
    saDwd: [{ member: 'P', role: 'signRole' }],
    saDirectory: [{ member: 'P', role: 'workloadIdentityUser' }],
  },
  self: {
    saDwd: [
      { member: 'P', role: 'workloadIdentityUser' },
      { member: 'self', role: 'signRole' },
    ],
    saDirectory: [{ member: 'P', role: 'workloadIdentityUser' }],
  },
};

/** A member's kind for printing: its prefix, never its identity. */
function memberKind(member: string, input: PolicyCheckInput): string {
  if (member === input.principalSet) return 'principalSet (P)';
  if (input.saDwdEmail && member === `serviceAccount:${input.saDwdEmail}`) return 'serviceAccount (sa-dwd itself)';
  const prefix = /^([A-Za-z]+):/.exec(member);
  return prefix ? `${prefix[1]} (other)` : 'unrecognised member';
}

/** A role for printing: a predefined role or a custom role path, else a fixed word. */
function roleLabel(role: string): string {
  return /^(roles|projects\/[a-z0-9-]+\/roles|organizations\/[0-9]+\/roles)\/[A-Za-z0-9_.]+$/.test(role) ? role : 'unrecognised role';
}

function entriesOf(policy: IamPolicy): Entry[] | null {
  if (!policy || typeof policy !== 'object') return null;
  if (policy.bindings === undefined) return [];
  if (!Array.isArray(policy.bindings)) return null;
  const entries: Entry[] = [];
  for (const binding of policy.bindings) {
    if (!binding || typeof binding.role !== 'string' || !Array.isArray(binding.members)) return null;
    for (const member of binding.members) {
      if (typeof member !== 'string') return null;
      entries.push({ member, role: binding.role, conditional: binding.condition !== undefined && binding.condition !== null });
    }
  }
  return entries;
}

function matches(entry: Entry, expected: Expected, input: PolicyCheckInput): boolean {
  if (entry.conditional) return false;
  const member = expected.member === 'P' ? input.principalSet : `serviceAccount:${input.saDwdEmail}`;
  if (entry.member !== member) return false;
  if (expected.role === 'workloadIdentityUser') return entry.role === WORKLOAD_IDENTITY_USER;
  return input.signRole ? entry.role === input.signRole : DEFAULT_SIGN_ROLE.test(entry.role);
}

function expectedLabel(expected: Expected): string {
  const member = expected.member === 'P' ? 'principalSet (P)' : 'serviceAccount (sa-dwd itself)';
  const role = expected.role === 'workloadIdentityUser' ? WORKLOAD_IDENTITY_USER : 'signJwtOnly';
  return `${member} ${role}`;
}

function checkAccount(name: string, policy: IamPolicy, expected: Expected[], input: PolicyCheckInput, lines: string[]): boolean {
  const entries = entriesOf(policy);
  if (!entries) {
    lines.push(`${name} FAIL: the policy file is not get-iam-policy JSON`);
    return false;
  }
  let ok = true;
  const used = new Set<number>();
  for (const want of expected) {
    const index = entries.findIndex((entry, i) => !used.has(i) && matches(entry, want, input));
    if (index === -1) {
      lines.push(`${name} FAIL missing: ${expectedLabel(want)}`);
      ok = false;
    } else {
      used.add(index);
      lines.push(`${name} ok: ${expectedLabel(want)}`);
    }
  }
  entries.forEach((entry, i) => {
    if (used.has(i)) return;
    ok = false;
    const condition = entry.conditional ? ' (conditional binding)' : '';
    lines.push(`${name} FAIL extra: ${memberKind(entry.member, input)} ${roleLabel(entry.role)}${condition}`);
  });
  return ok;
}

function checkSignRoleDefinition(definition: RoleDefinition, input: PolicyCheckInput, lines: string[]): boolean {
  const permissions = definition.includedPermissions;
  const name = typeof definition.name === 'string' ? definition.name : '';
  const nameOk = input.signRole ? name === input.signRole : DEFAULT_SIGN_ROLE.test(name);
  const exact = Array.isArray(permissions) && permissions.length === 1 && permissions[0] === SIGN_JWT;
  if (nameOk && exact) {
    lines.push(`signing role ok: ${roleLabel(name)} holds exactly ${SIGN_JWT}`);
    return true;
  }
  if (!nameOk) lines.push('signing role FAIL: the definition is not the signing role checked above');
  if (!exact) lines.push(`signing role FAIL: it must hold exactly ${SIGN_JWT} and nothing else`);
  return false;
}

/** The check itself, pure: the CLI reads the files and prints the lines. */
export function checkGcpPolicy(input: PolicyCheckInput): PolicyCheckResult {
  const lines: string[] = [`mode ${input.mode}`];
  if (!PRINCIPAL_SET.test(input.principalSet)) {
    return { ok: false, lines: [...lines, 'FAIL: --principal-set is not a workload identity pool principalSet'] };
  }
  if (input.mode === 'self' && !input.saDwdEmail) {
    return { ok: false, lines: [...lines, 'FAIL: self mode needs --sa-dwd-email (the self-grant names sa-dwd)'] };
  }
  const expected = EXPECTED[input.mode];
  const dwd = checkAccount('sa-dwd', input.saDwdPolicy, expected.saDwd, input, lines);
  const directory = checkAccount('sa-directory', input.saDirectoryPolicy, expected.saDirectory, input, lines);
  const role = input.signRoleDefinition ? checkSignRoleDefinition(input.signRoleDefinition, input, lines) : true;
  if (!input.signRoleDefinition) lines.push('signing role: definition not given (pass --sign-role-definition to prove it holds signJwt only)');
  const ok = dwd && directory && role;
  lines.push(ok ? 'PASS: exactly the allowed entries for this mode' : 'FAIL: the policies differ from the allowed entries for this mode');
  return { ok, lines };
}

class UsageError extends Error {}

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

function readJson(path: string, flag: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new UsageError(`${flag}: the file could not be read as JSON`);
  }
}

/** The CLI. Returns the exit code. */
export function checkGcpPolicyMain(argv: string[], log: (line: string) => void = (line) => console.log(line)): number {
  try {
    const mode = arg(argv, '--mode');
    if (mode !== 'direct' && mode !== 'self') throw new UsageError('--mode must be direct or self');
    const principalSet = arg(argv, '--principal-set');
    const saDwd = arg(argv, '--sa-dwd');
    const saDirectory = arg(argv, '--sa-directory');
    if (!principalSet || !saDwd || !saDirectory) throw new UsageError('--principal-set, --sa-dwd and --sa-directory are required');
    const definitionPath = arg(argv, '--sign-role-definition');
    const result = checkGcpPolicy({
      mode,
      principalSet,
      saDwdEmail: arg(argv, '--sa-dwd-email'),
      signRole: arg(argv, '--sign-role'),
      saDwdPolicy: readJson(saDwd, '--sa-dwd') as IamPolicy,
      saDirectoryPolicy: readJson(saDirectory, '--sa-directory') as IamPolicy,
      signRoleDefinition: definitionPath ? (readJson(definitionPath, '--sign-role-definition') as RoleDefinition) : undefined,
    });
    for (const line of result.lines) log(line);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      log(`usage: ${error.message}`);
      return 2;
    }
    log('FAIL: internal error');
    return 1;
  }
}

if (process.argv[1]?.endsWith('check-gcp-policy.ts')) {
  process.exitCode = checkGcpPolicyMain(process.argv.slice(2));
}
