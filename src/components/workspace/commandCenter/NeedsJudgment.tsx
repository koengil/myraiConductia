'use client';

import Link from 'next/link';

import { MARK_READ_LABEL, type NeedsYouRow } from '@/lib/deals/commandCenter';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';

import { Card, Empty, ghostButton, primaryButton } from './Card';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

type AccessInbox = {
  busyId: string | null;
  /** A refused decision's line, keyed by request id. */
  errors?: Readonly<Record<string, string>>;
  match: (opts: { requestId?: string | null; destinationLabel?: string | null; actor?: string | null }) => {
    id: string;
  } | null;
};

/** The row's line when the server kept the item unread. */
export const MARK_READ_FAILED = 'Could not mark as read.';

type RowActionProps = {
  row: NeedsYouRow;
  requestId: string | null;
  deciding: boolean;
  onDecide: (id: string, decision: 'approved' | 'denied') => void;
  onMarkRead: () => void;
};

/**
 * The row's one primary action. Access requests keep their Approve (primary) /
 * Deny (ghost) pair here rather than the shared AccessDecideButtons, whose two
 * equal outline buttons would give the row two primaries (HEADS-UP to the
 * access owner on the board). An item with nowhere to go is marked as read.
 */
function RowAction({ row, requestId, deciding, onDecide, onMarkRead }: RowActionProps) {
  const isAccessRequest = row.eventType === NOTIFICATION_EVENT.ACCESS_REQUESTED;
  if (isAccessRequest && requestId) {
    return (
      <span className="flex shrink-0 gap-1">
        <button
          type="button"
          data-primary-action
          disabled={deciding}
          onClick={() => onDecide(requestId, 'approved')}
          className={primaryButton}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide(requestId, 'denied')}
          className={ghostButton}
        >
          Deny
        </button>
      </span>
    );
  }
  if (!isAccessRequest && row.href) {
    const subject = row.codename ? `${row.codename}: ${row.title}` : row.title;
    return (
      // Acting on the item takes it off the list, as the nav badges do.
      <Link
        href={row.href}
        data-primary-action
        aria-label={`${row.actionLabel}, ${subject}`}
        onClick={onMarkRead}
        className={primaryButton}
      >
        {row.actionLabel}
      </Link>
    );
  }
  return (
    <button type="button" data-primary-action onClick={onMarkRead} className={primaryButton}>
      {MARK_READ_LABEL}
    </button>
  );
}

/** One row per decision, one primary action each. */
function NeedsYouRowView(props: RowActionProps & { alert: string | null }) {
  const { row, alert, ...actionProps } = props;
  return (
    <li className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="needs-you-row">
      {/* Below sm the title takes the full row and the action wraps under it. */}
      <div className="min-w-0 flex-1 max-sm:basis-full">
        <span
          title={row.title}
          className="line-clamp-2 break-words text-[length:var(--text-md)] font-medium text-[var(--ink)]"
        >
          {row.title}
        </span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {row.codename ? (
            <>
              <span className="text-[var(--ink-secondary)]">{row.codename}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span>{row.meta}</span>
        </div>
      </div>
      <RowAction row={row} {...actionProps} />
      {alert ? (
        <p role="alert" className="w-full text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {alert}
        </p>
      ) : null}
    </li>
  );
}

/** Where the caller's notifications read stands: until it is `ready`, no count shows. */
export type NeedsStatus = 'loading' | 'failed' | 'ready';

export function NeedsJudgment({
  status = 'ready',
  onRetry,
  rows,
  inbox,
  onDecide,
  onMarkRead,
  markReadFailedId = null,
}: {
  status?: NeedsStatus;
  /** The item whose "Mark as read" the server refused. */
  markReadFailedId?: string | null;
  onRetry?: () => void;
  rows: NeedsYouRow[];
  inbox: AccessInbox;
  onDecide: (notificationId: string, requestId: string, decision: 'approved' | 'denied') => void;
  onMarkRead: (notificationId: string) => void;
}) {
  return (
    <Card title="Needs your judgment" meta={status === 'ready' ? `${rows.length} open` : undefined}>
      {status === 'loading' ? (
        <Empty>Loading what needs you…</Empty>
      ) : status === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Couldn&apos;t load what needs you.</p>
          {onRetry ? (
            <button type="button" onClick={onRetry} className={ghostButton}>
              {TRY_AGAIN_COPY}
            </button>
          ) : null}
        </div>
      ) : rows.length === 0 ? (
        <Empty>Nothing needs your judgment.</Empty>
      ) : (
        <ul className="divide-y divide-[var(--stroke)]">
          {rows.map((row) => {
            const matched = inbox.match({
              requestId: row.requestId,
              destinationLabel: row.destinationLabel,
              actor: row.actor,
            });
            const requestId = matched?.id ?? null;
            return (
              <NeedsYouRowView
                key={row.id}
                row={row}
                requestId={requestId}
                deciding={requestId != null && inbox.busyId === requestId}
                onDecide={(id, decision) => onDecide(row.id, id, decision)}
                onMarkRead={() => onMarkRead(row.id)}
                alert={
                  (requestId != null ? inbox.errors?.[requestId] : undefined) ??
                  (markReadFailedId === row.id ? MARK_READ_FAILED : null)
                }
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}
