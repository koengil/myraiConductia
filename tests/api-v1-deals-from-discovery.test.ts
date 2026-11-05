import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// POST /api/v1/deals/from-discovery is Gate 0's zone: it authenticates through
// requireApiUser (clients from @/lib/supabase/server), runs validateGate0Input,
// and calls one service-role RPC with the session user as the actor. The
// clients and the flag are mocked so the handler runs without a server.
const requireFlagMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/dataroom/steps', () => ({
  provisionDealDataroomOnCreate: vi.fn(() => Promise.resolve()),
}));

import { POST } from '@/app/api/v1/deals/from-discovery/route';
import { RAIL_CENSUS_VERSION } from '@/lib/constants/dealSteps';
import { provisionDealDataroomOnCreate } from '@/lib/dataroom/steps';
import { MVP_DEAL_RAIL, railSeedRows } from '@/lib/rail/dealRail';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';

import { captureConsole } from './helpers/consoleCapture';

type Resp = { data: unknown; error: unknown };

/** An admin stub: the users and companies lookups validateGate0Input makes, and the one RPC. */
function makeAdmin(rpcResult: Resp = { data: null, error: null }) {
  const tables: Record<string, Resp> = {
    users: { data: { tenant_id: 'tenant-1' }, error: null },
    companies: { data: { id: 'bank-1' }, error: null },
  };
  const from = (table: string) => {
    const resp = tables[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.limit = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    return builder;
  };
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  return { from, rpc } as unknown as ReturnType<typeof createSupabaseAdminClient> & { rpc: ReturnType<typeof vi.fn> };
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'md-1', email: 'md@bank.dev' }) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: () => Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }) },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const CANDIDATE = '3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d';
const ATTESTATION = { approvedBy: 'Avery Lindqvist', approvedOn: new Date().toISOString().slice(0, 10) };
const VALID = {
  candidateId: CANDIDATE,
  codename: 'Project Kestrel',
  targetName: 'Northwind Robotics',
  entryStepSeq: 48,
  conflictsAttestation: ATTESTATION,
};

function req(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/v1/deals/from-discovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

const CREATED = {
  data: {
    deal: { id: 'deal-1', code: 'KESTR-2026-412', status: 'active' },
    memberships: [{ userId: 'md-1', dealRole: 'md' }],
    notified: [{ userId: 'cco-1', at: '2026-10-09T10:00:00Z' }],
  },
  error: null,
};

beforeEach(() => {
  requireFlagMock.mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/deals/from-discovery', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await POST(req(VALID));
    expect(res.status).toBe(404);
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin());
    expect((await POST(req(VALID))).status).toBe(401);
  });

  it('400 on a body that is not JSON', async () => {
    signedIn(makeAdmin());
    expect((await POST(req(null, '{nope'))).status).toBe(400);
  });

  it.each([
    ['is missing', { ...VALID, candidateId: undefined }],
    ['is not a uuid', { ...VALID, candidateId: 'kestrel' }],
  ])('400 when candidateId %s', async (_label, body) => {
    const admin = makeAdmin();
    signedIn(admin);
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/candidateId/);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['targetCompanyId', { targetCompanyId: 'c-1' }],
    ['codenameTheme', { codenameTheme: 'birds' }],
    ['railTemplate', { railTemplate: { kind: 'catalog' } }],
  ])('400 when the body carries %s (the MD types the identity)', async (_label, extra) => {
    const admin = makeAdmin();
    signedIn(admin);
    const res = await POST(req({ ...VALID, ...extra }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Type the code name and the target');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['is missing', { ...VALID, entryStepSeq: undefined }],
    ['is not on the rail', { ...VALID, entryStepSeq: 999 }],
    ['is not a number', { ...VALID, entryStepSeq: '48' }],
    ['is Gate 0\'s own notice step (seq 0)', { ...VALID, entryStepSeq: 0 }],
  ])('400 when the entry station %s', async (_label, body) => {
    const admin = makeAdmin();
    signedIn(admin);
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Choose a step on the rail');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("runs Gate 0's validation first: the conflicts attestation is required", async () => {
    const admin = makeAdmin();
    signedIn(admin);
    const res = await POST(req({ ...VALID, conflictsAttestation: undefined }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/conflictsAttestation\.approvedBy/);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('422 when the code name gives the target away', async () => {
    const admin = makeAdmin();
    signedIn(admin);
    const res = await POST(req({ ...VALID, codename: 'Project Northwind Robotics' }));
    expect(res.status).toBe(422);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['403 when the actor cannot create deals', { code: '42501', message: 'no_authority' }, 403],
    ['403 from Gate 0 when the core refuses the actor', { code: 'P0001', message: 'not permitted to create deals' }, 403],
    ['404 when the candidate is not visible to the actor', { code: 'P0002', message: 'not_visible' }, 404],
    ['409 when the proposed deal is already a mandate', { code: '23505', message: 'already_promoted' }, 409],
    ['409 when the code name is live on another deal', { code: '23505', message: 'duplicate key value violates unique constraint "deals_codename_live"' }, 409],
    ['409 when the candidate can no longer be promoted', { code: '55000', message: 'candidate_state' }, 409],
    ['409 when discovery holds the lock', { code: '55P03', message: 'canceling statement due to lock timeout' }, 409],
    ['422 on a wall breach', { code: 'P0001', message: 'wall breach: x' }, 422],
    ['500 otherwise', { code: 'XX000', message: 'boom' }, 500],
  ])('%s', async (_label, error, status) => {
    signedIn(makeAdmin({ data: null, error }));
    const res = await POST(req(VALID));
    expect(res.status).toBe(status);
    expect(provisionDealDataroomOnCreate).not.toHaveBeenCalled();
  });

  it('keeps the database message out of a 500 and out of the server log, which carries the code (#331)', async () => {
    const capture = captureConsole();
    try {
      signedIn(makeAdmin({ data: null, error: { code: 'XX000', message: 'new row for relation deals violates check: CANARY-331-F2' } }));
      const res = await POST(req(VALID));
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe('Deal create failed');
      expect(capture.output()).toContain('[from-discovery] promotion failed');
      expect(capture.output()).toContain('XX000');
      expect(capture.output()).not.toContain('CANARY-331-F2');
    } finally {
      capture.restore();
    }
  });

  it('keeps already_promoted apart from a code name in use, which share a SQLSTATE', async () => {
    signedIn(makeAdmin({ data: null, error: { code: '23505', message: 'already_promoted' } }));
    expect(((await (await POST(req(VALID))).json()) as { error: string }).error).toBe('This proposed deal is already a mandate');
    signedIn(makeAdmin({ data: null, error: { code: '23505', message: 'duplicate key' } }));
    expect(((await (await POST(req(VALID))).json()) as { error: string }).error).toBe('Code name is already in use on a live deal');
  });

  it('201 with the deal, and calls the promotion RPC once with the session user as the actor', async () => {
    const admin = makeAdmin(CREATED);
    signedIn(admin, { id: 'md-7', email: 'md7@bank.dev' });
    const res = await POST(
      req({ ...VALID, members: [{ userId: 'u-2', dealRole: 'deal_team' }], actorId: 'someone-else', p_actor_id: 'someone-else' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deal: { id: string; code: string }; screening: { verdict: string }; notified: unknown[] };
    expect(body.deal).toEqual({ id: 'deal-1', code: 'KESTR-2026-412', status: 'active' });
    expect(body.notified).toHaveLength(1);
    expect(body.screening.verdict).toBeTruthy();

    expect(admin.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = admin.rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe('discovery_promote_candidate');
    expect(args).toMatchObject({
      p_actor_id: 'md-7', // the verified session, never the body
      p_tenant_id: 'tenant-1',
      p_bank_id: 'bank-1',
      p_candidate_id: CANDIDATE,
      p_codename: 'Project Kestrel',
      p_target_name: 'Northwind Robotics',
      p_entry_step_seq: 48,
      p_entry_phase: 4,
      p_entry_status: 'active',
      p_members: [{ userId: 'u-2', dealRole: 'deal_team' }],
      p_census_version: RAIL_CENSUS_VERSION,
      p_conflicts: { approvedBy: 'Avery Lindqvist', approvedOn: ATTESTATION.approvedOn },
    });
    expect((args.p_steps as unknown[]).length).toBe(61);
    expect(args.p_steps).toEqual(railSeedRows(MVP_DEAL_RAIL));
    expect(Object.keys(args).sort()).toEqual(
      [
        'p_actor_id', 'p_tenant_id', 'p_bank_id', 'p_candidate_id', 'p_codename', 'p_target_name', 'p_entry_step_seq',
        'p_entry_phase', 'p_entry_status', 'p_members', 'p_screening', 'p_steps', 'p_census_version', 'p_conflicts',
      ].sort(),
    );
  });

  it('opens a phase 1 entry as intake, and never provisions a data room', async () => {
    const admin = makeAdmin(CREATED);
    signedIn(admin);
    const res = await POST(req({ ...VALID, entryStepSeq: 9 }));
    expect(res.status).toBe(201);
    const args = (admin.rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(args.p_entry_phase).toBe(1);
    expect(args.p_entry_status).toBe('intake');
    expect(provisionDealDataroomOnCreate).not.toHaveBeenCalled();
  });
});
