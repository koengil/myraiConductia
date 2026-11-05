import { describe, expect, it, vi } from 'vitest';

import { emailFromContactInfo, upsertCrmPerson } from '@/lib/api/v1/crmPeople';

describe('emailFromContactInfo', () => {
  it('extracts the first email token from contact info', () => {
    expect(emailFromContactInfo('jamie@acme.com, +1 555')).toBe('jamie@acme.com');
  });
});

describe('upsertCrmPerson', () => {
  it('returns an existing person id without inserting', async () => {
    const admin = {
      from(table: string) {
        expect(table).toBe('crm_people');
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const k of ['select', 'eq', 'is', 'ilike', 'update']) builder[k] = chain;
        builder.maybeSingle = () => Promise.resolve({ data: { id: 'person-1', title: null, org: null }, error: null });
        builder.insert = () => {
          throw new Error('should not insert');
        };
        return builder;
      },
    };

    const id = await upsertCrmPerson(admin as never, {
      tenantId: 'tenant-1',
      registeredByCompanyId: 'company-1',
      name: 'Jamie Rivera',
    });
    expect(id).toBe('person-1');
  });

  it('inserts when no matching person exists', async () => {
    let inserted = false;
    const admin = {
      from(table: string) {
        expect(table).toBe('crm_people');
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const k of ['select', 'eq', 'is', 'ilike']) builder[k] = chain;
        builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
        builder.insert = (payload: unknown) => {
          inserted = true;
          expect(payload).toMatchObject({
            tenant_id: 'tenant-1',
            registered_by_company_id: 'company-1',
            name: 'Jamie Rivera',
            email: 'jamie@acme.com',
          });
          const insertBuilder: Record<string, unknown> = {};
          insertBuilder.select = () => insertBuilder;
          insertBuilder.single = () => Promise.resolve({ data: { id: 'person-new' }, error: null });
          return insertBuilder;
        };
        return builder;
      },
    };

    const id = await upsertCrmPerson(admin as never, {
      tenantId: 'tenant-1',
      registeredByCompanyId: 'company-1',
      name: 'Jamie Rivera',
      email: 'jamie@acme.com',
    });
    expect(id).toBe('person-new');
    expect(inserted).toBe(true);
  });
});
