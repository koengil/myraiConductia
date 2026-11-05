// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkGcpPolicy, checkGcpPolicyMain, type IamPolicy, type PolicyCheckInput } from '../../scripts/infra/check-gcp-policy';

/*
 * scripts/infra/check-gcp-policy.ts (#344, design R7; gate G6): the two service
 * accounts' IAM policies must hold exactly the entries the signing mode allows.
 * Fixtures are get-iam-policy JSON for both modes. Member identities are built
 * from fragments and must never reach the output.
 */

const PROJECT = 'ignatious-reader';
const P = `principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/conductia-worker/attribute.aws_role/arn:aws:sts::123456789012:assumed-role/conductia-discovery-worker`;
const SA_DWD = ['sa-dwd', `${PROJECT}.iam.gserviceaccount.com`].join('@');
const SIGN_ROLE = `projects/${PROJECT}/roles/signJwtOnly`;
const WIU = 'roles/iam.workloadIdentityUser';
const TOKEN_CREATOR = 'roles/iam.serviceAccountTokenCreator';
const CANARY_USER = ['user:canary', 'bank.example'].join('@');

const policy = (...bindings: { role: string; members: string[]; condition?: unknown }[]): IamPolicy => ({
  bindings,
  // gcloud prints these too; the checker ignores them.
  ...{ etag: 'BwYabc', version: 1 },
});

const DIRECT = {
  saDwdPolicy: policy({ role: SIGN_ROLE, members: [P] }),
  saDirectoryPolicy: policy({ role: WIU, members: [P] }),
};
const SELF = {
  saDwdPolicy: policy({ role: WIU, members: [P] }, { role: SIGN_ROLE, members: [`serviceAccount:${SA_DWD}`] }),
  saDirectoryPolicy: policy({ role: WIU, members: [P] }),
};

const run = (mode: 'direct' | 'self', policies: Pick<PolicyCheckInput, 'saDwdPolicy' | 'saDirectoryPolicy'>, extra: Partial<PolicyCheckInput> = {}) =>
  checkGcpPolicy({ mode, principalSet: P, saDwdEmail: SA_DWD, ...policies, ...extra });

function expectNoIdentity(lines: string[]): void {
  const text = lines.join('\n');
  for (const secretish of [P, SA_DWD, CANARY_USER, '123456789012']) expect(text).not.toContain(secretish);
}

describe('check-gcp-policy: exact match per signing mode', () => {
  it('passes the direct policy in direct mode', () => {
    const result = run('direct', DIRECT);
    expect(result.ok).toBe(true);
    expect(result.lines.at(-1)).toMatch(/^PASS/);
    expectNoIdentity(result.lines);
  });

  it('passes the self policy in self mode', () => {
    const result = run('self', SELF);
    expect(result.ok).toBe(true);
    expectNoIdentity(result.lines);
  });

  it('passes with an exact --sign-role and its one-permission definition', () => {
    const result = run('direct', DIRECT, {
      signRole: SIGN_ROLE,
      signRoleDefinition: { name: SIGN_ROLE, includedPermissions: ['iam.serviceAccounts.signJwt'] },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty sa-directory policy only as a failure (the entry is missing)', () => {
    const result = run('direct', { ...DIRECT, saDirectoryPolicy: { etag: 'ACAB' } as IamPolicy });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('sa-directory FAIL missing');
  });
});

describe('check-gcp-policy: every deviation fails', () => {
  it('fails an extra member, and prints its kind but not its identity', () => {
    const result = run('direct', {
      ...DIRECT,
      saDwdPolicy: policy({ role: SIGN_ROLE, members: [P, CANARY_USER] }),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('sa-dwd FAIL extra: user (other)');
    expectNoIdentity(result.lines);
  });

  it('fails serviceAccountTokenCreator in place of signJwtOnly, in either mode', () => {
    const direct = run('direct', { ...DIRECT, saDwdPolicy: policy({ role: TOKEN_CREATOR, members: [P] }) });
    expect(direct.ok).toBe(false);
    expect(direct.lines.join('\n')).toContain(`FAIL extra: principalSet (P) ${TOKEN_CREATOR}`);
    const self = run('self', {
      ...SELF,
      saDwdPolicy: policy({ role: WIU, members: [P] }, { role: TOKEN_CREATOR, members: [`serviceAccount:${SA_DWD}`] }),
    });
    expect(self.ok).toBe(false);
  });

  it('fails a self-grant made to P instead of to sa-dwd', () => {
    const result = run('self', {
      ...SELF,
      saDwdPolicy: policy({ role: WIU, members: [P] }, { role: SIGN_ROLE, members: [P] }),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('missing: serviceAccount (sa-dwd itself) signJwtOnly');
  });

  it("fails the other mode's policy in each mode", () => {
    expect(run('direct', SELF).ok).toBe(false);
    expect(run('self', DIRECT).ok).toBe(false);
  });

  it('fails Token Creator on sa-directory, and a conditional binding', () => {
    expect(run('direct', { ...DIRECT, saDirectoryPolicy: policy({ role: TOKEN_CREATOR, members: [P] }) }).ok).toBe(false);
    const conditional = run('direct', {
      ...DIRECT,
      saDirectoryPolicy: policy({ role: WIU, members: [P], condition: { expression: 'true', title: 'x' } }),
    });
    expect(conditional.ok).toBe(false);
    expect(conditional.lines.join('\n')).toContain('(conditional binding)');
  });

  it('fails a signing role whose definition holds more than signJwt', () => {
    const result = run('direct', DIRECT, {
      signRoleDefinition: { name: SIGN_ROLE, includedPermissions: ['iam.serviceAccounts.signJwt', 'iam.serviceAccounts.signBlob'] },
    });
    expect(result.ok).toBe(false);
  });

  it('fails a malformed principalSet and self mode without the sa-dwd email', () => {
    expect(run('direct', DIRECT, { principalSet: 'principal://x' }).ok).toBe(false);
    expect(run('self', SELF, { saDwdEmail: undefined }).ok).toBe(false);
  });

  it('fails a file that is not get-iam-policy JSON', () => {
    expect(run('direct', { ...DIRECT, saDwdPolicy: { bindings: 'nope' } as unknown as IamPolicy }).ok).toBe(false);
  });
});

describe('check-gcp-policy: the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-policy-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it('exits 0 on an exact match and 1 on a deviation, printing no identity', () => {
    const dwd = file('dwd.json', DIRECT.saDwdPolicy);
    const directory = file('directory.json', DIRECT.saDirectoryPolicy);
    const lines: string[] = [];
    expect(checkGcpPolicyMain(['--mode', 'direct', '--principal-set', P, '--sa-dwd', dwd, '--sa-directory', directory], (l) => lines.push(l))).toBe(0);
    expect(checkGcpPolicyMain(['--mode', 'self', '--principal-set', P, '--sa-dwd-email', SA_DWD, '--sa-dwd', dwd, '--sa-directory', directory], (l) => lines.push(l))).toBe(1);
    expectNoIdentity(lines);
  });

  it('exits 2 on a usage error', () => {
    const lines: string[] = [];
    expect(checkGcpPolicyMain(['--mode', 'both'], (l) => lines.push(l))).toBe(2);
    expect(checkGcpPolicyMain(['--mode', 'direct', '--principal-set', P, '--sa-dwd', join(dir, 'absent.json'), '--sa-directory', join(dir, 'absent.json')], (l) => lines.push(l))).toBe(2);
  });
});
