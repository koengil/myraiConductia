import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { POST } from '@/app/api/v1/codenames/suggest/route';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

/*
 * POST /api/v1/codenames/suggest behind the model gate (#339 phase 1). The
 * prompt names the target company, so the caller's tenant is resolved first
 * and only a gate-allowed tenant reaches the model. Anything else gets the
 * deterministic themes, with no network call.
 */

type Row = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Row | Row[]>) {
  const upserts: Array<{ table: string; payload: unknown }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Row = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    for (const k of ['select', 'eq']) builder[k] = () => builder;
    builder.upsert = (payload: unknown) => {
      upserts.push({ table, payload });
      // recordAiUsage chains .select('id'); no inserted row keeps the budget check out of these tests.
      return { select: () => Promise.resolve({ data: [], error: null }) };
    };
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    return builder;
  };
  return { admin: { from } as unknown as ReturnType<typeof createSupabaseAdminClient>, upserts };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'md-1', email: 'storm@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () => Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const FIVE = ['Project Palette', 'Project Studio', 'Project Frame', 'Project Ink', 'Project Draft'];
function stubModel() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      model: 'claude-sonnet-5',
      usage: { input_tokens: 300, output_tokens: 90 },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            themes: [
              { label: 'Canvas craft', suggestions: FIVE },
              { label: 'Visual flow', suggestions: FIVE },
              { label: 'Creative spark', suggestions: FIVE },
            ],
          }),
        },
      ],
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function localStack() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
}

const req = () =>
  new Request('http://localhost/api/v1/codenames/suggest', {
    method: 'POST',
    body: JSON.stringify({ name: 'Canva', sector: 'Visual design platform', companyId: 'co-1' }),
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/v1/codenames/suggest — the model gate (#339)', () => {
  it('an unlisted tenant gets the deterministic suggestions and no model call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, upserts } = makeAdmin({ users: { data: { tenant_id: 'tenant-1' }, error: null } });
    signedIn(admin);

    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('fallback');
    expect(body.themes).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it('the DEV tenant on a local stack gets the model, and the call is ledgered', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    const { admin, upserts } = makeAdmin({ users: { data: { tenant_id: DEV_TENANT_ID }, error: null } });
    signedIn(admin);

    const body = await (await POST(req())).json();
    expect(body.source).toBe('llm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({ tenant_id: DEV_TENANT_ID, task: 'codename_suggest' });
  });

  it('the DEV tenant on a hosted URL gets the deterministic suggestions', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    const fetchMock = stubModel();
    const { admin } = makeAdmin({ users: { data: { tenant_id: DEV_TENANT_ID }, error: null } });
    signedIn(admin);

    expect((await (await POST(req())).json()).source).toBe('fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tenant lookup error is withheld, and the suggestions still come back', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    localStack();
    const fetchMock = stubModel();
    // The first read is requireApiUser's status check; the second is the tenant lookup.
    const { admin } = makeAdmin({
      users: [{ data: { status: 'active' }, error: null }, { data: null, error: { message: 'boom' } }],
    });
    signedIn(admin);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe('fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
