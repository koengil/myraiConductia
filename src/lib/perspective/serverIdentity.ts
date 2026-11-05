import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { USER_STATUS } from '@/lib/constants/users';
import type { PerspectiveId } from '@/lib/perspective/access';

/**
 * Server-side shell identity (platform_onboarding). Resolves the signed-in
 * user's onboarding status and internal/external classification so the
 * (authed) layout can pick the shell perspective and contain invited users.
 *
 * Fail-open to the internal MD shell ('storm'): when Supabase is unconfigured
 * or the profile is missing, the shell renders as today and the API
 * predicates remain the enforcement layer (ADR-0009 — nav gating is
 * presentation, not security).
 */
export type ShellIdentity = {
  userId: string;
  perspective: PerspectiveId;
  isExternal: boolean;
  isInvited: boolean;
};

export async function getShellIdentity(): Promise<ShellIdentity | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const admin = createSupabaseAdminClient();
    const { data: profile } = await admin
      .from('users')
      .select('is_external, status')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) return null;

    const isExternal = profile.is_external === true;
    return {
      userId: user.id,
      perspective: isExternal ? 'external' : 'storm',
      isExternal,
      isInvited: profile.status === USER_STATUS.INVITED,
    };
  } catch {
    return null;
  }
}
