'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

import { DealSelectMenu, DealSelectMenuFooter } from '@/components/deals/DealSelect';
import { Popover } from '@/components/overlay';
import { NewMandateDialog } from '@/components/wizard/NewMandateDialog';
import { resolveListedDeal, useDealListSource, useDeals } from '@/lib/deals/useDeals';
import { retryDealReads } from '@/lib/rail/railLoadStage';
import { openNewMandateDialog } from '@/lib/leads/leadCatalog';

/**
 * TopNavDealSwitcher — codename + chevron opening the shared searchable deal
 * panel (DealSelectMenu) with the New-deal footer; the deal code shows only
 * inside that panel. The shared Popover, the same one the Sidebar's
 * SidebarDealSelect uses, in the top chrome's horizontal geometry.
 */
export function TopNavDealSwitcher({
  projectId,
  showNewDeal,
}: {
  projectId: string | null;
  showNewDeal: boolean;
}) {
  const router = useRouter();
  const { deals, loading, error: dealsError } = useDeals();
  // Only a deal among the viewer's own deals names the closed switcher. A code
  // that is not (a deal they are not on, or a list still loading) never shows
  // as a raw code such as SUMMIT-2026-003.
  const dealSource = useDealListSource();
  const selectedDeal =
    projectId != null ? resolveListedDeal(projectId, deals, dealSource) : null;
  // While the list is still loading the label stays blank rather than flash a fallback.
  const emptyLabel = loading ? '' : 'Select a deal';
  const [open, setOpen] = React.useState(false);
  const [newDealOpen, setNewDealOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Switch deal"
        className="shrink-0"
        triggerRef={triggerRef}
        panelClassName="left-0 top-[calc(100%+4px)] w-[280px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={
              selectedDeal ? `Deal: ${selectedDeal.codename}. Switch deal` : loading ? 'Switch deal' : emptyLabel
            }
            className={[
              'flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 transition-colors',
              'text-[var(--ink)] hover:bg-[var(--surface-subtle)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
            ].join(' ')}
          >
            {/* Capped tighter on a phone so the avatar stays on screen; the
                title shows the whole codename where it is cut. */}
            <span
              title={selectedDeal?.codename}
              className="max-w-[96px] truncate text-(length:--text-sm) font-medium tracking-tight sm:max-w-[140px] 2xl:max-w-[180px]"
            >
              {selectedDeal?.codename ?? emptyLabel}
            </span>
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              aria-hidden
              className={
                'shrink-0 text-[var(--ink-tertiary)] transition-transform ' +
                (open ? 'rotate-180' : '')
              }
            />
          </button>
        )}
      >
        <DealSelectMenu
          key="topnav-deal-menu"
          deals={deals}
          activeId={projectId}
          unavailable={dealsError ? { onRetry: () => retryDealReads(projectId) } : null}
          onSelect={(id) => {
            setOpen(false);
            router.push(`/projects/${id}/rail`);
          }}
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
      {showNewDeal ? (
        <NewMandateDialog open={newDealOpen} onClose={() => setNewDealOpen(false)} />
      ) : null}
    </>
  );
}
