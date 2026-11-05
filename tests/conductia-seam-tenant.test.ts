import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));
vi.mock('@/lib/dataroom/steps', () => ({ loadDealByIdOrCode: vi.fn() }));
vi.mock('@/lib/conductia/lead', () => ({ loadConductiaLead: vi.fn() }));

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { loadConductiaLead } from '@/lib/conductia/lead';
import { requireConductiaLead } from '@/lib/conductia/route';
import { mdBriefingScopes, mintTriggerToken, verifyTriggerClaims } from '@/lib/ignatious/jwt';

/*
 * Prelaunch audit PL-02: the agent layer had no per-firm tenancy.
 *
 * PR #188 made the token unforgeable and bound it to the DEAL it names. That
 * closes "a token for lead X used on lead Y", but not "a genuinely signed
 * token for tenant A, correctly naming lead X, when lead X belongs to tenant
 * B" -- because nothing in the token said which firm it was minted for.
 *
 * The tenant now rides in the signed claims and the lead boundary enforces it.
 * The handle in `x-conductia-tenant-id` is a DIFFERENT thing: one constant per
 * deployment, so it could never separate two firms.
 */

const LEAD = 'FALCO-2026-100';
const DEAL_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SECRET = 'test-signing-secret';

function fakeAdmin() {
  const build = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update']) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = async () => ({ data: null, error: null });
    builder.single = async () => ({ data: null, error: null });
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return builder;
  };
  return { from: () => build() };
}

function seamRequest(bearer: string): Request {
  return new Request(`http://localhost:3000/v1/leads/${LEAD}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'x-conductia-tenant-id': 'tn_demo',
      'x-conductia-lead-id': LEAD,
      'x-conductia-agent-name': 'md-briefing',
      'x-conductia-run-id': 'run_1',
    },
  });
}

function tokenFor(tenant: string): string {
  return mintTriggerToken({
    agentName: 'md-briefing',
    dealId: LEAD,
    conductiaTenantId: tenant,
    scopes: mdBriefingScopes(),
  });
}

/**
 * Re-sign a token over edited claims. Do not merely edit: reusing the original
 * signature over changed claims fails on the SIGNATURE, so a test built that
 * way passes whether or not the claim under test is ever read.
 */
function resign(
  token: string,
  edit: (claims: Record<string, unknown>) => Record<string, unknown>,
): string {
  const [header, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  const swapped = Buffer.from(JSON.stringify(edit(claims)), 'utf8').toString('base64url');
  const sig = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(`${header}.${swapped}`, 'utf8')
    .digest('base64url');
  return `${header}.${swapped}.${sig}`;
}

/** The lead the callback resolves to, and the firm that owns it. */
function leadOwnedBy(tenant: string | null): void {
  vi.mocked(loadConductiaLead).mockResolvedValue({
    leadId: LEAD,
    ownerTenantId: tenant,
  } as never);
}

beforeEach(() => {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', 'local-dev-key');
  vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', SECRET);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(createSupabaseAdminClient).mockReturnValue(
    fakeAdmin() as unknown as ReturnType<typeof createSupabaseAdminClient>,
  );
  vi.mocked(loadDealByIdOrCode).mockResolvedValue({ id: DEAL_ID, code: LEAD });
  leadOwnedBy(TENANT_A);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('the lead boundary holds a token to the firm it was minted for', () => {
  it('allows a token whose tenant owns the lead', async () => {
    expect((await requireConductiaLead(seamRequest(tokenFor(TENANT_A)), LEAD)).ok).toBe(true);
  });

  it('REFUSES a validly signed token from another firm', async () => {
    // Signed by us, naming this exact lead, inside the replay window. Only the
    // tenant differs -- which is precisely the case PR #188 alone cannot see.
    const gate = await requireConductiaLead(seamRequest(tokenFor(TENANT_B)), LEAD);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(404);
  });

  it('answers another firm exactly as it answers a lead that does not exist', async () => {
    // A company-scoped token passes the deal binding on any deal code, so a
    // distinct refusal here would enumerate another firm's deal codes.
    const refused = await requireConductiaLead(seamRequest(tokenFor(TENANT_B)), LEAD);
    vi.mocked(loadConductiaLead).mockResolvedValue(null);
    const missing = await requireConductiaLead(seamRequest(tokenFor(TENANT_B)), LEAD);
    if (refused.ok || missing.ok) throw new Error('expected two refusals');
    expect(refused.response.status).toBe(missing.response.status);
    expect(await refused.response.text()).toBe(await missing.response.text());
  });

  it('does not disclose the owning tenant in the refusal', async () => {
    const gate = await requireConductiaLead(seamRequest(tokenFor(TENANT_B)), LEAD);
    if (gate.ok) throw new Error('expected a refusal');
    const body = await gate.response.text();
    expect(body).not.toContain(TENANT_A);
  });

  it('logs the real reason the response hides', async () => {
    await requireConductiaLead(seamRequest(tokenFor(TENANT_B)), LEAD);
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('"reason":"tenant_binding"');
  });

  it('refuses a claim when the lead has no owning tenant recorded', async () => {
    // Nothing to compare against proves nothing about ownership. Unreachable
    // with today's NOT NULL tenant columns; the gate must not depend on that.
    leadOwnedBy(null);
    const gate = await requireConductiaLead(seamRequest(tokenFor(TENANT_A)), LEAD);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(404);
  });

  it('refuses a verified token that carries no tenant claim', async () => {
    // Every mint site stamps a tenant, but a company-scoped token without one
    // would pass the deal binding on any lead and then have nothing to hold
    // it to a firm.
    const unclaimed = resign(tokenFor(TENANT_A), (claims) => {
      const rest = { ...claims };
      delete rest.conductiaTenantId;
      return rest;
    });
    const verified = verifyTriggerClaims(`Bearer ${unclaimed}`);
    expect(verified).not.toBeNull();
    expect(verified?.conductiaTenantId).toBeUndefined();
    const gate = await requireConductiaLead(seamRequest(unclaimed), LEAD);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(404);
  });

  it('refuses the shared API key on a lead route', async () => {
    // The instance's own credential carries no tenant claim, so on a lead
    // route it would reach every firm. Only a signed trigger token passes.
    const gate = await requireConductiaLead(seamRequest('local-dev-key'), LEAD);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(401);
    expect(loadConductiaLead).not.toHaveBeenCalled();
  });
});

describe('issuer and audience are verified, not merely written', () => {
  it('refuses a VALIDLY SIGNED token whose aud or iss is wrong', () => {
    const token = tokenFor(TENANT_A);
    // Control: an unchanged re-signed payload must still verify, so the
    // rejections below can only be about the claims.
    expect(verifyTriggerClaims(`Bearer ${resign(token, (claims) => claims)}`)).not.toBeNull();

    expect(
      verifyTriggerClaims(`Bearer ${resign(token, (claims) => ({ ...claims, aud: 'elsewhere' }))}`),
    ).toBeNull();
    expect(
      verifyTriggerClaims(`Bearer ${resign(token, (claims) => ({ ...claims, iss: 'not-us' }))}`),
    ).toBeNull();
  });

  it('carries the tenant through mint and verify', () => {
    expect(verifyTriggerClaims(`Bearer ${tokenFor(TENANT_A)}`)).toMatchObject({
      conductiaTenantId: TENANT_A,
      dealId: LEAD,
    });
  });
});
