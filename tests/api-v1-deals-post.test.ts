import { afterEach, describe, expect, it, vi } from 'vitest';

// The route authenticates through requireApiUser(), which builds its clients via
// @/lib/supabase/server. Mock that module so we can drive the auth user and the
// admin client (table lookups + the create_deal_gate0 RPC) without a server.
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/dataroom/steps', () => ({
  provisionDealDataroomOnCreate: vi.fn(() => Promise.resolve()),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { provisionDealDataroomOnCreate } from '@/lib/dataroom/steps';
import { GET, POST } from '@/app/api/v1/deals/route';
import { MVP_DEAL_RAIL, railSeedRows } from '@/lib/rail/dealRail';

type Resp = { data: unknown; error: unknown };

/** Chainable admin stub: select/eq/limit chain; single/maybeSingle resolve the
 *  per-table response; rpc resolves a configured result. */
function makeAdmin(opts: {
  tables?: Record<string, Resp | Resp[]>;
  rpc?: Resp;
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
    builder.limit = chain;
    builder.order = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  const rpc = vi.fn(() => Promise.resolve(opts.rpc ?? { data: null, error: null }));
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    rpc: ReturnType<typeof vi.fn>;
  };
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
  return new Request('http://localhost/api/v1/deals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const withBankTenant = {
  users: { data: { tenant_id: 'tenant-1' }, error: null },
  companies: { data: { id: 'bank-1' }, error: null },
};

/** The Seq 6 gate: every valid create must carry the conflicts attestation. */
const ATTESTATION = {
  approvedBy: 'Avery Lindqvist',
  approvedOn: new Date().toISOString().slice(0, 10),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/deals', () => {
  it('carries each deal\'s platform current step, and none when it was removed or unset', async () => {
    const row = (id: string, current_step: unknown) => ({
      id,
      code: `${id}-CODE`,
      codename: id,
      status: 'active',
      created_at: '2026-09-18T00:00:00Z',
      entry_step_seq: 1,
      current_step_seq: 12,
      current_step,
    });
    signedIn(
      makeAdmin({
        tables: {
          users: { data: { firm_role: 'cco', tenant_id: 'tenant-1' }, error: null },
          deals: {
            data: [
              row('custom', {
                step_id: 'custom:abc',
                seq: null,
                phase_index: 2,
                definition: { title: 'Weekly project update' },
                removed_at: null,
              }),
              row('removed', {
                step_id: 'p1-s12',
                seq: 12,
                phase_index: 1,
                definition: null,
                removed_at: '2026-09-18T00:00:00Z',
              }),
              row('unset', null),
            ],
            error: null,
          },
          deal_memberships: { data: [], error: null },
        },
      }),
    );

    const res = await GET();
    const { deals } = (await res.json()) as { deals: { codename: string; currentStep: unknown }[] };

    expect(deals.map((d) => [d.codename, d.currentStep])).toEqual([
      [
        'custom',
        {
          stepId: 'custom:abc',
          seq: null,
          phaseIndex: 2,
          title: 'Weekly project update',
          assignee: null,
          benchRunStatus: null,
        },
      ],
      ['removed', null],
      ['unset', null],
    ]);
  });
});

describe('POST /api/v1/deals (Gate 0)', () => {
  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await POST(req({ codename: 'Project Falcon', targetName: 'Canva' }));
    expect(res.status).toBe(401);
  });

  it('503 when the server is misconfigured', async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValue(new Error('no env'));
    const res = await POST(req({ codename: 'Project Falcon', targetName: 'Canva' }));
    expect(res.status).toBe(503);
  });

  it('400 when codename is missing', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(req({ targetName: 'Canva' }));
    expect(res.status).toBe(400);
  });

  it('400 when neither targetName nor targetCompanyId is given', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(req({ codename: 'Project Falcon' }));
    expect(res.status).toBe(400);
  });

  it('400 on an invalid member role', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        members: [{ userId: 'u2', dealRole: 'overlord' }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when the conflicts attestation is missing (the Seq 6 gate)', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(req({ codename: 'Project Falcon', targetName: 'Canva' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/conflictsAttestation\.approvedBy/i);
  });

  it('400 when the attestation date is malformed or in the future', async () => {
    signedIn(makeAdmin({}));
    const malformed = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: 'yesterday' },
      }),
    );
    expect(malformed.status).toBe(400);

    signedIn(makeAdmin({}));
    const future = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: '2099-01-01' },
      }),
    );
    expect(future.status).toBe(400);
    const body = (await future.json()) as { error: string };
    expect(body.error).toMatch(/cannot be in the future/i);
  });

  it('400 when targetCompanyId is not in the caller tenant (G19)', async () => {
    // companies is queried twice: bank lookup (found), then the tenant-scoped
    // target lookup (a cross-tenant id → not found).
    signedIn(
      makeAdmin({
        tables: {
          users: { data: { tenant_id: 'tenant-1' }, error: null },
          companies: [
            { data: { id: 'bank-1' }, error: null }, // bank
            { data: null, error: null }, // cross-tenant target → not found
          ],
        },
      }),
    );
    const res = await POST(
      req({ codename: 'Project Falcon', targetCompanyId: 'other-tenant-co', conflictsAttestation: ATTESTATION }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found in this firm/i);
  });

  it('422 when the code name does not mask the target', async () => {
    signedIn(makeAdmin({ tables: withBankTenant }));
    const res = await POST(
      req({ codename: 'Project Canva', targetName: 'Canva', conflictsAttestation: ATTESTATION }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { field?: string };
    expect(body.field).toBe('codename');
  });

  it('409 when the code name is already live', async () => {
    const admin = makeAdmin({
      tables: withBankTenant,
      rpc: { data: null, error: { code: '23505', message: 'duplicate key deals_codename_unique_active' } },
    });
    signedIn(admin);
    const res = await POST(
      req({ codename: 'Project Falcon', targetName: 'Canva', conflictsAttestation: ATTESTATION }),
    );
    expect(res.status).toBe(409);
  });

  it('422 on a wall breach from the RPC', async () => {
    const admin = makeAdmin({
      tables: withBankTenant,
      rpc: { data: null, error: { code: 'P0001', message: 'wall breach: user x is in department "research"' } },
    });
    signedIn(admin);
    const res = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        members: [{ userId: 'u2', dealRole: 'deal_team' }],
        conflictsAttestation: ATTESTATION,
      }),
    );
    expect(res.status).toBe(422);
  });

  it('403 when the actor lacks Create deals (Finding 14)', async () => {
    signedIn(
      makeAdmin({
        tables: withBankTenant,
        rpc: { data: null, error: { code: 'P0001', message: 'not permitted to create deals' } },
      }),
    );
    const res = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        conflictsAttestation: ATTESTATION,
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not permitted to create deals');
  });

  it('400 when the bank has no notify recipient', async () => {
    signedIn(
      makeAdmin({
        tables: withBankTenant,
        rpc: { data: null, error: { code: 'P0001', message: 'no gate0 notify recipient' } },
      }),
    );
    const res = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        conflictsAttestation: ATTESTATION,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Receive new-mandate notices/i);
  });

  it('201 with deal, memberships, notified, and screening on success', async () => {
    const rpcData = {
      deal: { id: 'd1', code: 'FALCO-2026-123', codename: 'Project Falcon', status: 'intake', entryStepSeq: 1, currentStepSeq: 1 },
      memberships: [{ userId: 'md-1', dealRole: 'md' }],
      notified: [{ userId: 'cco-1', at: '2026-07-14T10:00:00Z' }],
    };
    const admin = makeAdmin({ tables: withBankTenant, rpc: { data: rpcData, error: null } });
    signedIn(admin);
    const res = await POST(
      req({
        codename: 'Project Falcon',
        targetName: 'Canva',
        entryStepSeq: 1,
        conflictsAttestation: ATTESTATION,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as typeof rpcData & { screening: { verdict: string } };
    expect(body.deal).toMatchObject({ code: 'FALCO-2026-123', codename: 'Project Falcon' });
    expect(body.memberships).toHaveLength(1);
    expect(body.notified).toHaveLength(1);
    expect(body.screening.verdict).toBe('compliant');

    // The RPC was invoked with the resolved actor/tenant/bank and full payload,
    // including the conflicts attestation the RPC persists and audits.
    expect(admin.rpc).toHaveBeenCalledWith(
      'create_deal_gate0',
      expect.objectContaining({
        p_actor_id: 'md-1',
        p_tenant_id: 'tenant-1',
        p_bank_id: 'bank-1',
        p_codename: 'Project Falcon',
        p_target_name: 'Canva',
        p_conflicts: ATTESTATION,
      }),
    );
    expect(provisionDealDataroomOnCreate).toHaveBeenCalledWith(
      admin,
      'd1',
      'FALCO-2026-123',
    );
  });

  it('seeds the RPC with the 61 MVP rail steps in rail order', async () => {
    const admin = makeAdmin({
      tables: withBankTenant,
      rpc: { data: { deal: { id: 'd1', code: 'FALCO-2026-123' }, memberships: [], notified: [] }, error: null },
    });
    signedIn(admin);

    await POST(req({ codename: 'Project Falcon', targetName: 'Canva', conflictsAttestation: ATTESTATION }));

    const [, args] = admin.rpc.mock.calls[0] as unknown as [string, { p_steps: Array<{ stepId: string }> }];
    const stepIds = args.p_steps.map((step) => step.stepId);
    expect(args.p_steps).toHaveLength(61);
    expect(args.p_steps.slice(0, 4)).toEqual([
      { stepId: 'p1-s7', seq: 7, phaseIndex: 1, displayOrder: 1 },
      { stepId: 'p1-s6', seq: 6, phaseIndex: 1, displayOrder: 2 },
      { stepId: 'g0-notify', seq: 0, phaseIndex: 1, displayOrder: 3 },
      { stepId: 'p1-s8', seq: 8, phaseIndex: 1, displayOrder: 4 },
    ]);
    expect(stepIds.filter((id) => ['p1-s1', 'p1-s2', 'p1-s3', 'p1-s4', 'p1-s5'].includes(id))).toEqual([]);
    expect(args.p_steps).toEqual(railSeedRows(MVP_DEAL_RAIL));
  });

  it.each([
    ['omitted', undefined],
    ['not a step on the MVP rail', 3],
  ])('starts the deal at the first step after Gate 0 when entryStepSeq is %s', async (_label, entryStepSeq) => {
    const admin = makeAdmin({
      tables: withBankTenant,
      rpc: { data: { deal: { id: 'd1', code: 'FALCO-2026-123' }, memberships: [], notified: [] }, error: null },
    });
    signedIn(admin);

    await POST(req({ codename: 'Project Falcon', targetName: 'Canva', entryStepSeq, conflictsAttestation: ATTESTATION }));

    const [, args] = admin.rpc.mock.calls[0] as unknown as [
      string,
      { p_entry_step_seq: number; p_entry_phase: number; p_steps: Array<{ stepId: string; seq: number }> },
    ];
    expect(args.p_entry_step_seq).toBe(8);
    expect(args.p_entry_phase).toBe(1);
    expect(args.p_steps.filter((step) => step.seq === args.p_entry_step_seq).map((step) => step.stepId)).toEqual(['p1-s8']);
  });

  it('keeps a requested entryStepSeq that names a step on the MVP rail', async () => {
    const admin = makeAdmin({
      tables: withBankTenant,
      rpc: { data: { deal: { id: 'd1', code: 'FALCO-2026-123' }, memberships: [], notified: [] }, error: null },
    });
    signedIn(admin);

    await POST(req({ codename: 'Project Falcon', targetName: 'Canva', entryStepSeq: 12, conflictsAttestation: ATTESTATION }));

    const [, args] = admin.rpc.mock.calls[0] as unknown as [string, { p_entry_step_seq: number }];
    expect(args.p_entry_step_seq).toBe(12);
  });
});
