'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { abortAllReads } from '@/lib/api/inflightRead';
import { clearLocalStores } from '@/lib/session/clearLocalStores';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Sign out: cut every shared read first (#162: no read started as this user
 * may deliver after the sign-out), clear the Supabase session and local
 * stores, then route to /sign-in. On failure (a throw, or signOut resolving
 * with an error) nothing is cleared, `signingOut` resets and `error` holds a
 * retry message.
 */
export function useSignOut() {
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const signOut = React.useCallback(async () => {
    setError(null);
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowserClient();
      abortAllReads();
      // auth-js reports a refused sign-out as { error }; it does not throw.
      // The session survives, so nothing is cleared and nobody is routed.
      const { error: refused } = await supabase.auth.signOut();
      if (refused) throw refused;
      clearLocalStores();
      router.replace('/sign-in');
      router.refresh();
    } catch {
      setSigningOut(false);
      setError('Could not sign out. Try again.');
    }
  }, [router]);

  return { signOut, signingOut, error };
}
