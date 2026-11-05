'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { workIdentityConnectCopy } from '@/lib/auth/workIdentityCopy';
import { WORK_IDENTITY_COOKIE } from '@/lib/constants/workIdentity';
import { useFlag } from '@/lib/flags/FlagsContext';

const CONNECTED = 'Work account connected. Use it to sign in from now on.';
const FLASH = WORK_IDENTITY_COOKIE.CONNECTED;

/** Read and clear the one-shot cookie the connect callback sets on a fresh binding. */
function takeConnectedFlash(): boolean {
  const set = document.cookie.split('; ').includes(`${FLASH}=1`);
  if (set) document.cookie = `${FLASH}=; Max-Age=0; Path=/`;
  return set;
}

/**
 * The /auth/work/connect outcome (?connected=1 or ?error=<code>), shown and
 * cleared only with work_identity_onboarding on, so another flow's ?error= is
 * left alone with it off. Read once after mount, then the query is cleared so a
 * reload or bookmark does not replay it. Success needs the callback's one-shot
 * cookie as well, so a crafted or replayed ?connected=1 shows nothing; ?error=
 * renders connect copy only, never another flow's message.
 */
function ConnectResultInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const enabled = useFlag('work_identity_onboarding');
  const [message, setMessage] = React.useState<string | null>(null);

  // Read once after commit: the one-shot cookie is consumed outside render, and
  // the server render (no document) matches the first client render.
  React.useEffect(() => {
    if (!enabled || (!params.has('connected') && !params.has('error'))) return;
    const code = params.get('error');
    const next =
      params.get('connected') === '1'
        ? takeConnectedFlash()
          ? CONNECTED
          : null
        : code
          ? workIdentityConnectCopy(code)
          : null;
    // Never clear a shown result: under StrictMode the effect re-runs after the
    // cookie is consumed, and that second read must not wipe the first.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL and a one-shot cookie once
    if (next) setMessage(next);
    // Drop only the result keys; any other query the page carries survives.
    const rest = new URLSearchParams(params.toString());
    rest.delete('connected');
    rest.delete('error');
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // Only the first URL counts; the replace above changes params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled || !message) return null;
  return (
    <p role="status" aria-live="polite" className="mt-(--space-3) text-(length:--text-sm) text-ink-secondary">
      {message}
    </p>
  );
}

export function ConnectResult() {
  return (
    <React.Suspense fallback={null}>
      <ConnectResultInner />
    </React.Suspense>
  );
}
