'use client';

import { Suspense } from 'react';

import { DealRail } from '@/components/rail';

/**
 * `/projects/[projectId]/rail` — the Deal Rail destination.
 *
 * The canonical 5-phase / 65-step sell-side lifecycle as a board of phases
 * that zooms into one step; a `?step=` deep link lands zoomed in, hence the
 * Suspense boundary around useSearchParams.
 * Compliance stays a shell concern — this route mounts no second compliance
 * instrument; step runs drive the shell's single ribbon via the session store.
 */
export default function RailPage() {
  return (
    <Suspense fallback={null}>
      <DealRail />
    </Suspense>
  );
}
