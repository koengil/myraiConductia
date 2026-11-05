import type { CompanyEffectivePermission } from '@/lib/api/v1/companyAccess';
import type { CompanyMemberAccess, CompanyRolesResponse } from '@/components/company/companyAccessUi';

export type CompanyRosterViewer = {
  id: string;
  firm_role: string | null;
  company_id: string | null;
  company_role: string | null;
  is_external: boolean;
  can_invite: boolean;
};

export type CompanyRosterMember = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  department: string | null;
  firm_role: string | null;
  company_role: string | null;
  can_invite: boolean;
  preferred_deal_role: string | null;
  is_walled: boolean;
};

export type CompanyRosterInvite = {
  id: string;
  email: string;
  companyRole: string;
  status: string;
  deliveryStatus: string;
  expiresAt: string;
};

export type CompanyRosterSnapshot = {
  viewer: CompanyRosterViewer;
  members: CompanyRosterMember[];
  invites: CompanyRosterInvite[];
  viewerPermissions: CompanyEffectivePermission[];
  rolesData: CompanyRolesResponse;
  memberAccess: Record<string, CompanyMemberAccess>;
};

const cache = new Map<string, CompanyRosterSnapshot>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function companyRosterCacheKey(
  companyId: string,
  companyAccessEnabled: boolean,
): string {
  return `${companyId}:${companyAccessEnabled ? 'access' : 'legacy'}`;
}

export function getCompanyRosterSnapshot(
  companyId: string,
  companyAccessEnabled: boolean,
): CompanyRosterSnapshot | null {
  return cache.get(companyRosterCacheKey(companyId, companyAccessEnabled)) ?? null;
}

export function setCompanyRosterSnapshot(
  companyId: string,
  companyAccessEnabled: boolean,
  snapshot: CompanyRosterSnapshot,
) {
  cache.set(companyRosterCacheKey(companyId, companyAccessEnabled), snapshot);
  notify();
}

export function invalidateCompanyRoster(
  companyId?: string,
  companyAccessEnabled?: boolean,
) {
  if (companyId && companyAccessEnabled !== undefined) {
    cache.delete(companyRosterCacheKey(companyId, companyAccessEnabled));
  } else {
    cache.clear();
  }
  notify();
}

export function subscribeCompanyRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
