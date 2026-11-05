import LeadsPageClient from './page.client';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { outsidePartyPageRedirect } from '@/lib/navigation/navPolicy';
import { getNavUser } from '@/lib/navigation/serverNav';

/**
 * /leads — project-less (tier-2) lead registration surface (Task 2). An MD
 * registers a lead by name; it persists as a `client`-type company via
 * POST /api/v1/companies. The relationship map and stakeholder map on the
 * form are a deliberate this-week visualization only (local state, no
 * schema). Registered leads become selectable in Task 3's Gate 0 target step.
 * A seller or buyer with no company is sent home (outsidePartyPageRedirect).
 */
export default async function LeadsPage() {
  const home = outsidePartyPageRedirect(await getNavUser());
  if (home) redirect(home);

  return (
    <Suspense
      fallback={
        <div
          className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-[var(--surface-warm)]"
          aria-busy="true"
        >
          <span
            aria-hidden="true"
            className="size-6 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
          />
        </div>
      }
    >
      <LeadsPageClient />
    </Suspense>
  );
}
