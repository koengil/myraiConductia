import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import {
  homeHref,
  isExternalCompanyDirector,
  navUserFromProfile,
  type NavUser,
} from './navPolicy';

export async function getNavUser(): Promise<NavUser | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const admin = createSupabaseAdminClient();
    const { data: profile } = await admin
      .from('users')
      .select('is_external, firm_role, company_id, company_role, department')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) return null;
    return navUserFromProfile(profile);
  } catch {
    return null;
  }
}

/** Redirect external company directors away from bank-ops surfaces. */
export async function bankOpsRedirectForCurrentUser(): Promise<string | null> {
  if (!(await isEnabled('platform_onboarding', supabaseFlagSource))) return null;
  const navUser = await getNavUser();
  if (!navUser || !isExternalCompanyDirector(navUser)) return null;
  return homeHref(navUser);
}
