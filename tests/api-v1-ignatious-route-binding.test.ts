import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

const gates = vi.hoisted(() => ({
  requireIgnatiousDeal: vi.fn(),
  requireIgnatiousCompany: vi.fn(),
}));

// Only the auth gates are faked. The binders (executionBelongsToDeal/Company)
// stay real, so these tests prove each route calls them before the control
// plane and before the AI spend ledger.
vi.mock('@/lib/ignatious/routeContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ignatious/routeContext')>()),
  ...gates,
}));

import * as dealRun from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/route';
import * as dealInput from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/input/route';
import * as dealArtifacts from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/artifacts/route';
import * as presearch from '@/app/api/v1/companies/[companyId]/presearch/route';
import * as presearchInput from '@/app/api/v1/companies/[companyId]/presearch/input/route';
import * as presearchArtifacts from '@/app/api/v1/companies/[companyId]/presearch/artifacts/route';
import * as companyRuns from '@/app/api/v1/companies/[companyId]/runs/route';
import * as companyRunsInput from '@/app/api/v1/companies/[companyId]/runs/input/route';

/*
 * Prelaunch audit PL-05 (#197), route level. A caller authorised for deal A or
 * lead A names a run that belongs to another deal or lead. Every proxy
 * operation must answer 404 without reaching the control plane, and a finished
 * foreign run must never land on the caller's AI spend ledger (AQ-14): the
 * ledger is unique on (source, external_id), so a misfiled row would also lock
 * out the rightful firm's row.
 */

const FOREIGN = 'exec_foreign';
const OWNED = 'exec_owned';
const DEAL = 'deal-a';
const STEP = 'p1-s9';
const COMPANY = 'company-a';

/** Every `from(table)` is recorded; the audit binding matches only OWNED. */
function fakeAdmin() {
  const tables: string[] = [];
  const builder: Record<string, unknown> = {};
  let containsArg: Record<string, unknown> | null = null;
  const chain = () => builder;
  for (const k of ['select', 'eq', 'order', 'limit', 'upsert', 'insert', 'update', 'in', 'is', 'gte']) {
    builder[k] = chain;
  }
  builder.contains = (_col: string, value: Record<string, unknown>) => {
    containsArg = value;
    return builder;
  };
  builder.maybeSingle = () =>
    Promise.resolve({
      data: containsArg?.executionId === OWNED ? { id: 'audit-1', actor_id: 'u-owner' } : null,
      error: null,
    });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  const admin = {
    from: (table: string) => {
      tables.push(table);
      containsArg = null;
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { admin, tables };
}

function fakePlane(status: string) {
  return {
    getRun: vi.fn(async (id: string) => ({
      executionId: id,
      status,
      costUsd: 1.25,
      modelIds: ['claude'],
      artifacts: [],
    })),
    cancelRun: vi.fn(async () => ({ cancelled: true })),
    answerRun: vi.fn(async () => ({ accepted: true })),
    getArtifact: vi.fn(async () => new Response('x')),
  };
}

let db: ReturnType<typeof fakeAdmin>;
let plane: ReturnType<typeof fakePlane>;

function arm(status = 'completed') {
  db = fakeAdmin();
  plane = fakePlane(status);
  const user = { id: 'u-caller', email: 'md@firm-a.test' };
  gates.requireIgnatiousDeal.mockResolvedValue({
    ok: true,
    ctx: { user, admin: db.admin, deal: { id: DEAL, code: 'A', tenantId: 't-a' }, config: {}, plane },
  });
  gates.requireIgnatiousCompany.mockResolvedValue({
    ok: true,
    ctx: {
      user,
      admin: db.admin,
      company: { id: COMPANY, name: 'Lead A', tenantId: 't-a', registeredByCompanyId: null },
      config: {},
      plane,
    },
  });
}

const dealCtx = () => ({ params: Promise.resolve({ dealId: DEAL, stepId: STEP }) });
const companyCtx = () => ({ params: Promise.resolve({ companyId: COMPANY }) });
const query = (id: string, extra = '') => new Request(`http://x/r?executionId=${id}${extra}`);
const answer = (id: string) =>
  new Request('http://x/r', {
    method: 'POST',
    body: JSON.stringify({ executionId: id, answers: [{ questionId: 'q1', answer: 'yes' }] }),
  });

const routes: Array<[string, (id: string) => Promise<Response>]> = [
  ['deal step GET (getRun)', (id) => dealRun.GET(query(id), dealCtx())],
  ['deal step DELETE (cancelRun)', (id) => dealRun.DELETE(query(id), dealCtx())],
  ['deal step input POST (answerRun)', (id) => dealInput.POST(answer(id), dealCtx())],
  ['deal step artifacts GET (getArtifact)', (id) => dealArtifacts.GET(query(id, '&artifact=0'), dealCtx())],
  ['presearch GET (getRun, applyCompletedPresearch)', (id) => presearch.GET(query(id), companyCtx())],
  ['presearch DELETE (cancelRun)', (id) => presearch.DELETE(query(id), companyCtx())],
  ['presearch input POST (answerRun)', (id) => presearchInput.POST(answer(id), companyCtx())],
  ['presearch artifacts GET (getArtifact)', (id) => presearchArtifacts.GET(query(id, '&artifact=0'), companyCtx())],
  ['company runs GET (getRun)', (id) => companyRuns.GET(query(id), companyCtx())],
  ['company runs DELETE (cancelRun)', (id) => companyRuns.DELETE(query(id), companyCtx())],
  ['company runs input POST (answerRun)', (id) => companyRunsInput.POST(answer(id), companyCtx())],
];

beforeEach(() => arm());

describe('PL-05: a foreign executionId never reaches the control plane', () => {
  it.each(routes)('%s answers 404 for a run bound elsewhere', async (_name, call) => {
    const res = await call(FOREIGN);
    expect(res.status).toBe(404);
    expect(plane.getRun).not.toHaveBeenCalled();
    expect(plane.cancelRun).not.toHaveBeenCalled();
    expect(plane.answerRun).not.toHaveBeenCalled();
    expect(plane.getArtifact).not.toHaveBeenCalled();
    // The binding lookup is the only read; nothing is written.
    expect(db.tables).toEqual(['audit_log']);
  });
});

describe('PL-05 / AQ-14: spend is recorded only for a bound run', () => {
  it('a foreign executionId poll writes no ai_usage row (deal step)', async () => {
    await dealRun.GET(query(FOREIGN), dealCtx());
    expect(db.tables).not.toContain('ai_usage');
  });

  it('a foreign executionId poll writes no ai_usage row (presearch)', async () => {
    arm('failed');
    await presearch.GET(query(FOREIGN), companyCtx());
    expect(db.tables).not.toContain('ai_usage');
  });

  it('control: the same finished run, bound to this deal, is recorded', async () => {
    const res = await dealRun.GET(query(OWNED), dealCtx());
    expect(res.status).toBe(200);
    expect(plane.getRun).toHaveBeenCalledWith(OWNED);
    expect(db.tables).toContain('ai_usage');
  });

  it('control: the same finished run, bound to this lead, is recorded', async () => {
    arm('failed');
    const res = await presearch.GET(query(OWNED), companyCtx());
    expect(res.status).toBe(200);
    expect(plane.getRun).toHaveBeenCalledWith(OWNED);
    expect(db.tables).toContain('ai_usage');
  });
});
