'use client';

import Link from 'next/link';

import { NotOnDeal } from '@/components/deals/DealsUnavailable';

export type DealAvailabilityFailure = {
  kind: 'unavailable';
  heading: string;
  detail: string;
  actionHref: string;
  actionLabel: string;
};

/** The route refused the deal: the shared not-on-deal state, never "does not exist". */
export type NotOnDealFailure = { kind: 'not-on-deal' };

export type DocumentLoadFailure =
  | DealAvailabilityFailure
  | NotOnDealFailure
  | { kind: 'error'; message: string };

const NOT_ON_DEAL: NotOnDealFailure = { kind: 'not-on-deal' };

const SESSION_ENDED: DealAvailabilityFailure = {
  kind: 'unavailable',
  heading: 'Your session has ended',
  detail: 'Sign in again to open the documents on this deal.',
  actionHref: '/sign-in',
  actionLabel: 'Sign in',
};

/**
 * The page state for a failed read. `notOnDealStatus` is the status the read's
 * route gives a caller who is not on the deal: for the documents route that
 * is 404, the same answer as a code that does not exist (dealNotVisible,
 * decision-log D65), so the page shows the shared not-on-deal state for both.
 * Pass null for a route with no such answer. Any other status (a 403 is an
 * account gate such as MFA) is a failed read with Try again.
 */
export function loadFailureForStatus(
  status: number,
  message: string | null | undefined,
  { notOnDealStatus = 404 }: { notOnDealStatus?: number | null } = {},
): DocumentLoadFailure {
  if (status === 401) return SESSION_ENDED;
  if (notOnDealStatus !== null && status === notOnDealStatus) return NOT_ON_DEAL;
  return { kind: 'error', message: message ?? 'The documents could not be loaded.' };
}

export function dealUnavailable(failure: DocumentLoadFailure | null): DealAvailabilityFailure | null {
  return failure?.kind === 'unavailable' ? failure : null;
}

/** A failure that replaces the whole page: a session that ended, or a deal the viewer is not on. */
export function dealBlocked(
  failure: DocumentLoadFailure | null,
): DealAvailabilityFailure | NotOnDealFailure | null {
  return failure && failure.kind !== 'error' ? failure : null;
}

export function DealBlocked({ failure }: { failure: DealAvailabilityFailure | NotOnDealFailure }) {
  return failure.kind === 'not-on-deal' ? <NotOnDeal className="py-0" /> : <DealUnavailable failure={failure} />;
}

export function DealUnavailable({ failure }: { failure: DealAvailabilityFailure }) {
  return (
    <section
      aria-label="Deal unavailable"
      className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)] shadow-[var(--elev-1)]"
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
        {failure.heading}
      </h2>
      <p className="mt-[var(--space-2)] max-w-xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {failure.detail}
      </p>
      <Link
        href={failure.actionHref}
        className="mt-[var(--space-4)] inline-flex items-center rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[6px] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        {failure.actionLabel}
      </Link>
    </section>
  );
}

/** A failed read: one plain sentence and a way to retry, never server text. */
export function LoadErrorAlert({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-3)]">
      <p role="alert" className="text-[length:var(--text-sm)] font-medium text-[var(--negative)]">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center rounded-[var(--radius-button)] px-[var(--space-2)] py-[6px] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Try again
      </button>
    </div>
  );
}
