import { describe, expect, it, vi } from 'vitest';

import {
  createPersona,
  getPersona,
  linkPersona,
  listPersonas,
  updatePersona,
} from '@/lib/conductia/personas';

/**
 * Personas are tenant-scoped rather than lead-scoped, so there is no lead in
 * the path to resolve and prove ownership with. The verified tenant claim is
 * their only isolation control, which is why these queries must carry it.
 *
 * Before this change the only filter was `tenant_id`, the Ignatious handle --
 * one constant per deployment -- so every firm shared a single partition.
 */

type Row = Record<string, unknown>;

/** Records the filters applied so a missing predicate is visible, and returns
 *  only rows matching every `.eq()` -- i.e. it actually enforces the filter. */
function fakeAdmin(rows: Row[]) {
  const eqs: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  const matching = () =>
    rows.filter((row) => eqs.every(([column, value]) => row[column] === value));

  builder.select = () => builder;
  builder.order = () => Promise.resolve({ data: matching(), error: null });
  builder.eq = (column: string, value: unknown) => {
    eqs.push([column, value]);
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve({ data: matching()[0] ?? null, error: null });
  builder.upsert = vi.fn(() => Promise.resolve({ error: null }));
  // A conditional write: the rows its .eq() chain matches are the rows it hits.
  let updating = false;
  builder.update = vi.fn(() => {
    updating = true;
    eqs.length = 0;
    return builder;
  });
  const baseSelect = builder.select as () => unknown;
  builder.select = () => {
    if (!updating) return baseSelect();
    updating = false;
    return Promise.resolve({ data: matching().map((row) => ({ id: row.id })), error: null });
  };

  return {
    admin: { from: () => builder } as never,
    eqs,
    upsert: builder.upsert as ReturnType<typeof vi.fn>,
    update: builder.update as ReturnType<typeof vi.fn>,
  };
}

function personaRow(overrides: Row = {}): Row {
  return {
    id: 'per_1',
    tenant_id: 'tn_demo',
    conductia_tenant_id: 'tenant-a',
    name: 'Ada',
    title: 'CFO',
    organization: 'Acme',
    version: 1,
    links: [],
    updated_at: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('persona tenant isolation', () => {
  it('filters on the Conductia tenant, not just the Ignatious handle', async () => {
    const { admin, eqs } = fakeAdmin([personaRow()]);
    await listPersonas(admin, 'tn_demo', 'tenant-a');
    expect(eqs).toContainEqual(['tenant_id', 'tn_demo']);
    expect(eqs).toContainEqual(['conductia_tenant_id', 'tenant-a']);
  });

  it('does not return another tenant personas that share the handle', async () => {
    // Both rows carry the same 'tn_demo' handle: exactly the situation the
    // handle-only filter could not tell apart.
    const { admin } = fakeAdmin([
      personaRow({ id: 'per_a', conductia_tenant_id: 'tenant-a' }),
      personaRow({ id: 'per_b', conductia_tenant_id: 'tenant-b' }),
    ]);
    const personas = await listPersonas(admin, 'tn_demo', 'tenant-a');
    expect(personas.map((p) => p.personaId)).toEqual(['per_a']);
  });

  it('does not read a persona belonging to another tenant by id', async () => {
    const { admin } = fakeAdmin([personaRow({ id: 'per_1', conductia_tenant_id: 'tenant-b' })]);
    expect(await getPersona(admin, 'tn_demo', 'tenant-a', 'per_1')).toBeNull();
  });

  it('leaves an unbacked persona invisible, failing closed', async () => {
    // conductia_tenant_id is null until the backfill resolves it.
    const { admin } = fakeAdmin([personaRow({ conductia_tenant_id: null })]);
    expect(await listPersonas(admin, 'tn_demo', 'tenant-a')).toEqual([]);
  });

  it('stamps the link tenant from scope, ignoring the caller value', async () => {
    const { admin, update } = fakeAdmin([personaRow()]);
    // A caller naming someone else's tenant must not have it honoured:
    // listPersonas filters on link.leadId, so the link is a write into the
    // read filter.
    const result = await linkPersona(admin, 'tn_demo', 'tenant-a', 'per_1', 1, {
      leadId: 'FALCO-2026-100',
      contactId: 'c-1',
    });
    expect(result?.linkedContacts).toEqual([
      { tenantId: 'tn_demo', leadId: 'FALCO-2026-100', contactId: 'c-1' },
    ]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('stamps the link tenant from scope on create too', async () => {
    const { admin, upsert } = fakeAdmin([]);
    const persona = await createPersona(admin, 'tn_demo', 'tenant-a', {
      name: 'Ada',
      link: { tenantId: 'someone-else', leadId: 'FALCO-2026-100', contactId: 'c-1' },
    });
    expect(persona.linkedContacts).toEqual([
      { tenantId: 'tn_demo', leadId: 'FALCO-2026-100', contactId: 'c-1' },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('advances the version on a link and writes only on the version it read', async () => {
    const { admin, eqs } = fakeAdmin([personaRow()]);
    const result = await linkPersona(admin, 'tn_demo', 'tenant-a', 'per_1', 1, {
      leadId: 'FALCO-2026-100',
      contactId: 'c-1',
    });
    expect(result?.version).toBe(2);
    expect(eqs).toContainEqual(['version', 1]);
    expect(eqs).toContainEqual(['conductia_tenant_id', 'tenant-a']);
  });

  it('refuses a link authorized against an older version', async () => {
    const { admin, update } = fakeAdmin([personaRow({ version: 2 })]);
    await expect(
      linkPersona(admin, 'tn_demo', 'tenant-a', 'per_1', 1, { leadId: 'L', contactId: 'c-1' }),
    ).rejects.toMatchObject({ name: 'VersionConflict' });
    expect(update).not.toHaveBeenCalled();
  });

  it('misses when the row moved between the read and the write', async () => {
    // The read sees version 1; the conditional write finds no row at version 1.
    const row = personaRow();
    const { admin } = fakeAdmin([row]);
    const moving = {
      from: (table: string) => {
        const builder = (admin as { from: (t: string) => Record<string, unknown> }).from(table);
        const update = builder.update as (fields: unknown) => unknown;
        builder.update = (fields: unknown) => {
          row.version = 2;
          return update(fields);
        };
        return builder;
      },
    } as never;
    await expect(
      updatePersona(moving, 'tn_demo', 'tenant-a', 'per_1', 1, { name: 'x' }, {}),
    ).rejects.toMatchObject({ name: 'VersionConflict' });
  });
});
