'use client';

/**
 * Chat home — the empty state of the deal's /chat route: a greeting and the
 * composer. The new-conversation entry (the Ask nav item lands here); submitting
 * a prompt, or clicking a suggested prompt, opens the chat with that question
 * (home and chat are one flow, empty-state vs active). Built for the managing
 * director running the deal — not a demo. Deal identity stays on a code name
 * (compliance), never the real counterparty.
 *
 * Deal state (phase, progress, compliance, spend) lives in the shell's
 * DealContextBar now — so this home no longer repeats a vitals strip (which also
 * held a step count that disagreed with the rail's MVP count, and hardcoded
 * task/compliance figures that were identical across deals). Ask stays focused
 * on the one thing it's for: asking.
 *
 * The composer wiring (AskComposer) and the chip row (SuggestionChips) are
 * their own modules, so the deal home (/projects/[projectId], T4-2 restyle)
 * composes the SAME pieces — one composer, one chip row, one submit handler.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AskComposer } from '@/components/workspace/AskComposer';
import { SuggestionChips } from '@/components/workspace/SuggestionChips';
import { DealListUnavailableStage, NotOnDealStage } from '@/components/deals/DealsUnavailable';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import { useResolvedDeal } from '@/lib/deals/useDeals';
import { resolveProjectId } from '@/lib/project/resolveProjectId';

export function DealHome() {
  const params = useParams();
  const projectId = resolveProjectId(params?.projectId);
  const identity = useResolvedDeal(projectId);

  if (identity.status === 'error') {
    // The deal list failed (#162): never "not found", never a fixture.
    return <DealListUnavailableStage onRetry={identity.retry} />;
  }

  if (identity.status === 'unknown') {
    // Not in the viewer's deal list: the list is the deals they are on.
    return <NotOnDealStage title={DESTINATION_TITLES.mandate} />;
  }

  const codename = identity.status === 'ready' ? identity.deal.codename : '';

  return (
    <div
      className="relative min-h-full w-full"
      style={{
        backgroundColor: 'var(--surface-warm)',
        backgroundImage:
          'linear-gradient(color-mix(in srgb, var(--ink) 3%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--ink) 3%, transparent) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      <div className="mx-auto flex max-w-[860px] flex-col items-center px-6 pt-[16vh] pb-16">
        {/* The one sanctioned serif moment on this screen: the deal identity
            line (kit §01/§04 — serif is identity + source excerpts only). */}
        <p className="deal-identity mb-1 text-center text-[var(--ink)]">
          {codename ? `${codename} · Sell-side mandate` : 'Sell-side mandate'}
        </p>
        <h1 className="mb-7 text-center text-[length:var(--text-lg)] font-normal leading-tight text-[var(--ink-secondary)]">
          What can we help you with?
        </h1>

        <AskComposer projectId={projectId} codename={codename} />

        {/* Suggested prompts — each opens a distinct conversation. */}
        <SuggestionChips projectId={projectId} />

        <Link
          href={`/projects/${projectId}/rail`}
          className="mt-10 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
        >
          Open the deal rail →
        </Link>
      </div>
    </div>
  );
}
