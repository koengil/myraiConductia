'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

import type { SegmentedControlItem } from '@/components/atoms';
import { InsightValuationTable } from './InsightValuationTable';
import { CultureMatrixPanel } from '@/components/acquirers/CultureMatrixPanel';
import { SynergyStressTestPanel } from '@/components/acquirers/SynergyStressTestPanel';
import { FounderReadPanel } from '@/components/acquirers/FounderReadPanel';
import {
  createDeal,
  proposeCodename,
  proposeCodenames,
  codenameMasksCompany,
  resolveCompany,
} from '@/lib/rail/deals';

/**
 * CompanyInsight — the pre-mandate research read (proposed demo flow).
 *
 * Reached from the portfolio's company search. It is PRE-deal: no `deals` row
 * exists yet. It shows a KYC/FINRA/MNPI pre-check (public research is clear)
 * and the same live analytical panels the deep-dive uses, then offers the
 * Create CTA — creating the mandate is what fires the conflicts screen and
 * stands up the rail. Data is the sandbox reference dataset (fixtures); every
 * searched name resolves to it.
 */

const ANALYSIS_SEGMENTS = [
  { id: 'valuation', label: 'Valuation' },
  { id: 'culture', label: 'Culture' },
  { id: 'synergy', label: 'Synergy' },
  { id: 'founder', label: 'Founder' },
] as const satisfies readonly SegmentedControlItem[];

type SegmentId = (typeof ANALYSIS_SEGMENTS)[number]['id'];

// The reference acquirer whose fixtures back the sandbox read.
const REFERENCE_ID = 'anthropic';

// One-sentence insight lead for each lens, so it is clear the panel below is a
// read, not raw data.
function leadFor(segment: SegmentId, company: string): string {
  switch (segment) {
    case 'valuation':
      return '';
    case 'culture':
      return `Read: how ${company}'s culture would mesh with a strategic acquirer, and where friction sits.`;
    case 'synergy':
      return `Read: the buyer's promised synergies, checked against what deals of this kind actually deliver.`;
    case 'founder':
      return `Read: the founder's most likely post-deal posture and the retention risk it carries.`;
    default:
      return '';
  }
}

// The agent work shown while the read is assembled — surfaced one line at a
// time so the user sees there is real agent activity behind the insight.
const AGENT_STEPS = [
  'Spinning up agents',
  'Fetching company information',
  'Gathering culture insight',
  'Evaluating potential synergetic acquirers',
  'Compiling the pre-mandate read',
] as const;

export function CompanyInsight() {
  const params = useParams();
  const router = useRouter();
  const raw = Array.isArray(params.company) ? params.company[0] : params.company;
  const company = resolveCompany(raw ?? 'target');

  const [loading, setLoading] = React.useState(true);
  const [segment, setSegment] = React.useState<SegmentId>('valuation');
  const [codename, setCodename] = React.useState(proposeCodename(company));
  const [suggestions, setSuggestions] = React.useState(() =>
    proposeCodenames(company, 4),
  );
  const [creating, setCreating] = React.useState(false);

  const masks = codenameMasksCompany(codename, company);
  const canCreate = codename.trim().length > 0 && masks && !creating;

  if (loading) {
    return (
      <InsightLoading company={company} onDone={() => setLoading(false)} />
    );
  }

  function create() {
    if (!canCreate) return;
    setCreating(true);
    const deal = createDeal(company, codename);
    router.push(`/projects/${deal.id}/rail?new=1`);
  }

  return (
    <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
      <Link
        href="/projects"
        className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--accent-dark)]"
      >
        ← Back to your deals
      </Link>

      <header className="mt-[var(--space-3)] mb-[var(--space-5)]">
        <h1 className="text-[34px] font-semibold leading-tight text-[var(--ink)]">
          Pre-mandate research - {company.name}
        </h1>
      </header>

      {/* Analytical panels (reused deep-dive) — warm register stage: the
          panels are white cards, so the stage itself is the warm field. */}
      <div className="rounded-[var(--radius-card)] bg-[var(--surface-subtle)] p-[var(--space-4)]">
        <div
          role="tablist"
          aria-label="Company analysis"
          className="flex flex-wrap gap-[var(--space-2)]"
        >
          {ANALYSIS_SEGMENTS.map((s) => {
            const active = s.id === segment;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSegment(s.id)}
                className={[
                  'inline-flex h-[34px] items-center rounded-[var(--radius-pill)] px-[var(--space-4)] text-[length:var(--text-sm)] font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface)] text-[var(--ink)] ring-1 ring-inset ring-[var(--stroke-strong)]'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink)]',
                ].join(' ')}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {leadFor(segment, company.name) ? (
          <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            {leadFor(segment, company.name)}
          </p>
        ) : null}
        <div className="mt-[var(--space-4)]">
          {segment === 'valuation' ? <InsightValuationTable /> : null}
          {segment === 'culture' ? (
            <CultureMatrixPanel acquirerId={REFERENCE_ID} />
          ) : null}
          {segment === 'synergy' ? (
            <SynergyStressTestPanel acquirerId={REFERENCE_ID} />
          ) : null}
          {segment === 'founder' ? (
            <FounderReadPanel acquirerId={REFERENCE_ID} />
          ) : null}
        </div>
      </div>

      {/* Create CTA */}
      <section className="mt-[var(--space-5)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]">
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
          Take {company.name} to market
        </h2>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Creating the mandate mints a deal code, makes you the MD, and stands
          up the rail at day one. The code name must mask the target, so it
          cannot contain &ldquo;{company.name}&rdquo;.
        </p>

        <div className="mt-[var(--space-3)] flex flex-wrap items-end gap-[var(--space-3)]">
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
              Code name
            </span>
            <input
              type="text"
              value={codename}
              onChange={(e) => setCodename(e.target.value)}
              aria-invalid={!masks}
              className={[
                'rounded-[var(--radius-input)] border bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] outline-none',
                masks
                  ? 'border-[var(--stroke)] focus:border-[var(--accent)]'
                  : 'border-[var(--negative)] focus:border-[var(--negative)]',
              ].join(' ')}
            />
          </label>
          <button
            type="button"
            onClick={create}
            disabled={!canCreate}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create mandate'}
          </button>
        </div>

        {!masks ? (
          <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--negative)]">
            The code name cannot contain the target&rsquo;s name. Pick a
            suggestion below or rename it.
          </p>
        ) : null}

        <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)]">
          <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Suggestions:
          </span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCodename(name)}
              className="rounded-[var(--radius-pill)] border border-[var(--stroke)] px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-dark)]"
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              setSuggestions(
                proposeCodenames(company, 4, Math.floor(Math.random() * 100) + 1),
              )
            }
            className="text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
          >
            Regenerate
          </button>
        </div>
      </section>
    </div>
  );
}

function InsightLoading({
  company,
  onDone,
}: {
  company: { name: string };
  onDone: () => void;
}) {
  const [active, setActive] = React.useState(0);

  React.useEffect(() => {
    if (active >= AGENT_STEPS.length) {
      const t = setTimeout(onDone, 700);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setActive((n) => n + 1), 1000);
    return () => clearTimeout(t);
  }, [active, onDone]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-[var(--page-max)] flex-col items-center justify-center px-[var(--space-4)] py-[var(--space-6)]">
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        Preparing the read
      </p>
      <h1 className="mt-1 text-[length:var(--text-2xl)] font-semibold text-[var(--ink)]">
        {company.name}
      </h1>

      <ul className="mt-[var(--space-5)] w-full max-w-[420px] space-y-[var(--space-2)]">
        {AGENT_STEPS.map((label, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <li
              key={label}
              className={[
                'flex items-center gap-[var(--space-3)] text-[length:var(--text-sm)] transition-opacity',
                done || current ? 'opacity-100' : 'opacity-40',
              ].join(' ')}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {done ? (
                  <span className="flex size-4 items-center justify-center rounded-full bg-[var(--positive)]">
                    <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
                      <path
                        d="M2.5 6.2 5 8.5 9.5 3.5"
                        fill="none"
                        stroke="white"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                ) : current ? (
                  <span className="size-4 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]" />
                ) : (
                  <span className="size-2 rounded-full bg-[var(--stroke)]" />
                )}
              </span>
              <span
                className={
                  current
                    ? 'font-medium text-[var(--ink)]'
                    : 'text-[var(--ink-secondary)]'
                }
              >
                {label}
                {current ? '…' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default CompanyInsight;
