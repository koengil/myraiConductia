import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { outsidePartyPageRedirect } from '@/lib/navigation/navPolicy';
import { getNavUser } from '@/lib/navigation/serverNav';

import RailTemplatesPageClient from './page.client';

/** A seller or buyer with no company is sent home (outsidePartyPageRedirect). */
export default async function RailTemplatesPage() {
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
      <RailTemplatesPageClient />
    </Suspense>
  );
}
