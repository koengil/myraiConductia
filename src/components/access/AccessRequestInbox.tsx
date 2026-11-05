'use client';

import { AccessDecideButtons } from '@/components/access/AccessDecideButtons';
import { useAccessInbox } from '@/lib/access/useAccessInbox';

/**
 * One-click approve / deny for pending access requests. Lives on My
 * organization so organization administrators (directors, firm admins, and
 * anyone with Assign employee access) see the queue.
 */
export function AccessRequestInbox({ showEmpty = false }: { showEmpty?: boolean }) {
  const { items, busyId, error, decide } = useAccessInbox();

  if (items.length === 0 && !error && !showEmpty) return null;

  return (
    <section
      aria-label="Access requests"
      className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--elev-1)]"
    >
      <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
        Access requests
      </h2>
      <p className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        The requester is notified either way.
      </p>
      {error ? (
        <p role="alert" className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
      {items.length === 0 && !error ? (
        <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No pending permission requests.
        </p>
      ) : (
        <ul className="mt-[var(--space-3)] flex list-none flex-col gap-[var(--space-2)] p-0">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)]"
            >
              <span className="text-[length:var(--text-sm)] text-[var(--ink)]">
                <span className="font-medium">{item.requesterName ?? 'A teammate'}</span>
                {' asked for '}
                {item.destinationLabel}
              </span>
              <AccessDecideButtons
                busy={busyId === item.id}
                onApprove={() => void decide(item.id, 'approved')}
                onDeny={() => void decide(item.id, 'denied')}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
