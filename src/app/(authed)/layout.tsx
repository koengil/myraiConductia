import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { resolveFlags } from '@/lib/flags/resolveFlags';
import { supabaseFlagsFetcher } from '@/lib/flags/supabaseSource';
import { getShellIdentity } from '@/lib/perspective/serverIdentity';

/**
 * (authed) route group layout — owns the AI-native shell for the authenticated
 * surfaces: the project picker at `/projects` and the project destinations under
 * /projects/[projectId] (Mandate / Acquirers / Team / Skills). Routes outside
 * this group (sign-in, dev tools) render without the shell. Authentication
 * itself is enforced upstream in middleware, not here; this group only decides
 * which routes get the shell chrome.
 *
 * Resolves the feature-flag snapshot once (server-side) and hands it to the
 * client via FlagsProvider so client surfaces (e.g. the Gate 0 wizard) can read
 * flags with useFlag. resolveFlags is fail-closed (ADR-0007): if Supabase is
 * unconfigured every flag is false, and the fixture demo paths stay in force.
 */
export default async function AuthedGroupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const flags = await resolveFlags(supabaseFlagsFetcher);

  // platform_onboarding: resolve the shell perspective from real identity.
  // An invited user (auth identity exists, invitation not yet accepted) is
  // contained to the accept page — the API layer enforces the same wall
  // (requireApiUser 403 onboarding_incomplete); this redirect is the UX face
  // of it. External users get the scoped rail; everyone internal gets the MD
  // shell exactly as today. Flag off: identical to the pre-onboarding shell.
  let perspective: 'storm' | 'external' = 'storm';
  if (flags.platform_onboarding) {
    const identity = await getShellIdentity();
    if (identity?.isInvited) redirect('/accept-invite');
    if (identity?.isExternal) perspective = 'external';
  }

  return (
    <FlagsProvider value={flags}>
      <AppShell perspective={perspective}>{children}</AppShell>
    </FlagsProvider>
  );
}
