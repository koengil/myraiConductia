'use client';

import * as React from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

import { DealSelectMenu, DealSelectMenuFooter } from '@/components/deals/DealSelect';
import { Popover } from '@/components/overlay';
import { DealsUnavailableCompact } from '@/components/deals/DealsUnavailable';

import {
  resolveProjectId,
  withProjectId,
} from '@/lib/project/resolveProjectId';
import {
  resolveListedDeal,
  useDealListSource,
  useDeals,
} from '@/lib/deals/useDeals';
import { retryDealReads } from '@/lib/rail/railLoadStage';
import { useProjectRail } from '@/lib/rail/projectRail';
import { PhaseMeter } from '@/components/rail/PhaseMeter';
import { GATE0_MODAL_ENTRY_ENABLED } from '@/lib/rail/gate0';
import { openNewMandateDialog } from '@/lib/leads/leadCatalog';
import { NewMandateDialog } from '@/components/wizard/NewMandateDialog';
import { navUserFromProfile, showNewDealNav } from '@/lib/navigation/navPolicy';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';

/**
 * DealContextBar — the one authoritative "which deal am I in, and how do I
 * switch?" affordance for the whole platform. Mounted ONCE in the TopBar's left
 * slot (only on /projects/[id] routes), so every deal-scoped screen — rail, Ask,
 * Team, Deal Folder, Data Room, Audit — carries the same
 * deal identity for free, instead of each page re-inventing it. This mirrors the
 * codebase invariant that identity/compliance chrome is mounted once in the
 * shell and pages don't self-display (the ComplianceRibbon pattern).
 *
 * Three parts, left → right: the SWITCHER (code name; the deal code shows only
 * inside its menu), the PHASE METER (one segment per phase, progress by
 * position, not colour), and the live per-deal ODOMETER (honest spend, on
 * every deal screen). Switching a deal SWAPS the projectId segment and keeps
 * the current sub-route (withProjectId), so the MD changes deal without losing
 * the screen they're on. Deals are shown by CODE NAME only — the target company never
 * appears here (compliance).
 */

export function DealContextBar() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const projectId = resolveProjectId(params?.projectId as string | string[] | undefined);

  // The switcher list comes from the read side (useDeals): real deals when the
  // flag is on, else the fixture set. The CURRENT deal is the list entry whose
  // id or code matches the URL segment.
  const { deals, loading, error: dealsError } = useDeals();
  const dealSource = useDealListSource();
  const { state } = useCurrentUser();
  const navUser =
    state.status === 'ready'
      ? navUserFromProfile(state.data.user, state.data.company_permissions)
      : null;
  const showNewDeal = Boolean(navUser && showNewDealNav(navUser) && GATE0_MODAL_ENTRY_ENABLED);
  const [open, setOpen] = React.useState(false);
  const [newDealOpen, setNewDealOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Only a deal among the viewer's own names the switcher: never another
  // deal's identity (G22), and never a raw code for one they are not on.
  const deal = resolveListedDeal(projectId, deals, dealSource);
  const emptyLabel = loading ? '' : 'Select a deal';

  const { rail } = useProjectRail(projectId);

  const switchDeal = (id: string) => {
    setOpen(false);
    if (id !== projectId) {
      router.push(withProjectId(pathname ?? `/projects/${id}`, id));
    }
  };

  // The deal list failed (#162): the identity slot says so, with Try again,
  // and the bar makes no phase claim (the placeholder deal has none).
  if (dealsError) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-[var(--space-3)]">
        <DealsUnavailableCompact
          onRetry={() => retryDealReads(projectId)}
          className="px-[var(--space-2)]"
        />
      </div>
    );
  }

  return (
    // flex-1 + min-w-0: the bar fills the space to the LEFT of the compliance
    // ribbon and packs its content left, so a gap is always guaranteed and the
    // odometer can never collide with the ribbon. The identity truncates first.
    <div className="flex min-w-0 flex-1 items-center gap-[var(--space-3)]">
      {/* Switcher (identity) + its anchored panel (shared Popover). */}
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Switch deal"
        className="flex min-w-0 items-center"
        triggerRef={triggerRef}
        panelClassName="left-0 top-[calc(100%+6px)] w-[min(320px,86vw)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={deal ? `Deal: ${deal.codename}. Switch deal` : loading ? 'Switch deal' : emptyLabel}
            title="Switch deal"
            className="flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--radius-button)] px-[var(--space-2)] py-1 text-left transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span className="truncate text-[length:var(--text-sm)] font-semibold tracking-[-0.01em] text-[var(--ink)]">
              {deal?.codename ?? emptyLabel}
            </span>
            <ChevronDown
              size={14}
              aria-hidden
              className={
                'ml-[var(--space-1)] shrink-0 text-[var(--ink-tertiary)] transition-transform ' +
                (open ? 'rotate-180' : '')
              }
            />
          </button>
        )}
      >
        <p className="px-[var(--space-4)] pb-[var(--space-1)] pt-[var(--space-3)] text-[length:var(--text-xxs)] font-semibold text-[var(--ink-tertiary)]">
          Deals
        </p>
        <DealSelectMenu
          deals={deals}
          activeId={projectId}
          onSelect={switchDeal}
          footer={
            <DealSelectMenuFooter
              showNewDeal={showNewDeal}
              onNewDeal={() => {
                // Close to the trigger first, so the New mandate dialog
                // returns focus there when it closes.
                setOpen(false);
                triggerRef.current?.focus();
                openNewMandateDialog(setNewDealOpen);
              }}
            />
          }
        />
      </Popover>

      {rail ? (
        <span className="hidden shrink-0 md:inline-flex">
          <PhaseMeter rail={rail} />
        </span>
      ) : null}

      {showNewDeal ? (
        <NewMandateDialog open={newDealOpen} onClose={() => setNewDealOpen(false)} />
      ) : null}
    </div>
  );
}

export default DealContextBar;
