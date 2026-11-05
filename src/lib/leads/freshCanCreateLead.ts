import { canCreateLead, navUserFromProfile } from '@/lib/navigation/navPolicy';

/** Live Create leads check. Null means the profile could not be read. */
export async function freshCanCreateLead(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/v1/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: Parameters<typeof navUserFromProfile>[0];
      company_permissions?: Parameters<typeof navUserFromProfile>[1];
    };
    if (!body.user) return null;
    return canCreateLead(navUserFromProfile(body.user, body.company_permissions));
  } catch {
    return null;
  }
}
