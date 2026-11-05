'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';

import { getApi } from '@/lib/api';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import type { Acquirer, Company, CompositeScore } from '@/lib/api/types';
import { Badge, Card } from '@/components/atoms';
import { PeerStrip } from '@/components/acquirers/PeerStrip';
import { StageStatus } from '@/components/shell/StageStatus';

/**
 * `/acquirers` — the ranked landscape as a real route (design spec §10.2;
 * personas-and-jobs §2 Jobs 1 + 2).
 *
 * Phase 5a (2026-05-24): the linear card-stack is retired for a reference-style
 * INTERACTIVE league table. An MD scanning the field does not want to scroll
 * five large cards; they want a dense, sortable instrument — rank, composite,
 * the two sub-scores, a one-line rationale — that re-sorts on a header click
 * and drills into the deep-dive on a row click. Less scroll, more interaction,
 * AI-native feel.
 *
 * T4-3 (2026-08-27, workbench restyle): the league table is restructured into
 * the typed knowledge grid of the Workbench spec (kit §05, Hebbia matrix
 * grammar). Rows stay acquirers; the typed columns are the signal + clamped
 * fit description, the mono score figures, and the screen state, separated by
 * column hairlines. Markup only — data shape, handlers, and hooks are
 * unchanged (Tier-4). The kit's select column and per-row approve are NOT
 * rendered: no selection or approve handler exists on this surface, and
 * conventions.md forbids drawing a control that has not been built.
 *
 * URL is the source of truth for selection (F2): activating a row pushes
 * `/acquirers/[id]` rather than dispatching SELECT_ACQUIRER / NEXT. Each row is
 * a `role="button"` carrying the FROZEN aria contract
 * `${name}, composite score ${total}` (ledger §3.2; a comma, since no em dash
 * reaches visible copy, ARIA names included). Enter/Space activate.
 *
 * The composite, financial, and culture numbers are computed upstream by
 * getAcquirerScore → computeCompositeScore (deterministic; Anthropic 87 /
 * Salesforce 67 at default weights). Never hardcoded here.
 *
 * Load contract (mirrors the Landscape stage so the per-component test's
 * verbatim strings still apply): the unmount-safe `active` flag, the
 * Promise.all + per-acquirer score fetches, the loading string `Scoring
 * acquirers…` (U+2026), the error string `The acquirer landscape could not be
 * loaded right now.`, and the `console.error('[Acquirers route] failed to load
 * acquirer landscape', { err })` diagnostic on reject (loud, not silent).
 *
 * Compliance is a shell concern — the single `[data-compliance-status]` lives
 * once in the shell's floating command console (ledger §3.6). This route does
 * NOT mount a second indicator and does NOT dispatch compliance state.
 */

type LoadState = 'loading' | 'ready' | 'error';

/** Sortable columns. `rank` is the default DESC-by-composite ordering. */
type SortKey = 'composite' | 'financial' | 'culture' | 'name';
type SortDir = 'asc' | 'desc';

/** RAG band for a 0–100 score — the classical IB signal pattern. */
function ragColor(score: number): string {
  if (score >= 75) return 'var(--positive)';
  if (score >= 50) return 'var(--hold)';
  return 'var(--negative)';
}

/** Decisive verdict for a composite — doc-aligned (surface decisions, not data).
 *  Rank 1 is the recommendation; the band labels the rest of the field. */
function verdict(score: number, isLead: boolean): string {
  if (isLead) return 'Lead candidate';
  if (score >= 75) return 'Strong fit';
  if (score >= 50) return 'Watch';
  return 'Pass';
}

/** The anti-incumbent cue: AI-native vs SaaS incumbent, traced from the tagline. */
function fitLabel(acquirer: Acquirer): { label: string; aiNative: boolean } {
  const aiNative = /\bAI[ -]/i.test(acquirer.tagline);
  return aiNative
    ? { label: 'AI-native', aiNative: true }
    : { label: 'SaaS incumbent', aiNative: false };
}

type Row = {
  acquirer: Acquirer;
  score: CompositeScore;
};

export default function AcquirersPage() {
  const router = useRouter();
  const projectId = resolveProjectId(useParams().projectId);
  const [acquirers, setAcquirers] = React.useState<Acquirer[]>([]);
  const [scores, setScores] = React.useState<Record<string, CompositeScore>>(
    {},
  );
  const [peers, setPeers] = React.useState<Company[]>([]);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  const [sortKey, setSortKey] = React.useState<SortKey>('composite');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const [acqList, peerList] = await Promise.all([
          api.getAcquirers(projectId),
          api.getPeers(projectId),
        ]);

        const scoreEntries = await Promise.all(
          acqList.map(
            async (a) => [a.id, await api.getAcquirerScore(projectId, a.id)] as const,
          ),
        );

        if (!active) return;

        setAcquirers(acqList);
        setPeers(peerList);
        setScores(Object.fromEntries(scoreEntries));
        setLoadState('ready');
      } catch (err) {
        if (!active) return;
        console.error('[Acquirers route] failed to load acquirer landscape', {
          err,
        });
        setLoadState('error');
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [projectId]);

  const handleSelect = React.useCallback(
    (id: string) => {
      router.push(`/projects/${projectId}/acquirers/${id}`);
    },
    [router, projectId],
  );

  /** Composite-DESC base ordering — the canonical rank (1 = strongest fit). */
  const baseRanked = React.useMemo<Row[]>(() => {
    return acquirers
      .filter((a) => scores[a.id] !== undefined)
      .map((a) => ({ acquirer: a, score: scores[a.id] }))
      .sort((a, b) => b.score.total - a.score.total);
  }, [acquirers, scores]);

  /** Canonical rank by id — independent of the active table sort. */
  const rankById = React.useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    baseRanked.forEach((row, i) => {
      map[row.acquirer.id] = i + 1;
    });
    return map;
  }, [baseRanked]);

  /** The rows in the order the active sort dictates. */
  const rows = React.useMemo<Row[]>(() => {
    const sorted = baseRanked.slice();
    sorted.sort((a, b) => {
      let delta: number;
      switch (sortKey) {
        case 'name':
          delta = a.acquirer.name.localeCompare(b.acquirer.name);
          break;
        case 'financial':
          delta = a.score.financialSub - b.score.financialSub;
          break;
        case 'culture':
          delta = a.score.cultureSub - b.score.cultureSub;
          break;
        case 'composite':
        default:
          delta = a.score.total - b.score.total;
          break;
      }
      // Stable tiebreak on canonical rank so equal scores never jitter.
      if (delta === 0) {
        delta = rankById[a.acquirer.id] - rankById[b.acquirer.id];
        return delta; // tiebreak is always ascending-rank
      }
      return sortDir === 'asc' ? delta : -delta;
    });
    return sorted;
  }, [baseRanked, sortKey, sortDir, rankById]);

  const toggleSort = React.useCallback(
    (key: SortKey) => {
      setSortKey((prevKey) => {
        if (prevKey === key) {
          // Same column: flip direction.
          setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
          return prevKey;
        }
        // New column: name defaults A→Z (asc); scores default high→low (desc).
        setSortDir(key === 'name' ? 'asc' : 'desc');
        return key;
      });
    },
    [],
  );

  if (loadState === 'loading') {
    return (
      <section
        aria-label="Acquirers"
        className="page-shell flex w-full flex-1 flex-col py-[var(--space-12)]"
      >
        <StageStatus kind="loading" eyebrow="Acquirer landscape">
          <p
            className="font-mono text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
            aria-live="polite"
          >
            Scoring acquirers…
          </p>
        </StageStatus>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section
        aria-label="Acquirers"
        className="page-shell flex w-full flex-1 flex-col py-[var(--space-12)]"
      >
        <StageStatus kind="error" eyebrow="Acquirer landscape">
          <p
            role="status"
            className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          >
            The acquirer landscape could not be loaded right now.
          </p>
        </StageStatus>
      </section>
    );
  }

  if (baseRanked.length === 0) {
    return (
      <section
        aria-label="Acquirer landscape"
        className="page-shell flex w-full flex-1 flex-col gap-[var(--space-6)] py-[var(--space-6)]"
      >
        <header className="flex flex-col gap-[var(--space-3)]">
          <span className="eyebrow">Pipeline</span>
          <h1 className="display-1 max-w-[18ch] text-[var(--ink)]">
            No acquirers screened on this deal yet.
          </h1>
          <p className="editorial-lead max-w-2xl" role="status">
            Nothing has been scored against this mandate. The ranked landscape
            appears here once the screen runs.
          </p>
        </header>

        <PeerStrip peers={peers} />
      </section>
    );
  }

  // The recommendation, read straight off the canonical composite ranking —
  // never hardcoded. Drives the decisive sub-line and the lead row treatment.
  const lead = baseRanked[0];

  return (
    <section
      aria-label="Acquirer landscape"
      className="page-shell flex w-full flex-1 flex-col gap-[var(--space-6)] py-[var(--space-6)]"
    >
      <header className="flex flex-col gap-[var(--space-3)]">
        <span className="eyebrow">Pipeline</span>
        <h1 className="display-1 max-w-[18ch] text-[var(--ink)]">
          Five acquirers, ranked.
        </h1>
        <p className="editorial-lead max-w-2xl">
          <span className="font-semibold text-[var(--ink)]">
            {lead.acquirer.name}
          </span>{' '}
          leads at{' '}
          <span className="font-semibold tabular-nums text-[var(--ink)]">
            {lead.score.total}
          </span>
          . Take it to diligence.
        </p>
        <p className="caption max-w-2xl text-[var(--ink-secondary)]">
          Composite fit, computed deterministically and compliance-cleared. Sort
          the field by any column. Open a row for the deep-dive.
        </p>
      </header>

      <Card
        density="compact"
        className="overflow-hidden p-0"
        aria-label="Ranked acquirers"
      >
        <AcquirerTable
          rows={rows}
          rankById={rankById}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
          onSelect={handleSelect}
        />
      </Card>

      <PeerStrip peers={peers} />
    </section>
  );
}

/* ─── The interactive league table ─────────────────────────────────────── */

type AcquirerTableProps = {
  rows: Row[];
  rankById: Record<string, number>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onSelect: (id: string) => void;
};

function AcquirerTable({
  rows,
  rankById,
  sortKey,
  sortDir,
  onSort,
  onSelect,
}: AcquirerTableProps) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">
        Acquirers ranked by composite fit. Rows are acquirers; typed columns
        carry the fit thesis, the score figures, and the screen state. Sortable
        by composite, financial, or culture score. Select a row to open the
        deep-dive.
      </caption>
      <thead>
        <tr className="border-b border-[var(--stroke)] bg-[var(--surface)]">
          <Th align="right" className="w-[2.75rem]">
            <span className="sr-only">Rank</span>
          </Th>
          <SortableTh
            label="Acquirer"
            sortKey="name"
            active={sortKey === 'name'}
            dir={sortDir}
            onSort={onSort}
          />
          {/* Typed column: signal + thesis (Hebbia matrix grammar). */}
          <Th align="left" className="hidden w-[32%] md:table-cell">
            <span className="eyebrow inline-flex items-center gap-[var(--space-2)] text-[var(--ink-secondary)]">
              <span
                aria-hidden="true"
                className="h-[7px] w-[7px] rounded-full bg-[var(--positive)]"
              />
              Buyer fit
            </span>
          </Th>
          <SortableTh
            label="Composite"
            sortKey="composite"
            active={sortKey === 'composite'}
            dir={sortDir}
            onSort={onSort}
            align="right"
          />
          <SortableTh
            label="Financial"
            sortKey="financial"
            active={sortKey === 'financial'}
            dir={sortDir}
            onSort={onSort}
            align="right"
            className="hidden sm:table-cell"
          />
          <SortableTh
            label="Culture"
            sortKey="culture"
            active={sortKey === 'culture'}
            dir={sortDir}
            onSort={onSort}
            align="right"
            className="hidden sm:table-cell"
          />
          {/* Typed column: screen state (the compliance verdict per row). */}
          <Th align="left" className="hidden md:table-cell">
            <span className="eyebrow inline-flex items-center gap-[var(--space-2)] text-[var(--ink-secondary)]">
              <span
                aria-hidden="true"
                className="h-[7px] w-[7px] rounded-full bg-[var(--sync)]"
              />
              Screen
            </span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <AcquirerRow
            key={row.acquirer.id}
            row={row}
            rank={rankById[row.acquirer.id]}
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </table>
  );
}

const cellClass =
  'px-[var(--space-4)] py-[var(--space-3)] align-middle ' +
  'border-r border-[var(--stroke)] last:border-r-0';

type ThProps = {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
};

function Th({ children, align = 'left', className }: ThProps) {
  return (
    <th
      scope="col"
      className={[
        cellClass,
        'font-normal',
        align === 'right' ? 'text-right' : 'text-left',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </th>
  );
}

type SortableThProps = {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
};

function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
  className,
}: SortableThProps) {
  // aria-sort lives on the <th> per the ARIA grid pattern; the inner <button>
  // carries the keyboard affordance and the toggle.
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={[
        cellClass,
        'font-normal',
        align === 'right' ? 'text-right' : 'text-left',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={[
          'group inline-flex items-center gap-[var(--space-1)]',
          align === 'right' ? 'flex-row-reverse' : 'flex-row',
          'cursor-pointer rounded-[var(--radius-input)]',
          'outline-none transition-colors',
          'focus-visible:outline focus-visible:outline-2',
          'focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
        ].join(' ')}
      >
        <span
          className={[
            'eyebrow transition-colors',
            active
              ? 'text-[var(--ink)]'
              : 'text-[var(--ink-secondary)] group-hover:text-[var(--ink)]',
          ].join(' ')}
        >
          {label}
        </span>
        <SortGlyph active={active} dir={dir} />
      </button>
    </th>
  );
}

/** A quiet ▲/▼ caret — visible only on the active column. */
function SortGlyph({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'text-[length:var(--text-xs)] leading-none transition-opacity',
        active
          ? 'text-[var(--ink-secondary)] opacity-100'
          : 'opacity-0 group-hover:opacity-40',
      ].join(' ')}
    >
      {active && dir === 'asc' ? '▲' : '▼'}
    </span>
  );
}

type AcquirerRowProps = {
  row: Row;
  rank: number;
  onSelect: (id: string) => void;
};

function AcquirerRow({ row, rank, onSelect }: AcquirerRowProps) {
  const { acquirer, score } = row;
  const fit = fitLabel(acquirer);
  const isLead = rank === 1;

  const select = React.useCallback(
    () => onSelect(acquirer.id),
    [onSelect, acquirer.id],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    },
    [select],
  );

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`${acquirer.name}, composite score ${score.total}`}
      onClick={select}
      onKeyDown={onKeyDown}
      className={[
        'group relative cursor-pointer border-b border-[var(--stroke)]',
        'last:border-b-0 transition-colors',
        isLead
          ? 'bg-[var(--surface-raised)] hover:bg-[var(--surface-subtle)]'
          : 'hover:bg-[var(--surface-raised)]',
        'focus-visible:outline focus-visible:outline-2',
        'focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
      ].join(' ')}
    >
      {/* Rank — the quiet mono spine; the lead row carries an ink rail. */}
      <td className={`relative ${cellClass} text-right`}>
        {isLead ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-[3px] rounded-r-full bg-[var(--ink)]"
          />
        ) : null}
        <span
          aria-hidden="true"
          className={[
            'font-mono text-[length:var(--text-sm)] tabular-nums',
            isLead ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink-tertiary)]',
          ].join(' ')}
        >
          {rank}
        </span>
      </td>

      {/* Acquirer — name + fit cue. Below md the thesis column is hidden, so
          the description keeps a sub-line here (reachable at every width). */}
      <td className={cellClass}>
        <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
          <div className="flex flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
            <span className="font-sans text-[length:var(--text-md)] font-medium leading-tight text-[var(--ink)]">
              {acquirer.name}
            </span>
            <FitChip aiNative={fit.aiNative} label={fit.label} />
          </div>
          <p className="caption truncate text-[var(--ink-secondary)] md:hidden">
            {acquirer.tagline}
          </p>
        </div>
      </td>

      {/* Buyer fit — the typed signal + thesis cell (matrix grammar): the
          verdict dot + label, then the description clamped to four lines. */}
      <td className={`hidden ${cellClass} md:table-cell`}>
        <VerdictChip
          label={verdict(score.total, isLead)}
          color={ragColor(score.total)}
          lead={isLead}
        />
        <p className="mt-[var(--space-1)] line-clamp-4 max-w-[46ch] font-sans text-[length:var(--text-xs)] leading-normal text-[var(--ink-tertiary)]">
          {acquirer.tagline}
        </p>
      </td>

      {/* Composite — the verdict figure, mono tabular. */}
      <td className={`${cellClass} text-right`}>
        <RagNumber value={score.total} emphasis />
      </td>

      {/* Sub-scores — secondary register, hidden on the narrowest viewport. */}
      <td className={`hidden ${cellClass} text-right sm:table-cell`}>
        <RagNumber value={score.financialSub} />
      </td>
      <td className={`hidden ${cellClass} text-right sm:table-cell`}>
        <RagNumber value={score.cultureSub} />
      </td>

      {/* Screen — the compliance verdict the scorer computed for this row. */}
      <td className={`hidden ${cellClass} md:table-cell`}>
        <ScreenChip passed={score.compliancePassed} />
      </td>
    </tr>
  );
}

/** A compact score figure — mono, tabular (kit §05 figure register).
 *  `emphasis` = the composite hero number; the signal read lives in the
 *  verdict dot, not the digits. */
function RagNumber({
  value,
  emphasis = false,
}: {
  value: number;
  emphasis?: boolean;
}) {
  if (!emphasis) {
    return (
      <span className="font-mono tabular-nums text-[length:var(--text-md)] text-[var(--ink-secondary)]">
        {value}
      </span>
    );
  }
  return (
    <span className="font-mono font-semibold tabular-nums text-[length:var(--text-lg)] text-[var(--ink)]">
      {value}
    </span>
  );
}

/** The per-row screen verdict — the compliance result the scorer already
 *  computed (CompositeScore.compliancePassed), surfaced as the kit §03 solid
 *  pastel chip. Purely presentational; no state of its own. */
function ScreenChip({ passed }: { passed: boolean }) {
  return (
    <Badge tone={passed ? 'positive' : 'hold'}>
      {passed ? 'Cleared' : 'Hold'}
    </Badge>
  );
}

/** A one-word verdict — signal dot + label grammar (kit §03). The dot carries
 *  the strength tone; the label stays ink-secondary. Decisive labels,
 *  doc-aligned (surface decisions, not data dumps). */
function VerdictChip({
  label,
  color,
  lead,
}: {
  label: string;
  color: string;
  lead: boolean;
}) {
  const tone = lead ? 'var(--accent-dark)' : color;
  return (
    <span className="inline-flex items-center gap-[var(--space-2)] font-sans text-[length:var(--text-sm)] font-medium leading-none text-[var(--ink-secondary)]">
      <span
        aria-hidden="true"
        className="h-[6px] w-[6px] rounded-full"
        style={{ backgroundColor: tone }}
      />
      {label}
    </span>
  );
}

/** Local AI-native / SaaS-incumbent chip — same register as Pill, zero import
 *  cost on the hot graph. */
function FitChip({ aiNative, label }: { aiNative: boolean; label: string }) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border bg-[var(--surface)]',
        'px-[var(--space-2)] py-[var(--space-1)] font-sans font-medium',
        'text-[length:var(--text-xs)] leading-none',
        aiNative
          ? 'border-[var(--stroke-strong)] text-[var(--ink)]'
          : 'border-[var(--stroke)] text-[var(--ink-secondary)]',
      ].join(' ')}
    >
      {label}
    </span>
  );
}
