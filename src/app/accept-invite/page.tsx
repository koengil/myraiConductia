import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import AcceptInvitePage from './page.client';

// Flag-off parity: the accept surface does not exist until platform_onboarding
// is enabled (spec-v3 criterion 16).
export const dynamic = 'force-dynamic';

export default async function AcceptInviteRoute() {
  const enabled = await isEnabled('platform_onboarding', supabaseFlagSource);
  if (!enabled) notFound();

  return (
    <Suspense fallback={null}>
      <AcceptInvitePage />
    </Suspense>
  );
}
