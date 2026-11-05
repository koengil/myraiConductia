'use client';

import * as React from 'react';

import {
  dealUnavailable,
  DealUnavailable,
  loadFailureForStatus,
  type DocumentLoadFailure,
} from '@/components/dataroom/dealAvailability';
import { DealThreadPane } from '@/components/dataroom/DealThreadPane';
import { formatDate } from '@/lib/format/date';

/**
 * Deal email: the messages discovery linked to this deal, read-only, in the Deal
 * Folder's second view. The list is an index in Conductia, never a copy in Box.
 * The server decides what each row may say (GET /api/v1/discovery/deal-email):
 * a message from the reader's own mailbox carries sender and subject, any other
 * carries its day and the sender's domain only, and this component renders
 * exactly what arrives. A message from the reader's own mailbox opens its
 * thread (DealThreadPane, #339); any other row is not a control. Look and copy:
 * design to confirm.
 */

/** The wire shape of GET /api/v1/discovery/deal-email, declared here so this client file imports nothing from src/lib/discovery/api. */
type DealEmailRow = {
  sourceItemId: string;
  sentDay: string | null;
  fromDomain: string | null;
  sender: string | null;
  subject: string | null;
  own: boolean;
  /** Its thread opens: the reader's own connected mailbox holds it (not a colleague's, not a team inbox item). */
  opensThread: boolean;
};

type Loaded =
  | { dealCode: string; ok: true; items: DealEmailRow[]; truncated: boolean }
  | { dealCode: string; ok: false; failure: DocumentLoadFailure };

const LOAD_FAILED = 'The deal email failed to load.';

/**
 * "Sep 18, 2026" from a 'YYYY-MM-DD' day, as the Discovery pages write it.
 */
function formatDay(isoDay: string): string {
  return formatDate(`${isoDay}T00:00:00Z`, { timeZone: 'UTC' }) || isoDay;
}

function EmailRowCells({ item }: { item: DealEmailRow }) {
  return (
    <>
      <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
        {item.sentDay ? formatDay(item.sentDay) : 'Undated'}
      </span>
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="truncate text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {item.fromDomain ?? 'Unknown domain'}
        </span>
        {item.own ? (
          <span className="truncate text-[length:var(--text-base)] text-[var(--ink)]">
            <span className="font-medium">{item.sender ?? 'Unknown sender'}</span>
            {' · '}
            {item.subject ? item.subject : '(no subject)'}
          </span>
        ) : (
          <span className="truncate text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            From another banker&apos;s mailbox · metadata only
          </span>
        )}
      </div>
    </>
  );
}

const ROW_GRID =
  'grid min-h-[52px] w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[var(--space-4)] px-[var(--space-4)] py-[10px] text-left';

function EmailRows({ items, onOpen }: { items: DealEmailRow[]; onOpen: (sourceItemId: string) => void }) {
  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => (
        <li key={item.sourceItemId} className="border-b border-[var(--stroke)] last:border-b-0">
          {item.opensThread ? (
            <button
              type="button"
              onClick={() => onOpen(item.sourceItemId)}
              className={`${ROW_GRID} transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]`}
            >
              <EmailRowCells item={item} />
            </button>
          ) : (
            <div className={ROW_GRID}>
              <EmailRowCells item={item} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DealEmailList({ dealCode }: { dealCode: string }) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [openItem, setOpenItem] = React.useState<{ dealCode: string; sourceItemId: string } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/v1/discovery/deal-email?deal=${encodeURIComponent(dealCode)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (cancelled) return;
          // This route answers a non-member with an empty list, so no
          // status here means "not on this deal" (its 404 is the flag gate).
          setLoaded({
            dealCode,
            ok: false,
            failure: loadFailureForStatus(res.status, LOAD_FAILED, { notOnDealStatus: null }),
          });
          return;
        }
        const data = (await res.json()) as { items?: DealEmailRow[]; truncated?: boolean };
        if (cancelled) return;
        setLoaded({ dealCode, ok: true, items: data.items ?? [], truncated: data.truncated === true });
      } catch {
        if (cancelled) return;
        setLoaded({
          dealCode,
          ok: false,
          failure: { kind: 'error', message: 'Network error. Check your connection and try again.' },
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dealCode]);

  // A result for another deal is not this deal's result: show loading until the matching one arrives.
  const current = loaded?.dealCode === dealCode ? loaded : null;
  const unavailable = current && !current.ok ? dealUnavailable(current.failure) : null;
  // An open thread belongs to the deal it was opened on.
  const openThread = openItem?.dealCode === dealCode ? openItem : null;

  if (openThread) {
    return (
      <div className="p-[var(--space-5)]">
        <DealThreadPane dealCode={dealCode} sourceItemId={openThread.sourceItemId} onBack={() => setOpenItem(null)} />
      </div>
    );
  }

  return (
    <div className="p-[var(--space-5)]">
      {current === null ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">Loading deal email.</p>
      ) : unavailable ? (
        <DealUnavailable failure={unavailable} />
      ) : !current.ok ? (
        <p role="alert" className="text-[length:var(--text-sm)] font-medium text-[var(--negative)]">
          {current.failure.kind === 'error' ? current.failure.message : LOAD_FAILED}
        </p>
      ) : (
        <section
          aria-label="Deal email"
          className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]"
        >
          <header className="flex items-baseline justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]">
            <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">Deal email</h2>
            <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
              {current.items.length} {current.items.length === 1 ? 'message' : 'messages'}
            </span>
          </header>
          {current.items.length > 0 ? (
            <EmailRows items={current.items} onOpen={(sourceItemId) => setOpenItem({ dealCode, sourceItemId })} />
          ) : (
            <p className="px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
              No linked email you can read on this deal.
            </p>
          )}
          {current.truncated ? (
            <p className="border-t border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              Showing the 200 most recent.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}

export default DealEmailList;
