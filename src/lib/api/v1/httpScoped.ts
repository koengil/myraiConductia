import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMfaRequiredForUser } from '@/lib/auth/mfaPolicy';
import { enforceWorkIdentityHook } from '@/lib/auth/workIdentityHook';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { refuse } from '@/lib/log/gate';
import {
  accessUnverified,
  authUnavailable,
  isAuthOutage,
  workIdentityHookRefused,
  type ApiUser,
} from './http';

/**
 * requireApiUser's user-scoped sibling (ADR-006, ADR-008, Q8). It repeats the
 * same authentication, MFA and onboarding checks, then hands back the
 * caller's own session client instead of a service-role one. Every read on
 * `db` runs under RLS as the signed-in user, so the database policies are the
 * gate; every write is a security definer RPC that takes the actor from
 * auth.uid().
 *
 * There is deliberately no admin client here and no option to get one: the
 * discovery routes use this helper, and ESLint forbids them to import
 * createSupabaseAdminClient or requireApiUser.
 */
export type ScopedApiUser =
  | { ok: true; user: ApiUser; db: SupabaseClient }
  | { ok: false; response: NextResponse };

export async function requireApiUserScoped(): Promise<ScopedApiUser> {
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return refuse(NextResponse.json({ error: 'Server misconfigured' }, { status: 503 }),
      { evt: 'auth_unavailable', reason: 'misconfigured', status: 503, gate: 'api_scoped' });
  }
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error && isAuthOutage(error)) {
    return refuse(authUnavailable(), { evt: 'auth_unavailable', reason: 'session_read', status: 503, gate: 'api_scoped' });
  }
  if (error || !user?.email) {
    return refuse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      { evt: 'auth_denied', reason: 'no_session', status: 401, gate: 'api_scoped' });
  }

  if ((await enforceWorkIdentityHook(supabase, user)) === 'refused') {
    return refuse(workIdentityHookRefused(),
      { evt: 'auth_denied', reason: 'work_identity_hook', status: 401, gate: 'api_scoped', user: user.id });
  }

  if (isMfaRequiredForUser(user)) {
    const { data: assurance, error: assuranceError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError) {
      return refuse(NextResponse.json({ error: 'mfa_unavailable' }, { status: 503 }),
        { evt: 'auth_unavailable', reason: 'mfa_level', status: 503, gate: 'api_scoped' });
    }
    if (assurance.currentLevel !== 'aal2') {
      return refuse(NextResponse.json({ error: 'mfa_required' }, { status: 403 }),
        { evt: 'auth_denied', reason: 'mfa_required', status: 403, gate: 'api_scoped', user: user.id });
    }
  }

  // The caller's own row is readable under users_select, so the onboarding
  // check needs no service role.
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('status, company_id')
    .eq('id', user.id)
    .maybeSingle();
  // An unreadable profile must not pass the onboarding gate (#222).
  if (profileError) {
    return refuse(accessUnverified(), { evt: 'auth_unavailable', reason: 'profile_read', status: 503, gate: 'api_scoped' });
  }
  if (profile?.status === 'invited') {
    return refuse(NextResponse.json({ error: 'onboarding_incomplete' }, { status: 403 }), {
      evt: 'auth_denied', reason: 'onboarding_incomplete', status: 403, gate: 'api_scoped',
      user: user.id, company: profile.company_id ?? undefined,
    });
  }

  return {
    ok: true,
    user: { id: user.id, email: user.email, companyId: profile?.company_id ?? null },
    db: supabase as unknown as SupabaseClient,
  };
}
