import { redirect } from 'next/navigation';

import { AiBudgetCard } from '@/components/audit/AiBudgetCard';
import { AiSpendPanel } from '@/components/audit/AiSpendPanel';
import { homeHref, showAiCostsNav } from '@/lib/navigation/navPolicy';
import { getNavUser } from '@/lib/navigation/serverNav';

/**
 * /ai-costs — the firm-wide AI spend (Issue #155), moved off the Book into its
 * own global destination. Only the roles that get the full breakdown reach it
 * (showAiCostsNav); anyone else is sent home. Each deal's own spend stays on
 * its Audit Trail.
 */
export default async function AiCostsPage() {
  const navUser = await getNavUser();
  if (!navUser || !showAiCostsNav(navUser)) {
    redirect(navUser ? homeHref(navUser) : '/projects');
  }

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        <h1 className="mb-1 text-[26px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
          AI costs
        </h1>
        <p className="mb-6 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          Recorded AI spend across the firm, by deal, person, task and model.
        </p>
        <AiBudgetCard />
        <AiSpendPanel expanded />
      </div>
    </div>
  );
}
