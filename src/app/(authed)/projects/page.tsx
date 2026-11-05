import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BankHome } from '@/components/book/BankHome';
import { ConnectGmailBanner } from '@/components/discovery/ConnectGmailBanner';
import { CommandCenter } from '@/components/workspace/CommandCenter';
import { listMemberDealSummaries } from '@/lib/api/v1/access';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import { isExternalCompanyDirector } from '@/lib/navigation/navPolicy';
import { getNavUser } from '@/lib/navigation/serverNav';
import { getShellIdentity } from '@/lib/perspective/serverIdentity';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * The authenticated home. For the bank this is the Command Center (2026-07-09):
 * every task across live deals, routed to a human or an agent.
 *
 * With platform_onboarding on, an external user (the seller's team, a buyer's
 * team) never sees the bank's home: one deal membership routes them straight
 * into that deal; several render a minimal picker. The deal list is scoped to
 * their memberships server-side.
 */
export default async function AuthenticatedHomePage() {
  if (await isEnabled('platform_onboarding', supabaseFlagSource)) {
    const navUser = await getNavUser();
    if (navUser && isExternalCompanyDirector(navUser)) {
      return <CommandCenter />;
    }

    const identity = await getShellIdentity();
    if (identity?.isExternal) {
      const admin = createSupabaseAdminClient();
      const { data: deals } = await listMemberDealSummaries(admin, identity.userId);

      // Deal URLs carry the code, never the database uuid.
      if (deals.length === 1) redirect(`/projects/${deals[0].code}`);

      return (
        <div className="mx-auto w-full max-w-[560px] px-[var(--page-pad)] py-[var(--space-10)]">
          {/* Quiet sentence-case label — the uppercase eyebrow is retired. */}
          <p className="eyebrow">
            Your deals
          </p>
          <h1 className="mt-[var(--space-2)] text-[length:var(--text-xl)] font-semibold leading-tight tracking-[-0.01em] text-[var(--ink)]">Select a deal</h1>
          <ul className="mt-[var(--space-6)] flex flex-col gap-[var(--space-2)]">
            {deals.map((deal) => (
              <li key={deal.id}>
                <Link
                  href={`/projects/${deal.code}`}
                  className="flex min-h-[48px] items-baseline justify-between rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)] transition-colors duration-150 hover:border-[var(--stroke-strong)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
                >
                  <span className="text-[length:var(--text-md)] font-medium text-[var(--ink)]">{deal.codename}</span>
                  <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {deal.code}
                  </span>
                </Link>
              </li>
            ))}
            {deals.length === 0 ? (
              <li className="text-body text-[var(--ink-2)]">
                No deal access yet. Ask the team that invited you to grant a seat.
              </li>
            ) : null}
          </ul>
        </div>
      );
    }
  }

  // The Book preview (#191): BankHome reads the book_view flag from the
  // layout's FlagsProvider (no extra fetch); with it off this renders the
  // Command Center unchanged.
  // The bank branch: an external viewer returned above, so the shell perspective here is 'storm'.
  return (
    <>
      <div className="bg-[var(--surface-warm)] px-6 pt-6 empty:hidden">
        <ConnectGmailBanner perspective="storm" className="mx-auto max-w-[832px]" />
      </div>
      <BankHome />
    </>
  );
}
