import {
  resolveDealStepCapabilities,
  resolveDealStepStructureCapability,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';

export async function requireStructureAuthority(dealIdOrCode: string) {
  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const deal = await loadDealByIdOrCode(auth.admin, dealIdOrCode);
  if (!deal) return { ok: false as const, response: jsonError('Deal not found', 404) };

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return { ok: false as const, response: dealNotVisible() };

  const capable = await resolveDealStepStructureCapability(auth.admin, auth.user.id);
  if (capable === 'unreadable') {
    return { ok: false as const, response: jsonError('Permission lookup failed', 500) };
  }
  if (!capable) {
    return { ok: false as const, response: jsonError('You cannot change this project rail', 403) };
  }

  return { ok: true as const, auth, deal };
}

export async function requireStepWorkAuthority(dealIdOrCode: string, stepRowId: string) {
  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const deal = await loadDealByIdOrCode(auth.admin, dealIdOrCode);
  if (!deal) return { ok: false as const, response: jsonError('Deal not found', 404) };

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return { ok: false as const, response: dealNotVisible() };

  const { data: step, error } = await auth.admin
    .from('deal_steps')
    .select('assigned_to, status')
    .eq('id', stepRowId)
    .eq('deal_id', deal.id)
    .maybeSingle();
  if (error) return { ok: false as const, response: jsonError(error.message, 500) };
  if (!step) return { ok: false as const, response: jsonError('Step not found for this deal', 404) };

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: step.assigned_to as string | null,
    status: step.status as string,
  });
  if (capabilities === 'unreadable') {
    return { ok: false as const, response: jsonError('Permission lookup failed', 500) };
  }
  if (!capabilities.canComplete) {
    return { ok: false as const, response: jsonError('Not permitted to skip this step', 403) };
  }

  return { ok: true as const, auth, deal };
}
