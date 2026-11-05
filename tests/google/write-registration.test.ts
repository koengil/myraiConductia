// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSecretsFolderKeyless } from '../../scripts/google/lib/live';
import {
  applyGoogleRegistration,
  parseGoogleRegistrationConfig,
  type RegistrationDb,
  type SourceRecord,
} from '../../scripts/google/write-registration';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FIRM = '22222222-2222-4222-8222-222222222222';
const VALID = {
  tenantId: TENANT,
  workspaceDomain: 'bank.example',
  serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
  clientId: '123456789012345678',
  directoryServiceAccountEmail: 'dir-reader@proj-1.iam.gserviceaccount.com',
  allowlistGroup: 'conductia-ingest@bank.example',
  firmCompanyId: FIRM,
  status: 'pending',
};
const KEY_FIELD = 'private_' + 'key';

function errorsFor(patch: Record<string, unknown>): string[] {
  const parsed = parseGoogleRegistrationConfig({ ...VALID, ...patch });
  return parsed.ok ? [] : parsed.errors;
}

type FakeOptions = {
  sources?: SourceRecord[];
  users?: Record<string, string>;
  /** Rows the database holds after the lookup (the member's opt-in archived one, another writer created one). */
  afterLookup?: (rows: SourceRecord[]) => SourceRecord[];
  /** The unique index answers `exists` this many times before an insert succeeds. */
  insertConflicts?: number;
};

function fakeDb(company: { id: string; tenant_id: string; type: string } | null, options: FakeOptions = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const users = options.users ?? {};
  let rows = (options.sources ?? []).map((r) => ({ ...r }));
  let conflicts = options.insertConflicts ?? 0;
  const live = (address: string) => rows.find((r) => !r.archivedAt && r.address.toLowerCase() === address.toLowerCase()) ?? null;
  const db: RegistrationDb = {
    findCompany: async () => company,
    upsertRegistration: async (row) => {
      upserts.push(row);
    },
    findInternalUser: async (_tenant, email) => (users[email] ? { id: users[email] } : null),
    listMailboxSources: async () => {
      const seen = rows.map((r) => ({ ...r }));
      if (options.afterLookup) rows = options.afterLookup(rows);
      return seen;
    },
    findLiveSource: async (_tenant, address) => live(address),
    insertSource: async (row) => {
      if (conflicts > 0) {
        conflicts -= 1;
        return 'exists';
      }
      inserts.push(row);
      return 'inserted';
    },
    // The same condition the database client applies: the live Google source at this id and address.
    updateLiveSource: async (id, address, fields) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.archivedAt || row.address !== address || row.provider !== 'google') return false;
      updates.push({ id, fields });
      return true;
    },
  };
  return { db, upserts, inserts, updates };
}

describe('parseGoogleRegistrationConfig', () => {
  it('accepts a valid pending registration', () => {
    const parsed = parseGoogleRegistrationConfig(VALID);
    expect(parsed).toMatchObject({ ok: true, config: { workspaceDomain: 'bank.example', status: 'pending', consentedAt: null } });
  });

  it('refuses key material anywhere in the configuration', () => {
    expect(errorsFor({ [KEY_FIELD]: 'x' }).join()).toMatch(/private_key field/);
    expect(errorsFor({ note: '-----' + 'BEGIN PRIVATE KEY-----' }).join()).toMatch(/PEM block/);
    expect(errorsFor({ type: 'service_' + 'account' }).join()).toMatch(/service-account key file/);
  });

  it('refuses a bad service account email, client ID or group domain', () => {
    expect(errorsFor({ serviceAccountEmail: 'someone@gmail.com' }).join()).toMatch(/serviceAccountEmail/);
    expect(errorsFor({ directoryServiceAccountEmail: 'nope' }).join()).toMatch(/directoryServiceAccountEmail/);
    expect(errorsFor({ clientId: 'abc' }).join()).toMatch(/clientId/);
    expect(errorsFor({ allowlistGroup: 'conductia-ingest@other.example' }).join()).toMatch(/workspace domain/);
    expect(errorsFor({ workspaceDomain: 'Bank.Example' }).join()).toMatch(/workspaceDomain/);
    expect(errorsFor({ tenantId: 'not-a-uuid' }).join()).toMatch(/tenantId/);
    expect(errorsFor({ firmCompanyId: 'nope' }).join()).toMatch(/firmCompanyId/);
  });

  it('refuses equal DWD and directory service accounts', () => {
    expect(errorsFor({ directoryServiceAccountEmail: VALID.serviceAccountEmail }).join()).toMatch(/must differ/);
  });

  it('refuses an active registration without consentedAt, and accepts one with it', () => {
    expect(errorsFor({ status: 'active' }).join()).toMatch(/requires consentedAt/);
    expect(errorsFor({ status: 'active', consentedAt: '2026-10-05T12:00:00Z' })).toEqual([]);
    expect(errorsFor({ status: 'live' }).join()).toMatch(/status must be one of/);
  });
});

describe('applyGoogleRegistration', () => {
  const config = () => {
    const parsed = parseGoogleRegistrationConfig(VALID);
    if (!parsed.ok) throw new Error('fixture invalid');
    return parsed.config;
  };

  it('refuses a firm company from another tenant, or one that is not a bank', async () => {
    const other = fakeDb({ id: FIRM, tenant_id: '33333333-3333-4333-8333-333333333333', type: 'bank' });
    await expect(applyGoogleRegistration(other.db, config())).rejects.toThrow("firm company is not this tenant's bank");
    const notBank = fakeDb({ id: FIRM, tenant_id: TENANT, type: 'target' });
    await expect(applyGoogleRegistration(notBank.db, config())).rejects.toThrow("firm company is not this tenant's bank");
    const missing = fakeDb(null);
    await expect(applyGoogleRegistration(missing.db, config())).rejects.toThrow("firm company is not this tenant's bank");
    expect(other.upserts.length + notBank.upserts.length + missing.upserts.length).toBe(0);
  });

  it("upserts the tenant's bank registration", async () => {
    const { db, upserts } = fakeDb({ id: FIRM, tenant_id: TENANT, type: 'bank' });
    const result = await applyGoogleRegistration(db, config());
    expect(result.written).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      tenant_id: TENANT,
      workspace_domain: 'bank.example',
      service_account_email: VALID.serviceAccountEmail,
      firm_company_id: FIRM,
      status: 'pending',
    });
  });

  it('writes nothing on a dry run', async () => {
    const { db, upserts } = fakeDb({ id: FIRM, tenant_id: TENANT, type: 'bank' });
    const result = await applyGoogleRegistration(db, config(), { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.row).toMatchObject({ tenant_id: TENANT });
    expect(upserts).toHaveLength(0);
  });
});

describe('sources (Phase 2)', () => {
  const BANK = { id: FIRM, tenant_id: TENANT, type: 'bank' };
  const SOURCES = [
    { address: 'storm@bank.example', ownerEmail: 'Storm@bank.example' },
    { address: 'morgan@bank.example', ownerEmail: 'morgan@bank.example' },
  ];
  const configWith = (sources: unknown) => {
    const parsed = parseGoogleRegistrationConfig({ ...VALID, sources });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    return parsed.config;
  };
  const users = { 'storm@bank.example': 'u-storm', 'morgan@bank.example': 'u-morgan' };

  it('refuses an address outside the domain, a repeated address, an upper-case one and a bad owner', () => {
    expect(errorsFor({ sources: [{ address: 'a@other.example', ownerEmail: 'a@bank.example' }] }).join()).toMatch(/workspace domain/);
    expect(errorsFor({ sources: [{ address: 'A@bank.example', ownerEmail: 'a@bank.example' }] }).join()).toMatch(/lowercase/);
    expect(
      errorsFor({ sources: [{ address: 'a@bank.example', ownerEmail: 'a@bank.example' }, { address: 'a@bank.example', ownerEmail: 'a@bank.example' }] }).join(),
    ).toMatch(/listed twice/);
    expect(errorsFor({ sources: [{ address: 'a@bank.example', ownerEmail: 'nope' }] }).join()).toMatch(/ownerEmail/);
    expect(errorsFor({ sources: 'a@bank.example' }).join()).toMatch(/sources must be a list/);
  });

  it('inserts a Google mailbox source per address, owned by the internal user, and never writes the generated columns', async () => {
    const { db, inserts } = fakeDb(BANK, { users });
    const result = await applyGoogleRegistration(db, configWith(SOURCES));
    expect(result.sources).toEqual([
      { address: 'storm@bank.example', action: 'insert' },
      { address: 'morgan@bank.example', action: 'insert' },
    ]);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual({
      tenant_id: TENANT,
      kind: 'mailbox',
      provider: 'google',
      address: 'storm@bank.example',
      owner_user_id: 'u-storm',
      status: 'active',
    });
    for (const row of inserts) {
      expect(Object.keys(row)).not.toContain('ms_registration_tenant');
      expect(Object.keys(row)).not.toContain('g_registration_tenant');
    }
  });

  it('refuses an owner who is not an internal user of the tenant, and writes nothing', async () => {
    const { db, upserts, inserts } = fakeDb(BANK, { users: { 'storm@bank.example': 'u-storm' } });
    await expect(applyGoogleRegistration(db, configWith(SOURCES))).rejects.toThrow(/morgan@bank\.example is not an internal user/);
    expect(upserts).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('refuses an address that is already a Microsoft source, and writes nothing', async () => {
    const { db, upserts, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [{ id: 's1', provider: 'microsoft', address: 'storm@bank.example', status: 'active' }],
    });
    await expect(applyGoogleRegistration(db, configWith(SOURCES))).rejects.toThrow(/already a microsoft source/);
    expect(upserts.length + inserts.length + updates.length).toBe(0);
  });

  it('updates a listed Google source, pauses an omitted one and never touches Microsoft rows', async () => {
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [
        { id: 'g-storm', provider: 'google', address: 'storm@bank.example', status: 'paused' },
        { id: 'g-old', provider: 'google', address: 'old@bank.example', status: 'active' },
        { id: 'g-done', provider: 'google', address: 'done@bank.example', status: 'paused' },
        { id: 'm-1', provider: 'microsoft', address: 'ms@bank.example', status: 'active' },
      ],
    });
    const result = await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    expect(result.sources).toEqual([
      { address: 'storm@bank.example', action: 'update' },
      { address: 'old@bank.example', action: 'pause' },
      { address: 'done@bank.example', action: 'unchanged' },
    ]);
    expect(inserts).toHaveLength(0);
    expect(updates).toEqual([
      { id: 'g-storm', fields: { owner_user_id: 'u-storm', status: 'active' } },
      { id: 'g-old', fields: { status: 'paused' } },
    ]);
  });

  it('never touches an archived source: it is not matched, not paused, not resumed, not re-owned (#262)', async () => {
    const archived = { archivedAt: '2026-10-01T10:00:00Z' };
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [
        // Archived from storm@bank.example: renamed, and (here) wrongly active, as only a stray writer could leave it.
        { id: 'g-arch', provider: 'google', address: 'storm@bank.example~k3x', status: 'active', ...archived },
        { id: 'g-arch-2', provider: 'google', address: 'old@bank.example~a1b', status: 'active', ...archived },
        { id: 'm-arch', provider: 'microsoft', address: 'ms@bank.example~zz9', status: 'paused', ...archived },
      ],
    });
    const result = await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    // The listed address gets a fresh source; the archived rows are neither planned nor written.
    expect(result.sources).toEqual([{ address: 'storm@bank.example', action: 'insert' }]);
    expect(inserts).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it('an archived row at the listed address does not make it an update: a lookup that returns one is ignored', async () => {
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [{ id: 'g-arch', provider: 'microsoft', address: 'storm@bank.example', status: 'paused', archivedAt: '2026-10-01T10:00:00Z' }],
    });
    // An archived Microsoft row at the address is no clash either: it is closed for good.
    const result = await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    expect(result.sources).toEqual([{ address: 'storm@bank.example', action: 'insert' }]);
    expect(inserts).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it('with no sources key it writes the registration and touches no source, however many Google sources the tenant has', async () => {
    const { db, upserts, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [
        { id: 'g-1', provider: 'google', address: 'member@bank.example', status: 'active' },
        { id: 'g-2', provider: 'google', address: 'other@bank.example', status: 'active' },
      ],
    });
    const parsed = parseGoogleRegistrationConfig(VALID);
    if (!parsed.ok) throw new Error('fixture invalid');
    expect(parsed.config.sourcesListed).toBe(false);
    const result = await applyGoogleRegistration(db, parsed.config);
    expect(result.written).toBe(true);
    expect(result.sources).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(inserts.length + updates.length).toBe(0);
  });

  it('an explicit empty list is authoritative: every live Google source is paused, an archived one is left alone', async () => {
    const { db, updates } = fakeDb(BANK, {
      users,
      sources: [
        { id: 'g-1', provider: 'google', address: 'member@bank.example', status: 'active' },
        { id: 'g-arch', provider: 'google', address: 'gone@bank.example~k3x', status: 'active', archivedAt: '2026-10-01T10:00:00Z' },
      ],
    });
    const result = await applyGoogleRegistration(db, configWith([]));
    expect(result.sources).toEqual([{ address: 'member@bank.example', action: 'pause' }]);
    expect(updates).toEqual([{ id: 'g-1', fields: { status: 'paused' } }]);
  });

  it('a source archived between the lookup and the write is not written: the update matches nothing and a fresh source is created', async () => {
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [{ id: 'g-storm', provider: 'google', address: 'storm@bank.example', status: 'active' }],
      // The member's opt-in renamed, paused and stamped the row after the lookup.
      afterLookup: (rows) =>
        rows.map((r) => (r.id === 'g-storm' ? { ...r, address: 'storm@bank.example~k3x', status: 'paused' as const, archivedAt: '2026-10-01T10:00:00Z' } : r)),
    });
    const result = await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    expect(result.sources).toEqual([{ address: 'storm@bank.example', action: 'update' }]);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([expect.objectContaining({ address: 'storm@bank.example', provider: 'google', owner_user_id: 'u-storm', status: 'active' })]);
  });

  it('a source archived and replaced between the lookup and the write is updated at its live row, not the archived one', async () => {
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      sources: [{ id: 'g-storm', provider: 'google', address: 'storm@bank.example', status: 'active' }],
      afterLookup: (rows) => [
        ...rows.map((r) => ({ ...r, address: 'storm@bank.example~k3x', status: 'paused' as const, archivedAt: '2026-10-01T10:00:00Z' })),
        { id: 'g-fresh', provider: 'google', address: 'storm@bank.example', status: 'active' as const },
      ],
    });
    await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    expect(inserts).toEqual([]);
    expect(updates).toEqual([{ id: 'g-fresh', fields: { owner_user_id: 'u-storm', status: 'active' } }]);
  });

  it('another writer creating the address first is written to, not duplicated', async () => {
    const { db, inserts, updates } = fakeDb(BANK, {
      users,
      insertConflicts: 1,
      afterLookup: (rows) => [...rows, { id: 'g-raced', provider: 'google', address: 'storm@bank.example', status: 'active' as const }],
    });
    await applyGoogleRegistration(db, configWith([SOURCES[0]]));
    expect(inserts).toEqual([]);
    expect(updates).toEqual([{ id: 'g-raced', fields: { owner_user_id: 'u-storm', status: 'active' } }]);
  });

  it('refuses an address that became a Microsoft source while it was written, and gives up after repeated changes', async () => {
    const clash = fakeDb(BANK, {
      users,
      insertConflicts: 1,
      afterLookup: (rows) => [...rows, { id: 'm-raced', provider: 'microsoft', address: 'storm@bank.example', status: 'active' as const }],
    });
    await expect(applyGoogleRegistration(clash.db, configWith([SOURCES[0]]))).rejects.toThrow(/became a microsoft source/);
    expect(clash.inserts.length + clash.updates.length).toBe(0);

    const churn = fakeDb(BANK, { users, insertConflicts: 99 });
    await expect(applyGoogleRegistration(churn.db, configWith([SOURCES[0]]))).rejects.toThrow(/kept changing/);
  });

  it('plans sources on a dry run and writes nothing', async () => {
    const { db, upserts, inserts, updates } = fakeDb(BANK, { users });
    const result = await applyGoogleRegistration(db, configWith(SOURCES), { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.sources.map((s) => s.action)).toEqual(['insert', 'insert']);
    expect(upserts.length + inserts.length + updates.length).toBe(0);
  });
});

describe('assertSecretsFolderKeyless', () => {
  it('refuses a JSON file with key material anywhere in the folder, and passes a clean one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-folder-'));
    try {
      mkdirSync(join(dir, 'google'));
      writeFileSync(join(dir, 'google', 'registration.json'), JSON.stringify(VALID));
      writeFileSync(join(dir, 'google', 'worker-credentials.json'), JSON.stringify({ type: 'external_account' }));
      expect(() => assertSecretsFolderKeyless(dir)).not.toThrow();
      writeFileSync(join(dir, 'google', 'oops.json'), JSON.stringify({ type: 'service_' + 'account', [KEY_FIELD]: 'x' }));
      expect(() => assertSecretsFolderKeyless(dir)).toThrow(/google\/oops\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a folder that does not exist', () => {
    expect(() => assertSecretsFolderKeyless(join(tmpdir(), 'no-such-secrets-folder'))).not.toThrow();
  });
});
