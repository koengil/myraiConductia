'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

export const DEAL_DISCOVERY_HASH = '#deal-discovery';

/**
 * Older stored links point at `/profile#deal-discovery`. The `/profile`
 * redirect runs on the server and never sees the hash, so those links land on
 * Settings › Profile while the discovery card lives in Settings › Mail. When
 * Settings opens on Profile with that hash, move to Mail on the client, keeping
 * the hash (and any other query) so the card is still the target.
 */
export function DealDiscoveryHashRedirect({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  React.useEffect(() => {
    if (!enabled || window.location.hash !== DEAL_DISCOVERY_HASH) return;
    const query = new URLSearchParams(window.location.search);
    query.set('section', 'mail');
    router.replace(`/settings?${query.toString()}${DEAL_DISCOVERY_HASH}`);
  }, [enabled, router]);
  return null;
}
