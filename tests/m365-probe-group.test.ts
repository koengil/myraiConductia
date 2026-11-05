// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { GraphHttpError } from '../src/lib/graph/http';
import type { GroupProbeReport, ScopeProbeResult, ScopeProbeTarget } from '../src/lib/graph/reader/probe';
import { main, parseExchangeExport, printableGraphCode, ProbeRefusal, safeFailure, type ProbeGroupDeps } from '../scripts/m365/probe-group-mirror';

/*
 * The owner's group probe script (#275, design R9 and the Oct 19 checklist),
 * with the database, the probe and the export file injected: no network. Every
 * refusal fires before the probe is asked anything, --preflight-only stops
 * before any signing, a failure prints only a fixed category and codes, and
 * the output carries no address, no name and no id.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const MS_TENANT = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const STORM_ID = '44444444-4444-4444-8444-444444444444';
const DEALS_ID = '55555555-5555-4555-8555-555555555555';
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EXPORT = `${STORM_ID},UserMailbox\n${DEALS_ID},SharedMailbox\n`;

const registration = (over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  ms_tenant_id: MS_TENANT,
  client_id: '66666666-6666-4666-8666-666666666666',
  cert_thumbprint: 'ab'.repeat(32),
  cert_secret_ref: 'env:GRAPH_READER_CERT_PEM',
  ...over,
});

function fakeDb(row: unknown = registration()) {
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
  }));
  return { db: { from } as unknown as SupabaseClient, from };
}

const zero = { exchange: 0, both: 0, onlyInExchange: 0 };
const report = (over: Partial<GroupProbeReport> = {}): GroupProbeReport => ({
  users: 2,
  withMail: 2,
  withUpn: 2,
  otherTypes: 1,
  byType: {
    UserMailbox: { exchange: 1, both: 1, onlyInExchange: 0 },
    SharedMailbox: { exchange: 1, both: 1, onlyInExchange: 0 },
    RoomMailbox: zero,
    EquipmentMailbox: zero,
    Other: zero,
  },
  onlyInGraph: 0,
  equal: true,
  upnDiffersFromMail: 1,
  upnEqualsOtherMail: 0,
  sameMailboxByUpnAndId: true,
  differentMembersDiffer: true,
  linkKeyForm: 'upn',
  checkStatus: null,
  checked: { type: 'SharedMailbox', upnDiffersFromMail: true, controlType: 'UserMailbox' },
  ...over,
});

const ARGS = [
  '--tenant', TENANT, '--confirm-ms-tenant', MS_TENANT, '--group', GROUP, '--exchange-ids', '/outside/exchange-ids.txt',
  '--out-of-scope', 'outsider@bank.example',
];
const ALIASES = ['--alias-in-scope', 'sd@bank.example', '--alias-out-of-scope', 'alias@bank.example'];
const PREFLIGHT = ['--tenant', TENANT, '--confirm-ms-tenant', MS_TENANT, '--preflight-only'];

function setup(over: Partial<ProbeGroupDeps> & { results?: ScopeProbeResult[]; row?: unknown } = {}) {
  const lines: string[] = [];
  const { db, from } = fakeDb(over.row);
  const results = over.results ?? [{ status: 200, code: null, group: report() }, { status: 403, code: 'ErrorAccessDenied' }, { status: 200, code: null }, { status: 403, code: null }];
  // A target with no scripted result is refused, as the out-of-scope mailbox should be.
  const probe = vi.fn(async (_registration: unknown, targets: readonly ScopeProbeTarget[]) =>
    targets.map((_, i) => results[i] ?? { status: 403, code: 'ErrorAccessDenied' }),
  );
  const deps: ProbeGroupDeps = {
    env: { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdproject.supabase.co', SUPABASE_SECRET_KEY: 'service-key' },
    db,
    probe: probe as unknown as ProbeGroupDeps['probe'],
    readFile: () => EXPORT,
    log: (line) => lines.push(line),
    ...over,
  };
  return { deps, lines, probe, from };
}

describe('the group probe script refuses before any Graph call', () => {
  it.each([
    ['production', { env: { NEXT_PUBLIC_APP_ENV: ' Production ', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'k' } }, ARGS, /production/],
    ['a missing --group', {}, ARGS.filter((_, i) => i !== 4 && i !== 5), /Usage/],
    ['a missing --out-of-scope', {}, ARGS.slice(0, 8), /Usage/],
    ['a missing --confirm-ms-tenant in preflight', {}, PREFLIGHT.slice(0, 2).concat('--preflight-only'), /Usage/],
    ['a --group that is not a GUID', {}, ARGS.map((a) => (a === GROUP ? 'deal-group@bank.example' : a)), /--group must be/],
    ['a --tenant that is not a uuid', {}, ARGS.map((a) => (a === TENANT ? 'tidewell' : a)), /--tenant must be/],
    ['a flag with no value', {}, [...ARGS, '--alias-in-scope'], /--alias-in-scope needs a value/],
    ['an unreadable export', { readFile: () => { throw new Error('ENOENT'); } }, ARGS, /export cannot be read/],
    ['an empty export', { readFile: () => '\n\n' }, ARGS, /export is empty/],
    ['a malformed export line', { readFile: () => `${STORM_ID},UserMailbox\nstorm.duncan@bank.example,UserMailbox\n` }, ARGS, /line 2 of the Exchange export/],
    ['a mismatched Entra tenant', { row: registration({ ms_tenant_id: '77777777-7777-4777-8777-777777777777' }) }, ARGS, /does not match/],
    ['no registration', { row: null }, ARGS, /No reader registration/],
  ])('refuses %s', async (_name, over, argv, message) => {
    const { deps, probe, lines } = setup(over as Parameters<typeof setup>[0]);
    const error = await main(argv, deps).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(message);
    expect(probe).not.toHaveBeenCalled();
    // A refusal names no value it was given.
    expect(`${error?.message} ${lines.join('\n')}`).not.toContain('@');
    expect(`${error?.message}`).not.toMatch(GUID);
  });

  it('refuses production before it reads the registration', async () => {
    const { deps, from } = setup({ env: { NEXT_PUBLIC_APP_ENV: 'prod', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'k' } });
    await expect(main(ARGS, deps)).rejects.toThrow(/production/);
    expect(from).not.toHaveBeenCalled();
  });

  it('accepts the Entra tenant in another case', async () => {
    const { deps, probe } = setup();
    const argv = ARGS.map((a) => (a === MS_TENANT ? MS_TENANT.toUpperCase() : a));
    await expect(main(argv, deps)).resolves.toBe(0);
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe('the Exchange export', () => {
  it('reads id,type lines with a BOM, CRLF and blank lines, mapping unknown types to Other', () => {
    const text = `﻿${STORM_ID.toUpperCase()},UserMailbox\r\n${DEALS_ID},sharedmailbox\r\n\r\n${GROUP},SchedulingMailbox\r\n`;
    expect(parseExchangeExport(text)).toEqual([
      { id: STORM_ID, type: 'UserMailbox' },
      { id: DEALS_ID, type: 'SharedMailbox' },
      { id: GROUP, type: 'Other' },
    ]);
  });

  it.each([`${STORM_ID}`, `${STORM_ID},User Mailbox`, `${STORM_ID},UserMailbox,extra`, 'not-a-guid,UserMailbox'])('refuses the line %s', (line) => {
    expect(() => parseExchangeExport(line)).toThrow(/line 1 of the Exchange export/);
  });
});

describe('the group probe script output', () => {
  it('prints the Supabase host and the certificate scheme first', async () => {
    const { deps, lines } = setup();
    await main(ARGS, deps);
    expect(lines.slice(0, 2)).toEqual(['registration read from abcdproject.supabase.co', 'cert scheme env']);
  });

  it('names a keyvault certificate and still probes in a full run (where the worker runs)', async () => {
    const { deps, lines, probe } = setup({ row: registration({ cert_secret_ref: 'keyvault:https://vault.example/keys/reader/1' }) });
    await expect(main(ARGS, deps)).resolves.toBe(0);
    expect(lines).toContain('cert scheme keyvault');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('stops a preflight before any signing or Graph call, and passes on an env certificate', async () => {
    const readFile = vi.fn(() => EXPORT);
    const { deps, lines, probe } = setup({ readFile });
    await expect(main(PREFLIGHT, deps)).resolves.toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'registration read from abcdproject.supabase.co',
      'cert scheme env',
      'Entra tenant matches the registration',
      'Preflight passed. Nothing was signed and Graph was not called.',
    ]);
  });

  it.each(['keyvault:https://vault.example/keys/reader/1', 'pem-in-a-file'])('stops a preflight, exit 1, on the cert scheme of %s', async (ref) => {
    const { deps, lines, probe } = setup({ row: registration({ cert_secret_ref: ref }) });
    await expect(main(PREFLIGHT, deps)).resolves.toBe(1);
    expect(probe).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatch(/^STOP cert scheme (keyvault|unknown): this machine cannot sign for it\. Run the probe where the worker runs/);
  });

  it('still refuses a mismatched Entra tenant in a preflight', async () => {
    const { deps } = setup({ row: registration({ ms_tenant_id: '77777777-7777-4777-8777-777777777777' }) });
    await expect(main(PREFLIGHT, deps)).rejects.toThrow(/does not match/);
  });

  it('sends the group target first, with the parsed export, then the mailbox targets', async () => {
    const { deps, probe } = setup();
    await main([...ARGS, ...ALIASES], deps);
    const [reg, targets] = probe.mock.calls[0];
    expect(reg).toEqual({
      tenantId: TENANT,
      msTenantId: MS_TENANT,
      clientId: '66666666-6666-4666-8666-666666666666',
      certThumbprint: 'ab'.repeat(32),
      certSecretRef: 'env:GRAPH_READER_CERT_PEM',
    });
    expect(targets).toEqual([
      { kind: 'group', groupId: GROUP, exchange: [{ id: STORM_ID, type: 'UserMailbox' }, { id: DEALS_ID, type: 'SharedMailbox' }] },
      { kind: 'mailbox', address: 'outsider@bank.example' },
      { kind: 'mailbox', address: 'sd@bank.example' },
      { kind: 'mailbox', address: 'alias@bank.example' },
    ]);
  });

  it('prints the group block, the verdict and every answer, and exits 0 when each is expected', async () => {
    const { deps, lines } = setup();
    await expect(main([...ARGS, ...ALIASES], deps)).resolves.toBe(0);
    expect(lines).toEqual([
      'registration read from abcdproject.supabase.co',
      'cert scheme env',
      'group: status 200',
      'group members: users 2, with mail 2, with UPN 2, other member types 1',
      '  UserMailbox: exchange 1, in both 1, only in Exchange 0',
      '  SharedMailbox: exchange 1, in both 1, only in Exchange 0',
      '  RoomMailbox: exchange 0, in both 0, only in Exchange 0',
      '  EquipmentMailbox: exchange 0, in both 0, only in Exchange 0',
      '  Other: exchange 0, in both 0, only in Exchange 0',
      'only in Graph 0, sets equal yes',
      'Q1: yes',
      "binding hazards: UPN differs from mail 1, UPN equals another member's mail 0",
      'checked member: SharedMailbox, UPN differs from mail; control: UserMailbox',
      'same mailbox by UPN and id: yes',
      'different members differ: yes',
      'link key form: upn',
      'PASS out-of-scope by address: 403 ErrorAccessDenied (expected 403)',
      'INFO alias of member: 200',
      'PASS alias of non-member: 403 (expected 403 or 404)',
      'Every answer is the expected one.',
    ]);
  });

  it('never prints an address or an id', async () => {
    const { deps, lines } = setup();
    await main([...ARGS, ...ALIASES], deps);
    const text = lines.join('\n');
    expect(text).not.toContain('@');
    expect(text).not.toMatch(GUID);
  });

  it('answers Q1 no, and exits 1, when a shared mailbox is only in Exchange', async () => {
    const byType = { ...report().byType, SharedMailbox: { exchange: 1, both: 0, onlyInExchange: 1 } };
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report({ byType, equal: false }) }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain('  SharedMailbox: exchange 1, in both 0, only in Exchange 1');
    expect(lines).toContain('Q1: no');
  });

  it('answers Q1 yes when Graph lists an extra member but no Exchange member is missing', async () => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report({ onlyInGraph: 1, equal: false }) }] });
    await expect(main(ARGS, deps)).resolves.toBe(0);
    expect(lines).toContain('only in Graph 1, sets equal no');
    expect(lines).toContain('Q1: yes');
    // Informational, not a failure: the Exchange scope still decides what is read.
    expect(lines.find((l) => l.startsWith('WARN only in Graph'))).toMatch(/^WARN only in Graph 1: Graph lists members the Exchange export does not\. Q1 is unchanged/);
  });

  it('prints no WARN line when no member is only in Graph', async () => {
    const { deps, lines } = setup();
    await main(ARGS, deps);
    expect(lines.some((l) => l.startsWith('WARN'))).toBe(false);
  });

  it.each([403, 429, 503])('answers Q1 not answered, not no, when the listing returns %s, and prints no group block', async (status) => {
    const { deps, lines } = setup({ results: [{ status, code: 'Authorization_RequestDenied' }, { status: 403, code: null }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain(`group: status ${status} Authorization_RequestDenied`);
    expect(lines).toContain(`Q1: not answered (listing status ${status})`);
    expect(lines).not.toContain('Q1: no');
    expect(lines.some((l) => l.startsWith('same mailbox'))).toBe(false);
  });

  it.each([
    ['the UPN reaches another inbox', { sameMailboxByUpnAndId: false }, 'same mailbox by UPN and id: no'],
    ['two members share an inbox id', { differentMembersDiffer: false }, 'different members differ: no'],
    ['the link key is another form', { linkKeyForm: 'other' as const }, 'link key form: other'],
    ['no member has mail', { withMail: 0, sameMailboxByUpnAndId: null, differentMembersDiffer: null, linkKeyForm: null }, 'same mailbox by UPN and id: not checked'],
  ])('exits 1 when %s', async (_name, over, line) => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report(over) }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain(line);
  });

  it('fails, and exits 1, when the Exchange export holds no shared mailbox', async () => {
    const { deps, lines } = setup({ readFile: () => `${STORM_ID},UserMailbox\n` });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain('FAIL the Exchange export has no SharedMailbox: add one to the group, export again and rerun (checklist step 3)');
  });

  it.each([
    ['one member without a UPN', { users: 2, withUpn: 1, withMail: 2 }, 'WARN with UPN 1 of 2 users, with mail 2'],
    ['no member with mail', { users: 2, withUpn: 2, withMail: 0 }, 'WARN with UPN 2 of 2 users, with mail 0'],
  ])('warns, and exits 1, when %s, since the mirror would read no mailbox', async (_name, over, line) => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report(over) }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines.find((l) => l.startsWith('WARN with UPN'))).toMatch(new RegExp(`^${line}: the group mirror needs a UPN on every member`));
    expect(lines).toContain('Q1: yes');
  });

  it('warns no users listed, and exits 1, when Graph lists no user member at all', async () => {
    const group = report({ users: 0, withUpn: 0, withMail: 0, checked: null, sameMailboxByUpnAndId: null, differentMembersDiffer: null, linkKeyForm: null });
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines.find((l) => l.startsWith('WARN no users listed'))).toMatch(/^WARN no users listed: Graph returned no user members for the group/);
    expect(lines.some((l) => l.startsWith('WARN with UPN'))).toBe(false);
  });

  it('does not warn when every member has a UPN and some have mail', async () => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report({ users: 2, withUpn: 2, withMail: 1 }) }] });
    await main(ARGS, deps);
    expect(lines.some((l) => l.startsWith('WARN with UPN'))).toBe(false);
  });

  it('names the checked member by type only, and says when none was checked', async () => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report({ checked: null, sameMailboxByUpnAndId: null }) }, { status: 403, code: null }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain('checked member: none (no member in both lists has mail and a UPN)');
  });

  it('passes a non-member alias refused as 404', async () => {
    const results: ScopeProbeResult[] = [{ status: 200, code: null, group: report() }, { status: 403, code: null }, { status: 200, code: null }, { status: 404, code: 'ErrorInvalidUser' }];
    const { deps, lines } = setup({ results });
    await expect(main([...ARGS, ...ALIASES], deps)).resolves.toBe(0);
    expect(lines).toContain('PASS alias of non-member: 404 ErrorInvalidUser (expected 403 or 404)');
  });

  it('says which status stopped a check', async () => {
    const { deps, lines } = setup({ results: [{ status: 200, code: null, group: report({ sameMailboxByUpnAndId: null, checkStatus: 403 }) }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain('a check request failed with status 403');
  });

  it('fails, and exits 1, when an out-of-scope mailbox or a non-member alias is readable', async () => {
    const results: ScopeProbeResult[] = [{ status: 200, code: null, group: report() }, { status: 200, code: null }, { status: 200, code: null }, { status: 200, code: null }];
    const { deps, lines } = setup({ results });
    await expect(main([...ARGS, ...ALIASES], deps)).resolves.toBe(1);
    expect(lines).toContain('FAIL out-of-scope by address: 200 (expected 403)');
    expect(lines).toContain('FAIL alias of non-member: 200 (expected 403 or 404)');
    expect(lines).toContain('INFO alias of member: 200');
  });
});

describe('a failure prints a fixed category and codes only (audit item 1)', () => {
  const CLIENT_ID = '66666666-6666-4666-8666-666666666666';

  it('turns a rejected token request naming the app and the directory into its codes', async () => {
    // As MSAL throws it: errorCode, plus an Entra message that quotes the client id and the directory name.
    const rejected = Object.assign(
      new Error(`invalid_client: AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory 'Tidewell Pike Advisors'.`),
      { errorCode: 'invalid_client', errorMessage: `AADSTS700016: Application with identifier '${CLIENT_ID}' was not found in the directory 'Tidewell Pike Advisors'.` },
    );
    const { deps, lines } = setup({ probe: vi.fn(async () => { throw rejected; }) as unknown as ProbeGroupDeps['probe'] });
    const error = await main(ARGS, deps).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ProbeRefusal);
    expect(error?.message).toBe('token request refused (invalid_client, AADSTS700016); look the code up in Entra sign-in logs');
    const printed = `${error?.message}\n${lines.join('\n')}`;
    expect(printed).not.toMatch(GUID);
    expect(printed).not.toContain('Tidewell');
    expect(printed).not.toContain('@');
  });

  it.each([
    ['a Graph error', new GraphHttpError(401, 'InvalidAuthenticationToken', 'aaaaaaaa-0000-4000-8000-000000000000', 1), 'Graph request failed with status 401 InvalidAuthenticationToken'],
    ['a GUID-shaped Graph code', new GraphHttpError(403, '0f8fad5b-d9cb-469f-a165-70867728950e', null, 1), 'Graph request failed with status 403 other'],
    // The variable is the one the registration's cert_secret_ref names, an operator's choice: never echoed.
    ['our own certificate message', new Error('The reader certificate key variable TIDEWELL_PIKE_READER_PEM is not set'), 'certificate or token setup: the reader certificate key variable that cert_secret_ref names is not set'],
    ['a Key Vault status', new Error('Key Vault sign failed: 403'), 'certificate or token setup: Key Vault sign failed with status 403'],
    ['an unknown AADSTS code', Object.assign(new Error('AADSTS123456789: Tidewell Pike'), { errorCode: 'invalid_client' }), 'token request refused (invalid_client, AADSTS other); look the code up in Entra sign-in logs'],
    ['an AADSTS code with no MSAL fields', new Error(`AADSTS7000215: Invalid client secret provided for app '${CLIENT_ID}'`), 'token request refused (no code, AADSTS7000215); look the code up in Entra sign-in logs'],
    ['a malformed MSAL code', Object.assign(new Error('x'), { errorCode: 'Tidewell Pike: bad' }), 'token request refused (other); look the code up in Entra sign-in logs'],
    ['an unknown MSAL code', Object.assign(new Error('x'), { errorCode: 'tidewell_pike_advisors' }), 'token request refused (other); look the code up in Entra sign-in logs'],
    ['anything else', new Error(`fetch failed for storm.duncan@bank.example in ${CLIENT_ID}`), 'probe stopped on an unexpected error (details withheld so no tenant value is printed)'],
    ['a non-error', 'Tidewell Pike Advisors', 'probe stopped on an unexpected error (details withheld so no tenant value is printed)'],
    ['a refusal the script wrote', new ProbeRefusal('Refusing: the Exchange export is empty'), 'Refusing: the Exchange export is empty'],
  ])('prints %s safely', (_name, error, expected) => {
    expect(safeFailure(error)).toBe(expected);
  });
});

describe('Graph error codes print only from a fixed list (verify item 1)', () => {
  const GUID_CODE = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('maps a known code to itself, an unknown or GUID-shaped one to other, and none to null', () => {
    expect(printableGraphCode('Authorization_RequestDenied')).toBe('Authorization_RequestDenied');
    expect(printableGraphCode(GUID_CODE)).toBe('other');
    expect(printableGraphCode('TidewellPike')).toBe('other');
    expect(printableGraphCode(null)).toBeNull();
  });

  it('prints other, never the GUID, when Graph returns a GUID as the listing error code', async () => {
    const { deps, lines } = setup({ results: [{ status: 403, code: GUID_CODE }] });
    await expect(main(ARGS, deps)).resolves.toBe(1);
    expect(lines).toContain('group: status 403 other');
    expect(lines.join('\n')).not.toMatch(GUID);
  });

  it('prints other, never the GUID, when Graph returns a GUID as a mailbox error code', async () => {
    const results: ScopeProbeResult[] = [{ status: 200, code: null, group: report() }, { status: 403, code: GUID_CODE }, { status: 200, code: GUID_CODE }, { status: 404, code: GUID_CODE }];
    const { deps, lines } = setup({ results });
    await expect(main([...ARGS, ...ALIASES], deps)).resolves.toBe(0);
    expect(lines).toContain('PASS out-of-scope by address: 403 other (expected 403)');
    expect(lines).toContain('INFO alias of member: 200 other');
    expect(lines).toContain('PASS alias of non-member: 404 other (expected 403 or 404)');
    expect(lines.join('\n')).not.toMatch(GUID);
  });

  it('prints other, never the GUID, when a Graph failure carries a GUID code', async () => {
    const failing = vi.fn(async () => { throw new GraphHttpError(401, GUID_CODE, GUID_CODE, 1); });
    const { deps } = setup({ probe: failing as unknown as ProbeGroupDeps['probe'] });
    const error = await main(ARGS, deps).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe('Graph request failed with status 401 other');
  });
});
