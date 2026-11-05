import { afterEach, describe, expect, it, vi } from 'vitest';

// The route authenticates through requireApiUser(), which builds its clients via
// @/lib/supabase/server. Mock that module so we can drive the auth user and the
// admin client (table lookups + the companies insert) without a server.
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { POST } from '@/app/api/v1/companies/route';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import {
  DUPLICATE_COMPANY_NAME_CODE,
  LEAD_NAME_MAX_LENGTH,
} from '@/lib/validation/inputPolicy';

type Resp = { data: unknown; error: unknown };

/** Chainable admin stub: select/eq/single chain resolves the per-table
 *  response; insert().select().single() resolves the configured insert result. */
function makeAdmin(opts: {
  tables?: Record<string, Resp | Resp[]>;
  insert?: Resp;
  auditInsert?: Resp;
  inserts?: Array<{ table: string; payload: Record<string, unknown> }>;
}) {
  const tables = opts.tables ?? {};
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.ilike = chain;
    builder.limit = chain;
    builder.delete = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    builder.insert = (payload: Record<string, unknown>) => {
      opts.inserts?.push({ table, payload });
      const insertBuilder: Record<string, unknown> = {};
      insertBuilder.select = () => insertBuilder;
      insertBuilder.single = () =>
        Promise.resolve(opts.insert ?? { data: null, error: null });
      insertBuilder.then = (onFulfilled: (v: Resp) => unknown) =>
        Promise.resolve(opts.auditInsert ?? { data: null, error: null }).then(onFulfilled);
      return insertBuilder;
    };
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

/** Wire requireApiUser's clients: a signed-in user + a given admin stub. */
function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'md-1', email: 'md@bank.dev' }) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/v1/companies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const withTenant = {
  users: { data: { tenant_id: 'tenant-1' }, error: null },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/companies', () => {
  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(401);
  });

  it('400 when name is empty', async () => {
    signedIn(makeAdmin({ tables: withTenant }));
    const res = await POST(req({ name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('201 with company id, name, and default type on success', async () => {
    const admin = makeAdmin({
      tables: withTenant,
      insert: {
        data: { id: '11111111-2222-4333-8444-555555555555', name: 'Acme', type: COMPANY_TYPE.CLIENT },
        error: null,
      },
    });
    signedIn(admin);
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { company: { id: string; name: string; type: string } };
    expect(body.company.name).toBe('Acme');
    expect(body.company.type).toBe(COMPANY_TYPE.CLIENT);
    expect(body.company.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('409 when this organization already registered the name', async () => {
    const admin = makeAdmin({
      tables: withTenant,
      insert: {
        data: null,
        error: { code: '23505', message: 'duplicate key companies_lead_name_per_registrar_unique' },
      },
    });
    signedIn(admin);
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/your organization already has a lead/i);
  });

  it('400 when type is not a valid COMPANY_TYPE', async () => {
    signedIn(makeAdmin({ tables: withTenant }));
    const res = await POST(req({ name: 'Acme', type: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('201 with default client type when type is an empty string', async () => {
    const admin = makeAdmin({
      tables: withTenant,
      insert: {
        data: { id: '11111111-2222-4333-8444-555555555555', name: 'Acme', type: COMPANY_TYPE.CLIENT },
        error: null,
      },
    });
    signedIn(admin);
    const res = await POST(req({ name: 'Acme', type: '' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { company: { type: string } };
    expect(body.company.type).toBe(COMPANY_TYPE.CLIENT);
  });

  it('403 when the caller cannot search companies (Chinese wall)', async () => {
    const admin = makeAdmin({
      tables: {
        users: { data: { firm_role: null, department: 'research', is_external: false }, error: null },
      },
    });
    signedIn(admin);
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(403);
  });

  it('403 for an external caller (must not probe existence via 201/409)', async () => {
    const admin = makeAdmin({
      tables: {
        users: { data: { firm_role: null, department: null, is_external: true }, error: null },
      },
    });
    signedIn(admin);
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(403);
  });
  it('400 when the name is a single character', async () => {
    signedIn(makeAdmin({ tables: withTenant }));
    const res = await POST(req({ name: 'A' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at least 2 characters/i);
  });

  it('400 when the name is longer than the shared limit', async () => {
    signedIn(makeAdmin({ tables: withTenant }));
    const res = await POST(req({ name: 'Z'.repeat(LEAD_NAME_MAX_LENGTH + 1) }));
    expect(res.status).toBe(400);
  });

  it('201 at exactly the maximum name length', async () => {
    const name = 'Z'.repeat(LEAD_NAME_MAX_LENGTH);
    signedIn(
      makeAdmin({
        tables: withTenant,
        insert: { data: { id: 'c-1', name, type: COMPANY_TYPE.CLIENT }, error: null },
      }),
    );
    const res = await POST(req({ name }));
    expect(res.status).toBe(201);
  });

  it('409 with a duplicate code when the name already exists in the tenant', async () => {
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    signedIn(
      makeAdmin({
        tables: { ...withTenant, companies: { data: { name: 'Atlassian', type: 'target' }, error: null } },
        inserts,
      }),
    );
    const res = await POST(req({ name: 'Atlassian' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe(DUPLICATE_COMPANY_NAME_CODE);
    expect(body.error).toMatch(/already on the platform as a target/i);
    expect(inserts).toHaveLength(0);
  });

  it('201 when the MD confirms the duplicate', async () => {
    signedIn(
      makeAdmin({
        tables: { ...withTenant, companies: { data: { name: 'Atlassian', type: 'target' }, error: null } },
        insert: { data: { id: 'c-2', name: 'Atlassian', type: COMPANY_TYPE.CLIENT }, error: null },
      }),
    );
    const res = await POST(req({ name: 'Atlassian', confirmDuplicate: true }));
    expect(res.status).toBe(201);
  });

  it('writes an audit row for the registration', async () => {
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    signedIn(
      makeAdmin({
        tables: withTenant,
        insert: { data: { id: 'c-3', name: 'Acme', type: COMPANY_TYPE.CLIENT }, error: null },
        inserts,
      }),
    );
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(201);
    const audit = inserts.find((row) => row.table === 'audit_log');
    expect(audit?.payload).toMatchObject({
      actor_id: 'md-1',
      action: AUDIT_ACTION.CREATE,
      detail: { reason: 'lead_registered', company_id: 'c-3', name: 'Acme' },
    });
  });

  it('500 and removes the company when the audit write fails', async () => {
    signedIn(
      makeAdmin({
        tables: withTenant,
        insert: { data: { id: 'c-4', name: 'Acme', type: COMPANY_TYPE.CLIENT }, error: null },
        auditInsert: { data: null, error: { message: 'audit down' } },
      }),
    );
    const res = await POST(req({ name: 'Acme' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unable to record the lead registration/i);
  });
});
