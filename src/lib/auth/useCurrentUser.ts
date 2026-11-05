'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  organizationRoleLabel,
  type CompanyRole,
  type FirmRole,
} from '@/lib/constants/roles';
import type { CompanyEffectivePermission } from '@/lib/api/v1/companyAccess';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export type CurrentUserProfile = {
  id: string;
  email: string;
  full_name: string;
  display_name: string | null;
  firm_role: FirmRole | null;
  department: string | null;
  is_external: boolean;
  status: string;
  company_id: string | null;
  company_role: CompanyRole | null;
  can_invite: boolean;
};

export type CurrentMandate = {
  dealId: string;
  code: string;
  codename: string;
  status: string;
  dealRole: string;
  targetName: string | null;
};

export type CurrentUser = {
  user: CurrentUserProfile;
  company: { id: string; name: string } | null;
  mandate: CurrentMandate | null;
  company_permissions?: CompanyEffectivePermission[];
};

type State =
  | { status: 'loading'; email: string | null }
  | { status: 'ready'; data: CurrentUser }
  | { status: 'error'; email: string | null };

/** Chrome / profile identity. Deal-seat titles stay on the deal, not here. */
export function roleLabelFor(
  user: CurrentUserProfile,
  _mandate?: CurrentMandate | null,
): string {
  return organizationRoleLabel(user);
}

export function initialsFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim() ?? '';
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function initialsFor(user: CurrentUserProfile): string {
  const named = (user.display_name || user.full_name).trim();
  if (named && !named.includes('@')) {
    const parts = named.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (/[.\-_]/.test(named)) {
      return initialsFromEmail(`${named}@local`);
    }
    return named.slice(0, 2).toUpperCase();
  }
  return initialsFromEmail(user.email);
}

async function fetchCurrentUser(): Promise<CurrentUser> {
  const res = await fetch('/api/v1/me', {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error || `me: ${res.status}`);
  }
  return (await res.json()) as CurrentUser;
}

// One revalidation request at a time across every mounted hook instance: the
// shell, the nav and a page all read the current user, and a tab regaining
// focus must not fan out into ten identical /me requests.
let inflight: Promise<CurrentUser> | null = null;
function revalidateCurrentUser(): Promise<CurrentUser> {
  if (!inflight) {
    inflight = fetchCurrentUser().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function useCurrentUser() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [state, setState] = useState<State>({ status: 'loading', email: null });
  // Every explicit reload() takes a new ticket. A background revalidation
  // remembers the ticket it started under and only applies if no reload
  // began after it, so a slow refocus read can never overwrite the answer
  // to a write the user just made (profile save, mandate change).
  const reloadTicket = useRef(0);

  useEffect(() => {
    let active = true;
    try {
      void createSupabaseBrowserClient()
        .auth.getUser()
        .then(({ data }) => {
          if (active) setSessionEmail(data.user?.email ?? null);
        })
        .catch(() => {
          /* session email is only used for avatar fallback */
        });
    } catch {
      /* unconfigured in tests / local without env */
    }
    return () => {
      active = false;
    };
  }, []);

  // Manual refresh (e.g. after a mandate or membership change). Sets the
  // loading state, then resolves. Kept out of the mount effect so the effect
  // never calls setState synchronously (react-hooks/set-state-in-effect).
  const reload = useCallback(async () => {
    reloadTicket.current += 1;
    setState((prev) => ({
      status: 'loading',
      email: prev.status === 'ready' ? sessionEmail : prev.email ?? sessionEmail,
    }));
    try {
      setState({ status: 'ready', data: await fetchCurrentUser() });
    } catch {
      setState({ status: 'error', email: sessionEmail });
    }
  }, [sessionEmail]);

  useEffect(() => {
    let active = true;
    fetchCurrentUser()
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch(() => {
        if (active) setState({ status: 'error', email: sessionEmail });
      });
    return () => {
      active = false;
    };
    // Session email is only the avatar fallback; do not refetch /me when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  }, []);

  // Permissions change under a live session (a director revokes access in
  // another window). Re-read /me when the tab regains focus, silently: the
  // last answer stays on screen until a fresh one replaces it, and a failed
  // revalidation never downgrades a signed-in user to the error state.
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === 'hidden') return;
      const ticket = reloadTicket.current;
      revalidateCurrentUser()
        .then((data) => {
          if (ticket === reloadTicket.current) setState({ status: 'ready', data });
        })
        .catch(() => {
          /* keep the last known answer; the next protected request decides */
        });
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, []);

  const resolved =
    state.status === 'ready'
      ? state
      : { ...state, email: state.email ?? sessionEmail };

  return { state: resolved, reload };
}
