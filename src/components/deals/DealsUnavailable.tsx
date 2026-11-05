'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { StageStatus } from '@/components/shell/StageStatus';

/**
 * DealsUnavailable: what a deal-list consumer renders when the list failed
 * (#162). It replaces any fact the surface would have stated from the list:
 * never an empty book, "No deal here yet", a placeholder deal or a seed
 * fixture. One plain statement and one ink action, Try again, which re-joins
 * one fresh read for every consumer (`useDeals().reload`; the rail and the
 * shell chrome use `retryDealReads`, which on a project route also refreshes
 * that project's rail and step records).
 *
 * Three framings of the same statement:
 * - `DealListUnavailableStage`: a whole stage (rail gate, dashboard, home).
 * - `DealListUnavailable`: a pane inside a page that stays up (book,
 *   command center, audit register, data room, chat, skills).
 * - `DealsUnavailableCompact`: a slot in the chrome (sidebar list, deal
 *   switcher menu, deal context bar).
 */

export const DEAL_LIST_UNAVAILABLE_COPY = 'Your deal list could not be loaded right now.';
export const DEALS_UNAVAILABLE_SHORT_COPY = 'Deals unavailable.';
export const TRY_AGAIN_COPY = 'Try again';
/** A signed-in user on a deal URL they are not a member of: a retry cannot change it. */
export const NOT_ON_DEAL_COPY = 'You are not on this deal.';
export const BACK_TO_CONDUCTOR_CENTER_COPY = 'Back to the Conductor Center';

/**
 * The one "deal you are not on" state, shared by every deal surface (rail,
 * Team, deal home, Book, Audit Trail, Data Room, Deal Folder). Each surface
 * shows it only on its own route's refusal status (for the deal-scoped
 * /api/v1 reads, the 404 a non-member gets; decision-log D65 keeps that
 * byte-identical to "no such deal"), or, for list-resolved surfaces, when
 * the deal is not in the viewer's deal list. A retry cannot change it, so
 * there is no Try again: one statement and the way home.
 */
function BackToConductorCenter() {
  return (
    <Link
      href="/projects"
      className="text-[length:var(--text-sm)] text-[var(--accent)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      {BACK_TO_CONDUCTOR_CENTER_COPY}
    </Link>
  );
}

/**
 * The page's one h1 when the not-on-deal state replaces the whole page: the
 * deal-less page title ("Mail", "Rails"), for assistive tech. Pass it only
 * where nothing else on the page renders an h1.
 */
function PageTitle({ title }: { title?: string }) {
  return title ? <h1 className="sr-only">{title}</h1> : null;
}

/** The not-on-deal state as a whole stage (rail, deal home). */
export function NotOnDealStage({ eyebrow, title }: { eyebrow?: string; title?: string }) {
  return (
    <StageStatus kind="error" eyebrow={eyebrow}>
      <PageTitle title={title} />
      <p role="status" className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {NOT_ON_DEAL_COPY}
      </p>
      <div className="mt-[var(--space-4)] flex justify-center">
        <BackToConductorCenter />
      </div>
    </StageStatus>
  );
}

/** The not-on-deal state as a pane inside a page that stays up. */
export function NotOnDeal({ className, title }: { className?: string; title?: string }) {
  return (
    <div
      className={['flex flex-col items-start gap-[var(--space-3)] py-[var(--space-4)]', className]
        .filter(Boolean)
        .join(' ')}
    >
      <PageTitle title={title} />
      <p role="status" className="text-[length:var(--text-md)] text-[var(--ink-secondary)]">
        {NOT_ON_DEAL_COPY}
      </p>
      <BackToConductorCenter />
    </div>
  );
}

function TryAgain({ onRetry, label }: { onRetry: () => void; label?: string }) {
  return (
    <Button variant="primary" size="sm" onClick={onRetry} aria-label={label}>
      {TRY_AGAIN_COPY}
    </Button>
  );
}

export function DealListUnavailableStage({
  eyebrow,
  onRetry,
}: {
  eyebrow?: string;
  onRetry: () => void;
}) {
  return (
    <StageStatus kind="error" eyebrow={eyebrow}>
      <p role="status" className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {DEAL_LIST_UNAVAILABLE_COPY}
      </p>
      <div className="mt-[var(--space-4)] flex justify-center">
        <TryAgain onRetry={onRetry} />
      </div>
    </StageStatus>
  );
}

export function DealListUnavailable({
  onRetry,
  className,
}: {
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={[
        'flex flex-col items-start gap-[var(--space-3)] py-[var(--space-4)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p role="status" className="text-[length:var(--text-md)] text-[var(--ink-secondary)]">
        {DEAL_LIST_UNAVAILABLE_COPY}
      </p>
      <TryAgain onRetry={onRetry} />
    </div>
  );
}

export function DealsUnavailableCompact({
  onRetry,
  className,
}: {
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={['flex flex-wrap items-center gap-[var(--space-2)]', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {DEALS_UNAVAILABLE_SHORT_COPY}
      </span>
      <TryAgain onRetry={onRetry} label="Try again: reload your deals" />
    </div>
  );
}
