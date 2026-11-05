import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/deals/[dealId]/audit/route';

/*
 * GET /api/v1/deals/{dealId}/audit — the per-deal audit trail, read-side.
 *
 * Contracts under test:
 *   1. A permitted caller gets the deal header (code + code name, never the
 *      target) and the audit_log rows for that deal.
 *   2. A caller who is neither a member nor an overseer gets the unknown-deal
 *      404, so the route never confirms that a deal exists (decision-log D65).
 *   3. An unknown deal 404s; an unauthenticated caller 401s.
 */

type Resp = { data: unknown; error: unknown };

/** Chainable admin stub with a per-table response queue (shift per from()). */
function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order', 'limit']) builder[k] = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'cco-1', email: 'cco@bank.dev' }) {
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

const ctx = (dealId: string) => ({ params: Promise.resolve({ dealId }) });

const dealRow = {
  data: {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'FALCO-2026-123',
    codename: 'Project Falcon',
  },
  error: null,
};

const auditRows = {
  data: [
    {
      id: 'a2',
      ts: '2026-07-21T10:00:01Z',
      action: 'attest',
      document_id: null,
      detail: { checklist: 'conflicts', approved_by: 'Avery Lindqvist', approved_on: '2026-07-20' },
      actor: { id: 'md-1', full_name: 'Storm Duncan', display_name: 'Storm Duncan' },
    },
    {
      id: 'a1',
      ts: '2026-07-21T10:00:00Z',
      action: 'create',
      document_id: null,
      detail: { code: 'FALCO-2026-123', codename: 'Project Falcon' },
      actor: { id: 'md-1', full_name: 'Storm Duncan', display_name: 'Storm Duncan' },
    },
  ],
  error: null,
};

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/deals/{dealId}/audit', () => {
  it('returns the deal header and its audit rows to an overseer', async () => {
    // users → firm_role cco (userCanAccessDeal short-circuits).
    signedIn(
      makeAdmin({
        deals: dealRow,
        users: { data: { firm_role: 'cco' }, error: null },
        audit_log: auditRows,
      }),
    );
    const res = await GET(new Request('http://localhost'), ctx('FALCO-2026-123'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deal: { code: string; codename: string };
      events: Array<{ action: string }>;
    };
    expect(body.deal).toMatchObject({ code: 'FALCO-2026-123', codename: 'Project Falcon' });
    expect(body.events).toHaveLength(2);
    expect(body.events[0].action).toBe('attest');
  });

  it('404s a caller who is neither a member nor an overseer, like an unknown deal', async () => {
    signedIn(
      makeAdmin({
        deals: dealRow,
        users: { data: { firm_role: null }, error: null },
        deal_memberships: { data: null, error: null },
      }),
      { id: 'outsider-1', email: 'outsider@bank.dev' },
    );
    const res = await GET(new Request('http://localhost'), ctx('FALCO-2026-123'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('404s an unknown deal', async () => {
    signedIn(makeAdmin({ deals: { data: null, error: null } }));
    const res = await GET(new Request('http://localhost'), ctx('NOPE-2026-999'));
    expect(res.status).toBe(404);
  });

  it('401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await GET(new Request('http://localhost'), ctx('FALCO-2026-123'));
    expect(res.status).toBe(401);
  });

  describe('document walls on the trail (#229)', () => {
    // i2: internal room, class 2. d4: deal room, class 4. gone: no longer in
    // documents, so it is judged as the most restricted kind.
    const documentEvents = () => ({
      data: [
        { id: 'e1', ts: '2026-09-22T00:00:03Z', action: 'upload', document_id: 'i2',
          detail: { name: 'internal-memo.pdf', room: 'internal', classification: 2 }, actor: null },
        { id: 'e2', ts: '2026-09-22T00:00:02Z', action: 'view', document_id: 'd4',
          detail: { name: 'mnpi-model.xlsx', classification: 4 }, actor: null },
        { id: 'e3', ts: '2026-09-22T00:00:01Z', action: 'upload', document_id: 'gone',
          detail: { stepId: 'p1-s10', fileName: 'deleted.pdf', name: 'deleted.pdf' }, actor: null },
        { id: 'e4', ts: '2026-09-22T00:00:00Z', action: 'create', document_id: null,
          detail: { code: 'FALCO-2026-123' }, actor: null },
      ],
      error: null,
    });
    const documents = {
      data: [
        { id: 'i2', room: 'internal', classification: 2, min_phase: 0 },
        { id: 'd4', room: 'deal', classification: 4, min_phase: 0 },
      ],
      error: null,
    };

    type Event = { id: string; document_id: string | null; detail: Record<string, unknown> };

    async function trailAs(opts: { isExternal: boolean; firmRole: string | null; dealRole: string | null }) {
      signedIn(
        makeAdmin({
          deals: { data: { ...dealRow.data, tenant_id: 't1' }, error: null },
          users: {
            data: { status: 'active', firm_role: opts.firmRole, tenant_id: 't1', is_external: opts.isExternal },
            error: null,
          },
          deal_memberships: {
            data: opts.dealRole ? { id: 'm1', deal_role: opts.dealRole, phase: 0 } : null,
            error: null,
          },
          audit_log: documentEvents(),
          documents,
        }),
        { id: 'viewer-1', email: 'viewer@bank.dev' },
      );
      const res = await GET(new Request('http://localhost'), ctx('FALCO-2026-123'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: Event[] };
      return Object.fromEntries(body.events.map((e) => [e.id, e]));
    }

    it('an external viewer loses the name and document id of internal-room events', async () => {
      const ev = await trailAs({ isExternal: true, firmRole: null, dealRole: 'seller' });
      expect(ev.e1.document_id).toBeNull();
      expect(ev.e1.detail).toEqual({ room: 'internal', classification: 2 });
      // Deal-room class 4: the name is walled, the id is not.
      expect(ev.e2.document_id).toBe('d4');
      expect(ev.e2.detail).not.toHaveProperty('name');
      // A document that no longer resolves fails closed.
      expect(ev.e3.document_id).toBeNull();
      expect(ev.e3.detail).toEqual({ stepId: 'p1-s10' });
      expect(ev.e4.detail).toEqual({ code: 'FALCO-2026-123' });
    });

    it.each(['deal_team', 'read_only'])(
      'a %s viewer sees internal-room names but no class-4 name',
      async (dealRole) => {
        const ev = await trailAs({ isExternal: false, firmRole: null, dealRole });
        expect(ev.e1).toMatchObject({ document_id: 'i2', detail: { name: 'internal-memo.pdf' } });
        expect(ev.e2.document_id).toBe('d4');
        expect(ev.e2.detail).toEqual({ classification: 4 });
        expect(ev.e3.document_id).toBe('gone');
        expect(ev.e3.detail).toEqual({ stepId: 'p1-s10' });
      },
    );

    it.each([
      ['the deal MD', { isExternal: false, firmRole: null, dealRole: 'md' }],
      ['a same-tenant cco', { isExternal: false, firmRole: 'cco', dealRole: null }],
    ] as const)('%s sees every name unredacted', async (_label, viewer) => {
      const ev = await trailAs(viewer);
      expect(ev.e1).toMatchObject({ document_id: 'i2', detail: { name: 'internal-memo.pdf' } });
      expect(ev.e2).toMatchObject({ document_id: 'd4', detail: { name: 'mnpi-model.xlsx' } });
      expect(ev.e3).toMatchObject({ document_id: 'gone', detail: { fileName: 'deleted.pdf', name: 'deleted.pdf' } });
    });
  });
});
