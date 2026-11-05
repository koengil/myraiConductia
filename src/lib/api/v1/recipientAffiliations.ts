import type { SupabaseClient } from '@supabase/supabase-js';
import { canManageDealMembersChecked } from './access';
import { isUuid } from './http';
import { normalizeInviteEmail } from './inviteDomain';
import { RECIPIENT_AFFILIATIONS, type AffiliationInput } from '@/lib/constants/recipientAffiliations';

export function parseAffiliationInput(value: unknown): AffiliationInput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const email = typeof v.email === 'string' ? normalizeInviteEmail(v.email) : null;
  if (!email || typeof v.companyId !== 'string' || !isUuid(v.companyId) ||
      !RECIPIENT_AFFILIATIONS.includes(v.affiliation as AffiliationInput['affiliation'])) return null;
  for (const key of ['representedCompanyId', 'userId', 'inviteId']) {
    if (v[key] != null && (typeof v[key] !== 'string' || !isUuid(v[key] as string))) return null;
  }
  if (Boolean(v.userId) === Boolean(v.inviteId)) return null;
  if ((v.affiliation as string).endsWith('_advisor') !== Boolean(v.representedCompanyId)) return null;
  if (v.expectedRevision != null && (!Number.isInteger(v.expectedRevision) || (v.expectedRevision as number) < 1)) return null;
  return {email, companyId:v.companyId, affiliation:v.affiliation as AffiliationInput['affiliation'],
    representedCompanyId:(v.representedCompanyId as string) ?? null,
    userId:(v.userId as string) ?? null, inviteId:(v.inviteId as string) ?? null,
    expectedRevision:(v.expectedRevision as number) ?? null};
}

export async function affiliationManagerStatus(admin: SupabaseClient, actorId: string, dealId: string): Promise<200 | 403 | 503> {
  const [{data:actor,error:actorError},{data:deal,error:dealError}] = await Promise.all([
    admin.from('users').select('tenant_id,is_external,status').eq('id',actorId).maybeSingle(),
    admin.from('deals').select('tenant_id').eq('id',dealId).maybeSingle(),
  ]);
  if (actorError || dealError) return 503;
  if (!actor || !deal || actor.is_external || actor.status !== 'active' || actor.tenant_id !== deal.tenant_id) return 403;
  const permitted = await canManageDealMembersChecked(admin,actorId,dealId);
  return permitted === 'unreadable' ? 503 : permitted ? 200 : 403;
}

export function affiliationRpcStatus(message: string): number {
  if (message.includes('affiliation_revision_conflict')) return 409;
  if (/tenant_mismatch|forbidden|actor_not_found/.test(message)) return 403;
  if (/invalid_|not_found|not_eligible/.test(message)) return 400;
  return 503;
}
