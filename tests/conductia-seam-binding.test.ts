import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));
vi.mock('@/lib/dataroom/steps', () => ({ loadDealByIdOrCode: vi.fn() }));
vi.mock('@/lib/dataroom/fileToStep', () => ({
  fileBytesToStepDataroom: vi.fn(async () => undefined),
  safeFileName: (name: string) => name,
}));
vi.mock('@/lib/conductia/lead', () => ({ loadConductiaLead: vi.fn() }));
vi.mock('@/lib/conductia/documents', () => ({
  listLeadDocuments: vi.fn(async () => []),
  documentSummary: vi.fn(),
  persistLeadDocument: vi.fn(async () => ({
    documentId: 'doc-1',
    version: 1,
    folder: 'md-brief',
    documentType: 'memo',
    uploadedAt: '2026-09-18T00:00:00Z',
  })),
}));

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { fileBytesToStepDataroom } from '@/lib/dataroom/fileToStep';
import { loadConductiaLead } from '@/lib/conductia/lead';
import { requireConductiaLead } from '@/lib/conductia/route';
import { mintTriggerToken, mdBriefingScopes } from '@/lib/ignatious/jwt';
import { POST as filePost } from '@/app/v1/leads/[leadId]/documents/route';

const LEAD = 'FALCO-2026-100';
const DEAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEAL_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-signing-secret';

type Result = { data: unknown; error: unknown };

/** Rows the fake admin client answers with, per table, optionally by eq filter. */
let rows: Record<string, Result | ((filters: Record<string, unknown>) => Result)>;

function fakeAdmin() {
  const build = (table: string) => {
    const filters: Record<string, unknown> = {};
    const result = (): Result => {
      const entry = rows[table] ?? { data: null, error: null };
      return typeof entry === 'function' ? entry(filters) : entry;
    };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'in', 'order', 'limit', 'insert', 'update']) {
      builder[method] = () => builder;
    }
    builder.eq = (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    };
    builder.maybeSingle = async () => result();
    builder.single = async () => result();
    builder.then = (resolve: (v: unknown) => unknown) => resolve(result());
    return builder;
  };
  return { from: (table: string) => build(table) };
}

function seamEnv(): void {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', 'local-dev-key');
  vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', SECRET);
}

function seamRequest(bearer: string, body?: unknown): Request {
  return new Request(`http://localhost:3000/v1/leads/${LEAD}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'x-conductia-tenant-id': 'tn_demo',
      'x-conductia-lead-id': LEAD,
      'x-conductia-agent-name': 'md-briefing',
      'x-conductia-run-id': 'run_1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  rows = {};
  seamEnv();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(createSupabaseAdminClient).mockReturnValue(
    fakeAdmin() as unknown as ReturnType<typeof createSupabaseAdminClient>,
  );
  // Owned by the tenant every token here is minted for, so these cases only
  // ever exercise the deal binding, never the tenant wall behind it.
  vi.mocked(loadConductiaLead).mockResolvedValue({ leadId: LEAD, ownerTenantId: 'tenant-a' } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('a token is bound to the deal it was minted for', () => {
  it('refuses a token minted for a different deal', async () => {
    vi.mocked(loadDealByIdOrCode).mockImplementation(async (_admin, idOrCode: string) =>
      idOrCode === LEAD
        ? { id: DEAL_ID, code: LEAD }
        : { id: OTHER_DEAL_ID, code: 'OTHER-2026-001' },
    );
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: 'OTHER-2026-001',
      scopes: mdBriefingScopes(),
    });
    const gate = await requireConductiaLead(seamRequest(token), LEAD);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    // The missing-lead answer, so a deal token cannot tell another firm's
    // code from one nobody holds.
    expect(gate.response.status).toBe(404);
    expect(await gate.response.json()).toMatchObject({
      error: { code: 'not_found', detail: { leadId: LEAD } },
    });
    expect(loadConductiaLead).not.toHaveBeenCalled();
  });

  it('allows a token minted for this deal under another of its identifiers', async () => {
    // Bench mints the deal uuid; the callback path carries the deal code.
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: DEAL_ID, code: LEAD });
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: DEAL_ID,
      scopes: mdBriefingScopes(),
    });
    expect((await requireConductiaLead(seamRequest(token), LEAD)).ok).toBe(true);
  });

  describe('a company-scoped token (presearch, digital twin)', () => {
    const COMPANY_A = '33333333-3333-4333-8333-333333333333';
    const COMPANY_B = '44444444-4444-4444-8444-444444444444';

    /** LEAD's deal targets `target`; both companies exist. */
    function leadTargets(target: string): void {
      vi.mocked(loadDealByIdOrCode).mockImplementation(async (_admin, idOrCode: string) =>
        idOrCode === LEAD || idOrCode === DEAL_ID ? { id: DEAL_ID, code: LEAD } : null,
      );
      rows.deal_parties = { data: [{ company_id: target }], error: null };
      rows.companies = (filters) => ({
        data: [COMPANY_A, COMPANY_B].includes(filters.id as string) ? { id: filters.id } : null,
        error: null,
      });
    }

    function companyToken(companyId: string): string {
      return mintTriggerToken({
        conductiaTenantId: 'tenant-a',
        agentName: 'presearch',
        dealId: companyId,
        scopes: mdBriefingScopes(),
      });
    }

    async function expectRefused(token: string): Promise<void> {
      const gate = await requireConductiaLead(seamRequest(token), LEAD);
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.response.status).toBe(404);
      expect(await gate.response.json()).toMatchObject({
        error: { code: 'not_found', detail: { leadId: LEAD } },
      });
      expect(loadConductiaLead).not.toHaveBeenCalled();
    }

    it('reads the deal that targets its company', async () => {
      leadTargets(COMPANY_A);
      expect((await requireConductiaLead(seamRequest(companyToken(COMPANY_A)), LEAD)).ok).toBe(true);
    });

    it('reads a deal with several targets when its company is any of them', async () => {
      leadTargets(COMPANY_B);
      rows.deal_parties = { data: [{ company_id: COMPANY_B }, { company_id: COMPANY_A }], error: null };
      expect((await requireConductiaLead(seamRequest(companyToken(COMPANY_A)), LEAD)).ok).toBe(true);
    });

    it('is refused on a deal of the same firm that targets another company', async () => {
      leadTargets(COMPANY_B);
      await expectRefused(companyToken(COMPANY_A));
    });

    it('is refused when its claim resolves to nothing', async () => {
      leadTargets(COMPANY_A);
      await expectRefused(companyToken('company-abc'));
      await expectRefused(companyToken('55555555-5555-4555-8555-555555555555'));
    });

    it('fails closed when the binding cannot be read', async () => {
      leadTargets(COMPANY_A);
      rows.deal_parties = { data: null, error: new Error('db down') };
      const gate = await requireConductiaLead(seamRequest(companyToken(COMPANY_A)), LEAD);
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.response.status).toBe(503);
      expect(loadConductiaLead).not.toHaveBeenCalled();
    });
  });
});

describe('the audit actor on a filing cannot be forged', () => {
  const brief = { title: 'MD brief', contentBase64: Buffer.from('hello').toString('base64') };

  beforeEach(() => {
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: DEAL_ID, code: LEAD });
  });

  it('records the named user when the token is signed and they are on the deal', async () => {
    rows = {
      deal_memberships: { data: { id: 'm-1' }, error: null },
      deals: { data: { mandate_owner_id: 'owner-9' }, error: null },
    };
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: LEAD,
      scopes: mdBriefingScopes(),
      userId: 'user-on-deal',
    });
    const res = await filePost(seamRequest(token, brief), {
      params: Promise.resolve({ leadId: LEAD }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(fileBytesToStepDataroom).mock.calls[0][0]).toMatchObject({
      uploadedBy: 'user-on-deal',
    });
  });

  it('falls back to the mandate owner when the named user is not on the deal', async () => {
    rows = {
      deal_memberships: { data: null, error: null },
      deals: { data: { mandate_owner_id: 'owner-9' }, error: null },
    };
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: LEAD,
      scopes: mdBriefingScopes(),
      userId: 'an-outsider',
    });
    const res = await filePost(seamRequest(token, brief), {
      params: Promise.resolve({ leadId: LEAD }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(fileBytesToStepDataroom).mock.calls[0][0]).toMatchObject({
      uploadedBy: 'owner-9',
    });
  });

  it('ignores a userId carried by an unverifiable token under observe', async () => {
    vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_MODE', 'observe');
    rows = {
      deal_memberships: { data: { id: 'm-1' }, error: null },
      deals: { data: { mandate_owner_id: 'owner-9' }, error: null },
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const forged = `${b64({ alg: 'HS256' })}.${b64({
      agentName: 'md-briefing',
      dealId: LEAD,
      userId: 'impersonated',
    })}.local-dev`;
    const res = await filePost(seamRequest(forged, brief), {
      params: Promise.resolve({ leadId: LEAD }),
    });
    expect(res.status).toBe(200);
    // Accepted for the window, but the forged actor never reaches the record.
    expect(vi.mocked(fileBytesToStepDataroom).mock.calls[0][0]).toMatchObject({
      uploadedBy: 'owner-9',
    });
  });
});
