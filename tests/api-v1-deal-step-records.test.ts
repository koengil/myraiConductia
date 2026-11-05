import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/deals/[dealId]/step-records/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order']) builder[k] = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'cco-1', email: 'cco@bank.dev' } }, error: null }),
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
// Resolve by code, then the overseer tenant check (#116) reads the deal again.
const DEAL: Resp[] = [
  { data: { id: 'd-uuid', code: 'ZZTES-2026-586' }, error: null },
  { data: { tenant_id: 't1' }, error: null },
];

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/deals/{dealId}/step-records', () => {
  it('404 when the deal does not resolve', async () => {
    signedIn(makeAdmin({ deals: { data: null, error: null } }));
    expect((await GET(new Request('http://localhost'), ctx('NOPE'))).status).toBe(404);
  });

  it('names the assignee, the completer and the logged skip per station', async () => {
    signedIn(
      makeAdmin({
        deals: DEAL,
        // requireApiUser reads the profile (MFA policy), then userCanAccessDeal
        // short-circuits on the CCO firm role; the last `users` read is the
        // name lookup for the ids on the rows.
        users: [
          { data: { firm_role: 'cco', tenant_id: 't1' }, error: null },
          { data: { firm_role: 'cco', tenant_id: 't1' }, error: null },
          {
            data: [
              { id: 'u-member', display_name: 'mgumiero9', full_name: null, email: 'm@x' },
              { id: 'u-md', display_name: null, full_name: 'Marcelo Gumiero', email: 'md@x' },
            ],
            error: null,
          },
        ],
        deal_steps: {
          data: [
            {
              step_id: 'p1-s8',
              seq: 8,
              status: 'complete',
              assigned_to: 'u-member',
              completed_by: 'u-md',
              completed_at: '2026-09-10T12:34:44Z',
              completion_note: null,
              work: {},
            },
            {
              step_id: 'p1-s10',
              seq: 10,
              status: 'skipped',
              assigned_to: null,
              completed_by: 'u-md',
              completed_at: '2026-09-10T13:00:00Z',
              completion_note: 'No meeting on this deal',
              work: {
                skip: { approver: 'Storm Duncan', approverRole: 'MD', reason: 'No meeting on this deal', at: 't' },
              },
            },
            {
              step_id: 'p1-s12',
              seq: 12,
              status: 'pending',
              assigned_to: null,
              completed_by: null,
              completed_at: null,
              completion_note: null,
              work: null,
            },
          ],
          error: null,
        },
      }),
    );
    const res = await GET(new Request('http://localhost'), ctx('ZZTES-2026-586'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records).toHaveLength(3);
    expect(body.records[0]).toMatchObject({
      stepId: 'p1-s8',
      assignedToName: 'mgumiero9',
      completedByName: 'Marcelo Gumiero',
      skip: null,
    });
    expect(body.records[1]).toMatchObject({
      stepId: 'p1-s10',
      status: 'skipped',
      completedByName: 'Marcelo Gumiero',
      skip: { approver: 'Storm Duncan', approverRole: 'MD', reason: 'No meeting on this deal' },
    });
    expect(body.records[2]).toMatchObject({ stepId: 'p1-s12', completedByName: null, skip: null });
  });
});
