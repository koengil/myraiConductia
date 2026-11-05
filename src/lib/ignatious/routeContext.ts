import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { userCanAccessDeal, userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { errorCodeOf } from '@/lib/errors/upstream';

import { MD_BRIEFING_STEP_ID, readIgnatiousConfig, type IgnatiousConfig } from './config';
import { createControlPlane, IgnatiousRequestError } from './control-plane';
import {
  SKILL_SERVICE_UNAVAILABLE_MESSAGE,
  SKILL_SERVICE_UNCONFIGURED_MESSAGE,
} from './failure';
import { dbFailure } from '@/lib/errors/upstream';

export type IgnatiousRouteAuth = {
  user: { id: string; email: string };
  admin: Awaited<Extract<Awaited<ReturnType<typeof requireApiUser>>, { ok: true }>['admin']>;
  deal: { id: string; code: string; tenantId: string | null };
  config: IgnatiousConfig;
  plane: ReturnType<typeof createControlPlane>;
};

export async function requireIgnatiousDealAccess(
  dealId: string,
): Promise<{ ok: true; ctx: IgnatiousRouteAuth } | { ok: false; response: Response }> {
  const auth = await requireApiUser();
  if (!auth.ok) return auth;

  const config = readIgnatiousConfig();
  if (!config) {
    return {
      ok: false,
      response: jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503),
    };
  }

  let dealRef;
  try {
    dealRef = await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    return {
      ok: false,
      response: jsonError(err instanceof Error ? err.message : 'Failed to resolve deal', 500),
    };
  }
  if (!dealRef) return { ok: false, response: jsonError('Deal not found', 404) };

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealRef.id);
  if (!allowed) return { ok: false, response: dealNotVisible() };

  const { data: deal } = await auth.admin
    .from('deals')
    .select('tenant_id')
    .eq('id', dealRef.id)
    .maybeSingle();

  return {
    ok: true,
    ctx: {
      user: auth.user,
      admin: auth.admin,
      deal: { ...dealRef, tenantId: (deal?.tenant_id as string | null) ?? null },
      config,
      plane: createControlPlane(config),
    },
  };
}

export async function requireIgnatiousDeal(
  dealId: string,
  stepId: string,
): Promise<{ ok: true; ctx: IgnatiousRouteAuth } | { ok: false; response: Response }> {
  if (stepId !== MD_BRIEFING_STEP_ID) {
    return { ok: false, response: jsonError('This step has no Ignatious skill wired', 404) };
  }
  return requireIgnatiousDealAccess(dealId);
}

export type IgnatiousCompanyAuth = {
  user: { id: string; email: string };
  admin: IgnatiousRouteAuth['admin'];
  company: {
    id: string;
    name: string;
    tenantId: string;
    registeredByCompanyId: string | null;
  };
  config: IgnatiousConfig;
  plane: ReturnType<typeof createControlPlane>;
};

export async function requireIgnatiousCompany(
  companyId: string,
): Promise<{ ok: true; ctx: IgnatiousCompanyAuth } | { ok: false; response: Response }> {
  const auth = await requireApiUser();
  if (!auth.ok) return auth;

  const config = readIgnatiousConfig();
  if (!config) {
    return {
      ok: false,
      response: jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503),
    };
  }

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return { ok: false, response: jsonError('Forbidden', 403) };

  const { data: profile } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (!profile?.tenant_id) return { ok: false, response: jsonError('User profile not found', 404) };

  const { data: company } = await auth.admin
    .from('companies')
    .select('id, name, tenant_id, registered_by_company_id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (!company) return { ok: false, response: jsonError('Lead not found', 404) };

  return {
    ok: true,
    ctx: {
      user: auth.user,
      admin: auth.admin,
      company: {
        id: company.id as string,
        name: (company.name as string | null) ?? 'Lead',
        tenantId: company.tenant_id as string,
        registeredByCompanyId: (company.registered_by_company_id as string | null) ?? null,
      },
      config,
      plane: createControlPlane(config),
    },
  };
}

export async function actorDisplayName(
  admin: IgnatiousRouteAuth['admin'],
  userId: string,
): Promise<string | null> {
  const { data } = await admin
    .from('users')
    .select('display_name, full_name')
    .eq('id', userId)
    .maybeSingle();
  const name = data?.display_name?.trim() || data?.full_name?.trim();
  return name || null;
}

/**
 * Does this execution belong to this deal?
 *
 * `executionId` reaches the run status, cancel and artifact routes from the
 * query string. The gate above only proves the caller may reach THIS deal, so
 * without this check a member of any deal could read, cancel, download the
 * artifacts of, and bill any other tenant's run by naming its id. The trigger
 * writes an `agent_run` audit row, so that row is the binding.
 *
 * Deliberately NOT scoped to the actor, unlike `latestExecutionId`: a run a
 * colleague triggered on this deal is legitimately visible to deal members.
 * `latestExecutionId` is actor-scoped for a different reason (resume my own
 * panel). A query error throws so a broken lookup is a 500, never a silent
 * "not yours".
 */
export async function executionBelongsToDeal(
  admin: Pick<IgnatiousRouteAuth['admin'], 'from'>,
  dealId: string,
  executionId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(TABLE.AUDIT_LOG)
    .select('id')
    .eq('deal_id', dealId)
    .eq('action', AUDIT_ACTION.CREATE)
    .contains('detail', { kind: 'agent_run', executionId })
    .limit(1)
    .maybeSingle();
  if (error) throw dbFailure('Agent run lookup', error);
  return Boolean(data);
}

/**
 * The same binding for company-scoped runs (presearch, debrief, twins).
 *
 * A separate function because those triggers write their audit row with a NULL
 * `deal_id` and carry the lead in `detail.companyId` instead — see the insert
 * in `companies/[companyId]/presearch/route.ts`. Matching on `deal_id` would
 * silently never bind them.
 */
export async function executionBelongsToCompany(
  admin: Pick<IgnatiousRouteAuth['admin'], 'from'>,
  companyId: string,
  executionId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(TABLE.AUDIT_LOG)
    .select('id')
    .eq('action', AUDIT_ACTION.CREATE)
    .contains('detail', { kind: 'agent_run', companyId, executionId })
    .limit(1)
    .maybeSingle();
  if (error) throw dbFailure('Agent run lookup', error);
  return Boolean(data);
}

export function ignatiousErrorResponse(error: unknown): Response {
  const status =
    error instanceof IgnatiousRequestError && error.status >= 400 && error.status < 600
      ? error.status
      : 502;
  console.error('[ignatious]', status, errorCodeOf(error));
  if (status >= 500) return jsonError(SKILL_SERVICE_UNAVAILABLE_MESSAGE, status);
  return jsonError(
    error instanceof Error ? error.message : SKILL_SERVICE_UNAVAILABLE_MESSAGE,
    status,
  );
}
