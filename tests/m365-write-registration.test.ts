// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { applyRegistration, parseRegistrationConfig, type RegistrationConfig } from '../scripts/m365/write-registration';

// The registration config an admin writes (scripts/m365/README.md step 3).
// It names a key and never holds one, names the bank's own tenant, lists
// every source explicitly, and states each source's owner explicitly.

const VALID = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  msTenantId: '11111111-2222-3333-4444-555555555555',
  clientId: '66666666-7777-8888-9999-000000000000',
  certThumbprint: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
  certSecretRef: 'keyvault:https://reader-vault.vault.azure.net/keys/conductia-reader/0123abcd',
  status: 'active',
  consentedAt: '2026-10-01T09:00:00Z',
  firmCompany: 'Example Bank',
  mailboxDomains: ['Bank.Example', 'mail.bank.example'],
  sources: [
    { kind: 'mailbox', address: 'storm.duncan@bank.example', ownerEmail: 'Storm.Duncan@bank.example' },
    { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null },
  ],
};

function errorsOf(raw: unknown, options?: { allowEnvPem?: boolean; allowOwnerless?: boolean }): string[] {
  const result = parseRegistrationConfig(raw, options);
  return result.ok ? [] : result.errors;
}

describe('parseRegistrationConfig', () => {
  it('accepts a complete config and normalizes it', () => {
    const result = parseRegistrationConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.certThumbprint).toBe(VALID.certThumbprint.toLowerCase());
    expect(result.config.sources[0]).toEqual({
      kind: 'mailbox',
      address: 'storm.duncan@bank.example',
      ownerEmail: 'storm.duncan@bank.example',
    });
    expect(result.config.sources[1].ownerEmail).toBeNull();
    expect(result.config.firmCompany).toBe('Example Bank');
    expect(result.config.mailboxDomains).toEqual(['bank.example', 'mail.bank.example']);
    expect(result.config.scopeGroupId).toBeNull();
  });

  // #275 (design R3): the registration names the Exchange scope group by its Entra object id. Without one the
  // group mirror fails closed, so the field is optional here and an absent one is recorded as none.
  describe('the scope group', () => {
    const GROUP = 'AAAABBBB-CCCC-4DDD-8EEE-FFFF00001111';

    it('accepts the group object id, lower-cased', () => {
      const result = parseRegistrationConfig({ ...VALID, scopeGroupId: ` ${GROUP} ` });
      expect(result.ok && result.config.scopeGroupId).toBe(GROUP.toLowerCase());
    });

    it('records none when it is absent or null', () => {
      const absent = parseRegistrationConfig(VALID);
      expect(absent.ok && absent.config.scopeGroupId).toBeNull();
      const none = parseRegistrationConfig({ ...VALID, scopeGroupId: null });
      expect(none.ok && none.config.scopeGroupId).toBeNull();
    });

    it('refuses anything that is not a GUID, the group address and an empty value included', () => {
      for (const scopeGroupId of ['conductia-discovery@bank.example', 'Conductia Discovery', '', '   ', 42, ['x'], 'FILL IN']) {
        expect(errorsOf({ ...VALID, scopeGroupId })).toEqual([expect.stringContaining('scopeGroupId')]);
      }
    });

    it('never echoes the value it refuses', () => {
      const [error] = errorsOf({ ...VALID, scopeGroupId: 'conductia-discovery@bank.example' });
      expect(error).not.toContain('@');
    });
  });

  // C7 (#262): the guard reads nothing for a registration that names no firm or no domain,
  // so a config without them is refused here instead of writing a registration that reads nothing.
  it('requires the firm company and the mailbox domains the allowlist joins on', () => {
    const { firmCompany: _firm, mailboxDomains: _domains, ...bare } = VALID;
    void _firm;
    void _domains;
    expect(errorsOf(bare)).toEqual([
      expect.stringContaining('firmCompany'),
      expect.stringContaining('mailboxDomains'),
    ]);
    expect(errorsOf({ ...VALID, firmCompany: '  ' })).toEqual([expect.stringContaining('firmCompany')]);
    expect(errorsOf({ ...VALID, mailboxDomains: [] })).toEqual([expect.stringContaining('mailboxDomains')]);
  });

  it('refuses a mailbox domain that is an address, a url or malformed, and one listed twice is kept once', () => {
    expect(errorsOf({ ...VALID, mailboxDomains: ['md@bank.example'] })).toEqual([expect.stringContaining('mailboxDomains[0]')]);
    expect(errorsOf({ ...VALID, mailboxDomains: ['https://bank.example'] })).toEqual([expect.stringContaining('mailboxDomains[0]')]);
    expect(errorsOf({ ...VALID, mailboxDomains: ['bank'] })).toEqual([expect.stringContaining('mailboxDomains[0]')]);
    expect(errorsOf({ ...VALID, mailboxDomains: 'bank.example' })).toEqual([expect.stringContaining('mailboxDomains')]);
    const result = parseRegistrationConfig({ ...VALID, mailboxDomains: ['bank.example', 'BANK.example'] });
    expect(result.ok && result.config.mailboxDomains).toEqual(['bank.example']);
  });

  it('refuses key material anywhere in the file', () => {
    expect(errorsOf({ ...VALID, note: '-----BEGIN PRIVATE KEY-----\nabc' })).toEqual([
      'The config holds key material. It must only name where the key is.',
    ]);
  });

  it('refuses a shared authority and malformed ids', () => {
    const errors = errorsOf({ ...VALID, msTenantId: 'common', clientId: 'reader', tenantId: 'x' });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('msTenantId'),
        expect.stringContaining('clientId'),
        expect.stringContaining('tenantId'),
      ]),
    );
  });

  it('allows an env PEM only when the operator confirms it is the test tenant', () => {
    const env = { ...VALID, certSecretRef: 'env:GRAPH_READER_CERT_PEM' };
    expect(errorsOf(env)).toEqual([expect.stringContaining('--allow-env-pem')]);
    expect(errorsOf(env, { allowEnvPem: true })).toEqual([]);
    expect(errorsOf({ ...VALID, certSecretRef: 'file:/etc/key.pem' })).toEqual([
      expect.stringContaining('keyvault:<key id> or env:<VARIABLE>'),
    ]);
    expect(errorsOf({ ...VALID, certSecretRef: 'keyvault:https://evil.example/keys/a/b' })).toEqual([
      expect.stringContaining('vault.azure.net'),
    ]);
  });

  it('requires an explicit owner on every source, and no inferred ones', () => {
    const sources = [{ kind: 'mailbox', address: 'storm.duncan@bank.example' }];
    expect(errorsOf({ ...VALID, sources })).toEqual([expect.stringContaining('ownership is never inferred')]);
  });

  // Item 1 (PR #300 follow-up): the guard refuses a mailbox source with no owner (owner_mismatch), so a
  // registration that writes one reads nothing until the member opts in, which adopts it. Writing it is
  // allowed only when the operator says so, and the script warns.
  describe('a mailbox source with no owner', () => {
    const ownerless = {
      ...VALID,
      sources: [
        { kind: 'mailbox', address: 'storm.duncan@bank.example', ownerEmail: null },
        { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null },
      ],
    };

    it('is refused, naming the source and the flag that allows it', () => {
      const errors = errorsOf(ownerless);
      expect(errors).toEqual([expect.stringContaining('sources[0].ownerEmail')]);
      expect(errors[0]).toContain('--allow-ownerless');
      expect(errors[0]).toContain('owner_mismatch');
    });

    it('is accepted with --allow-ownerless, and the result warns that the guard refuses it until the member opts in', () => {
      const result = parseRegistrationConfig(ownerless, { allowOwnerless: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('storm.duncan@bank.example');
      expect(result.warnings[0]).toContain('refuses');
      expect(result.warnings[0]).toContain('opts in');
    });

    it('never applies to a site, which has no per-person owner, and an owned config has no warning', () => {
      const result = parseRegistrationConfig(VALID);
      expect(result.ok && result.warnings).toEqual([]);
      const site = { ...VALID, sources: [{ kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null }] };
      expect(errorsOf(site)).toEqual([]);
    });
  });

  it('requires an explicit, non-repeating list of well-formed sources', () => {
    expect(errorsOf({ ...VALID, sources: [] })).toEqual([expect.stringContaining('explicitly')]);
    const errors = errorsOf({
      ...VALID,
      sources: [
        { kind: 'mailbox', address: 'not-an-address', ownerEmail: null },
        { kind: 'sharepoint_site', address: 'https://bank.sharepoint.com/sites/Deals', ownerEmail: null },
        { kind: 'mailbox', address: 'A@bank.example', ownerEmail: null },
        { kind: 'mailbox', address: 'a@bank.example', ownerEmail: null },
        { kind: 'teams_chat', address: 'x', ownerEmail: null },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sources[0].address must be a mailbox address'),
        expect.stringContaining('sources[1].address must be a Graph site id'),
        expect.stringContaining('sources[3] repeats'),
        expect.stringContaining('sources[4].kind'),
      ]),
    );
  });

  it('keeps a registration pending until consent is recorded', () => {
    expect(errorsOf({ ...VALID, consentedAt: null })).toEqual([expect.stringContaining('consentedAt')]);
    expect(errorsOf({ ...VALID, status: undefined, consentedAt: null })).toEqual([]);
  });
});

// Round 3, M5: the owner a re-run writes must come from the database, not from the lookup it made earlier. A member's
// opt-in adopts an ownerless mailbox source at any moment, so between the lookup and the update the row can gain an
// owner the lookup never saw. A mailbox listed with "ownerEmail": null leaves owner_user_id out of the update, and the
// database keeps what it holds. Everything else is as before.
//
// Round 4 (Codex 2): the update of an existing source is conditional on the address the lookup saw and on the row not
// being archived, because the opt-in can archive that row between the lookup and the write (it renames the address,
// pauses the row and stamps archived_at). A write that matched nothing re-resolves the live source of the address, or
// creates one, and never touches the archived row.
describe('applyRegistration: a re-run does not write an owner it only remembers', () => {
  const MEMBER = '99999999-9999-4999-8999-999999999999';
  const OWNER = '88888888-8888-4888-8888-888888888888';
  type Write = { op: 'insert' | 'update'; values: Record<string, unknown> };
  type Row = {
    id: string;
    kind: string;
    address: string;
    status: string;
    owner_user_id: string | null;
    tenant_id?: string;
    archived_at?: string | null;
  };
  type Cond = ['eq' | 'is', string, unknown];

  /**
   * A db over in-memory content_sources that filters like the real one (eq, is, in), recording what the writes carry
   * and the conditions each update was issued with. afterSourceLookup runs once the first content_sources read has
   * resolved: the moment the plan is made, which a concurrent opt-in can follow.
   */
  function fakeDb(initial: Row[], hooks: { afterSourceLookup?: (rows: Row[]) => void } = {}) {
    const rows: Row[] = initial.map((r) => ({ tenant_id: VALID.tenantId, archived_at: null, ...r }));
    const writes: Write[] = [];
    const upserts: Array<{ table: string; values: Record<string, unknown> }> = [];
    const updateConditions: Cond[][] = [];
    let lookups = 0;
    const matches = (row: Record<string, unknown>, conds: Cond[]) =>
      conds.every(([, column, value]) => !(column in row) || row[column] === value);
    const reads = (table: string, source: Array<Record<string, unknown>>) => {
      const conds: Cond[] = [];
      const builder: Record<string, unknown> = {};
      builder.eq = (column: string, value: unknown) => (conds.push(['eq', column, value]), builder);
      builder.is = (column: string, value: unknown) => (conds.push(['is', column, value]), builder);
      builder.in = () => builder;
      builder.maybeSingle = async () => ({ data: source[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        const data = source.filter((row) => matches(row, conds)).map((row) => ({ ...row }));
        if (table === 'content_sources' && ++lookups === 1) hooks.afterSourceLookup?.(rows);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    };
    const db = {
      from: (table: string) => ({
        select: () => {
          if (table === 'companies') return reads(table, [{ id: 'bank-company', name: 'Example Bank' }]);
          if (table === 'users') return reads(table, [{ id: OWNER, email: 'owner@bank.example', tenant_id: VALID.tenantId, is_external: false }]);
          if (table === 'graph_reader_registrations') return reads(table, [{ tenant_id: VALID.tenantId }]);
          if (table === 'content_sources') return reads(table, rows);
          throw new Error(`unexpected select on ${table}`);
        },
        upsert: async (values: Record<string, unknown>) => {
          upserts.push({ table, values });
          return { error: null };
        },
        insert: async (values: Record<string, unknown>) => {
          if (table === 'content_sources') {
            writes.push({ op: 'insert', values });
            rows.push({ id: `inserted-${rows.length}`, tenant_id: VALID.tenantId, archived_at: null, ...(values as Omit<Row, 'id'>) });
          }
          return { error: null };
        },
        update: (values: Record<string, unknown>) => {
          const conds: Cond[] = [];
          const run = () => {
            if (table === 'content_sources') {
              writes.push({ op: 'update', values });
              updateConditions.push(conds);
            }
            const hit = rows.filter((row) => matches(row, conds));
            for (const row of hit) Object.assign(row, values);
            return { data: hit.map((row) => ({ id: row.id })), error: null };
          };
          const builder: Record<string, unknown> = {};
          builder.eq = (column: string, value: unknown) => (conds.push(['eq', column, value]), builder);
          builder.is = (column: string, value: unknown) => (conds.push(['is', column, value]), builder);
          builder.select = async () => run();
          builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(run()).then(resolve, reject);
          return builder;
        },
      }),
    } as unknown as SupabaseClient;
    return { db, writes, upserts, rows, updateConditions };
  }

  const configFor = (sources: RegistrationConfig['sources'], over: Record<string, unknown> = {}): RegistrationConfig => {
    const parsed = parseRegistrationConfig({ ...VALID, ...over, sources }, { allowOwnerless: true });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.config;
  };
  const row = (kind: string, address: string, owner: string | null) => ({ id: `${kind}-id`, kind, address, status: 'active', owner_user_id: owner });
  /** What mailbox_consent_grant does to an orphaned source: rename, pause, stamp, and give the member a fresh one. */
  const archiveAndReplace = (rows: Row[], fresh: boolean) => {
    const archived = rows.find((r) => r.id === 'mailbox-id')!;
    Object.assign(archived, { address: `${archived.address}~k3x`, status: 'paused', archived_at: '2026-10-02T00:00:00Z' });
    if (fresh) rows.push({ id: 'fresh-id', kind: 'mailbox', address: 'md@bank.example', status: 'active', owner_user_id: MEMBER, tenant_id: VALID.tenantId, archived_at: null });
  };

  it('omits owner_user_id from the update of an existing mailbox listed with no owner', async () => {
    // The lookup saw no owner; by the time of the write a member has adopted the source.
    const { db, writes } = fakeDb([row('mailbox', 'md@bank.example', null)]);
    await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe('update');
    expect('owner_user_id' in writes[0].values).toBe(false);
    expect(writes[0].values).toEqual({ status: 'active' });
  });

  it('omits it as well when the lookup already showed an owner', async () => {
    const { db, writes } = fakeDb([row('mailbox', 'md@bank.example', MEMBER)]);
    const plan = await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
    expect(plan.sources[0]).toMatchObject({ action: 'update', ownerUserId: MEMBER }); // what the operator is shown
    expect('owner_user_id' in writes[0].values).toBe(false);
  });

  it('still writes the owner the config names, for an existing mailbox', async () => {
    const { db, writes } = fakeDb([row('mailbox', 'md@bank.example', MEMBER)]);
    await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: 'owner@bank.example' }]));
    expect(writes[0].values).toEqual({ owner_user_id: OWNER, status: 'active' });
  });

  it('a new mailbox with no owner is inserted ownerless, and a listed site is written as before', async () => {
    const { db, writes } = fakeDb([row('sharepoint_site', 'bank.sharepoint.com:/sites/Deals', null)]);
    await applyRegistration(
      db,
      configFor([
        { kind: 'mailbox', address: 'new@bank.example', ownerEmail: null },
        { kind: 'sharepoint_site', address: 'bank.sharepoint.com:/sites/Deals', ownerEmail: null },
      ]),
    );
    expect(writes).toEqual([
      { op: 'insert', values: expect.objectContaining({ address: 'new@bank.example', owner_user_id: null }) },
      { op: 'update', values: { owner_user_id: null, status: 'active' } },
    ]);
  });

  // #275: the upsert carries the scope group, and a config that names none writes null, so the mirror fails closed.
  it('writes the scope group the config names, and null when it names none', async () => {
    const sources: RegistrationConfig['sources'] = [{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }];
    const named = fakeDb([row('mailbox', 'md@bank.example', null)]);
    await applyRegistration(named.db, configFor(sources, { scopeGroupId: 'AAAABBBB-CCCC-4DDD-8EEE-FFFF00001111' }));
    expect(named.upserts).toEqual([
      { table: 'graph_reader_registrations', values: expect.objectContaining({ scope_group_id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111' }) },
    ]);
    const none = fakeDb([row('mailbox', 'md@bank.example', null)]);
    await applyRegistration(none.db, configFor(sources));
    expect(none.upserts).toEqual([{ table: 'graph_reader_registrations', values: expect.objectContaining({ scope_group_id: null }) }]);
  });

  it('writes nothing, the scope group included, on a dry run', async () => {
    const { db, upserts, writes } = fakeDb([row('mailbox', 'md@bank.example', null)]);
    await applyRegistration(
      db,
      configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }], { scopeGroupId: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111' }),
      { dryRun: true },
    );
    expect(upserts).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('updates an existing source only by its id, the address the lookup saw, and while it is not archived', async () => {
    const { db, updateConditions } = fakeDb([row('mailbox', 'MD@bank.example', null)]);
    await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
    expect(updateConditions).toEqual([
      [
        ['eq', 'id', 'mailbox-id'],
        ['eq', 'address', 'MD@bank.example'],
        ['is', 'archived_at', null],
      ],
    ]);
  });

  describe('a source archived between the lookup and the write', () => {
    it('is left archived and paused; the live source the opt-in created gets the write', async () => {
      const { db, rows, updateConditions } = fakeDb([row('mailbox', 'md@bank.example', null)], {
        afterSourceLookup: (state) => archiveAndReplace(state, true),
      });
      await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
      expect(rows.find((r) => r.id === 'mailbox-id')).toMatchObject({
        address: 'md@bank.example~k3x',
        status: 'paused',
        archived_at: '2026-10-02T00:00:00Z',
      });
      // M5 holds on the live row: the member the opt-in made owner is not overwritten, and it is made active.
      expect(rows.find((r) => r.id === 'fresh-id')).toMatchObject({ status: 'active', owner_user_id: MEMBER });
      // The first attempt matched nothing; the second is conditional on the live row in the same way.
      expect(updateConditions).toHaveLength(2);
      expect(updateConditions[1]).toEqual([
        ['eq', 'id', 'fresh-id'],
        ['eq', 'address', 'md@bank.example'],
        ['is', 'archived_at', null],
      ]);
    });

    it('creates the source when the opt-in made no fresh one, still leaving the archive alone', async () => {
      const { db, rows, writes } = fakeDb([row('mailbox', 'md@bank.example', null)], {
        afterSourceLookup: (state) => archiveAndReplace(state, false),
      });
      await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: null }]));
      expect(rows.find((r) => r.id === 'mailbox-id')).toMatchObject({ status: 'paused', archived_at: '2026-10-02T00:00:00Z' });
      expect(writes.filter((w) => w.op === 'insert')).toEqual([
        { op: 'insert', values: expect.objectContaining({ address: 'md@bank.example', status: 'active', owner_user_id: null }) },
      ]);
    });

    it('applies the owner the config names to the live source, not to the archive', async () => {
      const { db, rows } = fakeDb([row('mailbox', 'md@bank.example', null)], {
        afterSourceLookup: (state) => archiveAndReplace(state, true),
      });
      await applyRegistration(db, configFor([{ kind: 'mailbox', address: 'md@bank.example', ownerEmail: 'owner@bank.example' }]));
      expect(rows.find((r) => r.id === 'mailbox-id')).toMatchObject({ status: 'paused', owner_user_id: null });
      expect(rows.find((r) => r.id === 'fresh-id')).toMatchObject({ status: 'active', owner_user_id: OWNER });
    });
  });
});
