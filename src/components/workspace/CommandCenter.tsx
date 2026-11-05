'use client';

/**
 * Conductor Center: the banker's morning surface, on the Workbench "Today"
 * hierarchy (docs/design/workbench/Conductia Workbench.html, vToday):
 *
 *   (a quiet line when Discovery has proposed deals from the viewer's mail)
 *   Needs your judgment  one primary action per item
 *   Due today            only when a deal's target close is today
 *   Running              only drafts actually in flight; absent otherwise
 *   Your deals           every deal on one scannable, sortable list
 *
 * Every row derives from the one deal list and the caller's notifications
 * (src/lib/deals/commandCenter.ts); the sections live in ./commandCenter.
 * While the deal list loads the surface stays quiet (never "across 0 live
 * deals"); a failed list says so first.
 */

import * as React from 'react';

import { DealListUnavailable } from '@/components/deals/DealsUnavailable';
import { useAccessInbox } from '@/lib/access/useAccessInbox';
import { dealRows, dueTodayRows, needsYouRows, runningRows } from '@/lib/deals/commandCenter';
import { useDeals } from '@/lib/deals/useDeals';
import { useNotifications } from '@/lib/notifications/useNotifications';
import { greetingForHour } from '@/lib/util/greeting';

import { plural } from './commandCenter/Card';
import { DiscoveryLine } from './commandCenter/DiscoveryLine';
import { DueToday } from './commandCenter/DueToday';
import { NeedsJudgment, type NeedsStatus } from './commandCenter/NeedsJudgment';
import { Running } from './commandCenter/Running';
import { YourDeals, type ShowKey } from './commandCenter/YourDeals';

export { RUNNING_LIMIT } from './commandCenter/Running';
export { DEAL_TOOLS_AT } from './commandCenter/YourDeals';

function subscribeToClock() {
  return () => {};
}

function readGreeting(): string {
  return greetingForHour(new Date().getHours());
}

function readServerGreeting(): string | null {
  return null;
}

export function CommandCenter() {
  const { deals, loading, error: dealsError, reload: reloadDeals } = useDeals();
  const {
    items: notifications,
    ready: notificationsReady,
    error: notificationsError,
    loaded: notificationsLoaded,
    markRead,
    markReadFailedId,
    reload: reloadNotifications,
  } = useNotifications();
  const inbox = useAccessInbox();
  const greeting = React.useSyncExternalStore(subscribeToClock, readGreeting, readServerGreeting);
  const [show, setShow] = React.useState<ShowKey>('all');

  const needsYou = needsYouRows(notifications);
  const rows = dealRows(deals, needsYou);
  const running = runningRows(rows);
  const liveCount = rows.filter((r) => r.category === 'live').length;
  // A failed first read is not an empty desk: no
  // "0 decisions", no "Nothing needs your judgment", no 0 in the Needs-you
  // cells. A failed refetch keeps the last good items, so it shows them.
  const needsStatus: NeedsStatus = !notificationsReady
    ? 'loading'
    : notificationsError && !notificationsLoaded
      ? 'failed'
      : 'ready';

  async function decideAccess(notificationId: string, requestId: string, decision: 'approved' | 'denied') {
    const ok = await inbox.decide(requestId, decision);
    if (ok) await markRead(notificationId);
  }

  function showAllRunning() {
    setShow('running');
    document.getElementById('your-deals')?.scrollIntoView?.({ block: 'start' });
  }

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:py-10">
        <p className="eyebrow mb-1">Conductor Center</p>
        <h1 className="mb-1 text-[24px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
          {greeting ?? '\u00A0'}
        </h1>
        {/* A failed list is not an empty book (#162): say so before any count. */}
        {dealsError ? (
          <DealListUnavailable onRetry={reloadDeals} className="mb-8" />
        ) : loading ? (
          <p className="mb-8 text-[length:var(--text-md)] text-[var(--ink-tertiary)]">Loading the book…</p>
        ) : (
          <>
            <div className="mb-7 flex flex-col gap-1">
              <p className="text-[length:var(--text-md)] text-[var(--ink-tertiary)]">
                {needsStatus === 'ready' ? (
                  <>
                    {plural(needsYou.length, 'decision')} {needsYou.length === 1 ? 'needs' : 'need'} your judgment
                    across {plural(liveCount, 'live deal')}.
                  </>
                ) : needsStatus === 'failed' ? (
                  `You have ${plural(liveCount, 'live deal')}.`
                ) : (
                  '\u00A0'
                )}
              </p>
              <DiscoveryLine />
            </div>

            <div
              className={`mb-4 grid items-start gap-4 ${
                running.length > 0 ? 'lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]' : ''
              }`}
            >
              <div className="grid min-w-0 gap-4">
                <NeedsJudgment
                  status={needsStatus}
                  // Forced: an unforced reload is the focus/visibility one, skipped within 30 s of the last read.
                  onRetry={() => void reloadNotifications({ force: true })}
                  rows={needsYou}
                  inbox={inbox}
                  onDecide={(notificationId, requestId, decision) =>
                    void decideAccess(notificationId, requestId, decision)
                  }
                  onMarkRead={(id) => void markRead(id)}
                  markReadFailedId={markReadFailedId}
                />
                <DueToday rows={dueTodayRows(rows)} />
              </div>
              <Running rows={running} onShowAll={showAllRunning} />
            </div>

            <YourDeals rows={rows} show={show} setShow={setShow} needsKnown={needsStatus === 'ready'} />
          </>
        )}
      </div>
    </div>
  );
}
