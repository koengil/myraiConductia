import { redirect } from 'next/navigation';

import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { isMfaRequiredForUser } from '@/lib/auth/mfaPolicy';
import {
  WORK_IDENTITY_HOOK_REFUSAL,
  checkWorkIdentityHook,
} from '@/lib/auth/workIdentityHook';
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { safeAuthDestination } from '@/lib/auth/redirect';
import TwoFactorPageClient from './page.client';

export const dynamic = 'force-dynamic';

const WORK_IDENTITY_CONFIRM_PATH = '/join/confirm';

type TwoFactorPageProps = {
  searchParams: Promise<{ redirectTo?: string | string[] }>;
};

export default async function TwoFactorPage({ searchParams }: TwoFactorPageProps) {
  const params = await searchParams;
  const requestedDestination = Array.isArray(params.redirectTo)
    ? params.redirectTo[0]
    : params.redirectTo;
  const destination = safeAuthDestination(requestedDestination);

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    redirect(`/sign-in?redirectTo=${encodeURIComponent(destination)}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/sign-in?redirectTo=${encodeURIComponent(destination)}`);
  }

  // Before the profile read and any enrolment: a work-identity session the
  // token hook did not issue never reaches factor setup (#316). The middleware
  // has already refreshed or signed it out (a Server Component cannot persist
  // cookies), so this check only reads.
  if ((await checkWorkIdentityHook(supabase, user)) === 'refused') {
    redirect(`/sign-in?error=${WORK_IDENTITY_HOOK_REFUSAL}`);
  }

  const admin = createSupabaseAdminClient();
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('status')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) throw new Error('Unable to verify the user profile status');
  if (profile?.status === 'invited') {
    // A pending work-identity invitee holds an OAuth session (the token hook
    // admits no other invited profile through OAuth). It enrolls here and may
    // continue only to the confirmation screen; every other invited user
    // finishes the legacy mailbox-code acceptance first.
    const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const viaWorkIdentity = (assurance?.currentAuthenticationMethods ?? []).some(
      (entry) => (typeof entry === 'string' ? entry : entry.method) === 'oauth',
    );
    if (!viaWorkIdentity || !(await isFlagEnabled('work_identity_onboarding'))) {
      redirect('/accept-invite');
    }
    return <TwoFactorPageClient destination={WORK_IDENTITY_CONFIRM_PATH} />;
  }

  if (!isMfaRequiredForUser(user)) redirect(destination);

  return <TwoFactorPageClient destination={destination} />;
}
