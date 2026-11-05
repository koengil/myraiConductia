'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog, PreviewBanner, PreviewChip, useRetainedWhileClosing } from '@/components/overlay';
import type { StepOwner } from '@/lib/rail/boardContract';
import { formatDate } from '@/lib/format/date';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import {
  datesProblem,
  linkProblem,
  type DrawnLink,
  type LinkKind,
  type RailPlanPreview,
  type StepDates,
} from '@/lib/rail/railPreview';
import { FIELD_INPUT, FIELD_LABEL } from './SkillBuilderPlacementFields';
import type { StepState } from './stepState';

/*
 * The dependency view: a Preview in this browser only (handoff E4,
 * docs/03-engineering/walkthrough-handoff-2026-10-22.md). The links are the
 * ones the person draws, hard or soft; nothing is inferred from the step
 * briefs' "Seq NN" references (those are sources, not gates: some point
 * forward, and skipped steps would wait forever). "Waiting on" appears only
 * for a drawn link whose earlier step is not done. Step dates sit here too,
 * shown in the header beside the deal's real target close. Nothing is
 * enforced and nothing reaches the deal.
 */

const KIND_LABEL: Record<LinkKind, string> = { hard: 'Hard', soft: 'Soft' };

/** A calendar day stored as YYYY-MM-DD, read in UTC so it never shifts a day. */
export function formatStepDay(day: string): string {
  return formatDate(day, { timeZone: 'UTC' });
}

export function datesLine(dates: StepDates | undefined): string | null {
  if (!dates) return null;
  const parts = [
    dates.start ? `Start ${formatStepDay(dates.start)}` : null,
    dates.target ? `Target ${formatStepDay(dates.target)}` : null,
    dates.dropDead ? `Drop-dead ${formatStepDay(dates.dropDead)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** How a satisfied link's earlier step closed. */
function closedAs(state: StepState): string {
  return state === 'skipped' ? ' · Skipped' : ' · Done';
}

/** Who owns a step: their initials, or an empty dashed mark. */
export function Face({ owner }: { owner: StepOwner | undefined }) {
  if (!owner) {
    return (
      <span
        aria-hidden
        title="Unassigned"
        className="block size-5 shrink-0 rounded-full border border-dashed border-[var(--ink-quiet)]"
      />
    );
  }
  return (
    <span
      aria-hidden
      title={owner.name}
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-subtle)] text-[length:var(--text-xxs)] font-semibold text-[var(--ink-secondary)] ring-1 ring-[var(--stroke-strong)]"
    >
      {owner.initials}
    </span>
  );
}

type LinePath = { id: string; kind: LinkKind; d: string };

/**
 * The lines between the cards on the board, from the step that comes first to
 * the step that waits. Sits inside the board's row, and draws only cards on the
 * page: a card folded away or in a closed phase has no line.
 */
export function DependencyLines({ links }: { links: readonly DrawnLink[] }) {
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [paths, setPaths] = React.useState<LinePath[]>([]);
  const markerId = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  React.useLayoutEffect(() => {
    const board = svgRef.current?.parentElement;
    if (!board) return;
    const measure = () => {
      const box = board.getBoundingClientRect();
      const next: LinePath[] = [];
      for (const link of links) {
        const from = board.querySelector(`[data-testid="step-${link.fromId}"]`)?.getBoundingClientRect();
        const to = board.querySelector(`[data-testid="step-${link.toId}"]`)?.getBoundingClientRect();
        if (!from || !to) continue;
        const y1 = from.top - box.top + from.height / 2;
        const y2 = to.top - box.top + to.height / 2;
        let d: string;
        if (Math.abs(from.left - to.left) < 4) {
          // The same column: a bulge into the gap beside it.
          const x = from.right - box.left;
          const bulge = 22 + Math.min(16, Math.abs(y2 - y1) / 20);
          d = `M${x} ${y1} C${x + bulge} ${y1} ${x + bulge} ${y2} ${x + 2} ${y2}`;
        } else {
          const forward = to.left > from.left;
          const x1 = (forward ? from.right : from.left) - box.left;
          const x2 = (forward ? to.left - 2 : to.right + 2) - box.left;
          const mid = (x1 + x2) / 2;
          d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
        }
        next.push({ id: link.id, kind: link.kind, d });
      }
      setPaths((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // Folds and phases change the cards' places, and they all resize the board.
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [links]);

  return (
    <svg ref={svgRef} aria-hidden className="pointer-events-none absolute inset-0 z-[3] size-full overflow-visible">
      <defs>
        {(['hard', 'soft'] as const).map((kind) => (
          <marker
            key={kind}
            id={`${markerId}-${kind}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" fill={kind === 'hard' ? 'var(--negative)' : 'var(--hold)'} />
          </marker>
        ))}
      </defs>
      {paths.map((path) => (
        <path
          key={path.id}
          data-dependency-link={path.kind}
          d={path.d}
          fill="none"
          stroke={path.kind === 'hard' ? 'var(--negative)' : 'var(--hold)'}
          strokeWidth={2}
          strokeDasharray={path.kind === 'soft' ? '6 5' : undefined}
          markerEnd={`url(#${markerId}-${path.kind})`}
        />
      ))}
    </svg>
  );
}

/** On a card in the dependency view: what it waits on, its dates, and setting them. */
export function DependencyCardDetail({
  step,
  links,
  byId,
  isDone,
  stateFor,
  label,
  dates,
  onEditDates,
}: {
  step: ProjectRailStep;
  /** The links this step waits on. */
  links: readonly DrawnLink[];
  byId: ReadonlyMap<string, ProjectRailStep>;
  isDone: (id: string) => boolean;
  stateFor: (step: ProjectRailStep) => StepState;
  label: (s: ProjectRailStep) => string;
  dates: StepDates | undefined;
  onEditDates: () => void;
}) {
  const when = datesLine(dates);
  return (
    <div className="flex flex-col gap-1 border-t border-dashed border-[var(--stroke)] pt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
      {links.map((link) => {
        const from = byId.get(link.fromId);
        if (!from) return null;
        const open = !isDone(link.fromId);
        return (
          <p
            key={link.id}
            className={
              open
                ? `font-medium ${link.kind === 'hard' ? 'text-[var(--negative-deep)]' : 'text-[var(--hold-deep)]'}`
                : undefined
            }
          >
            {open ? 'Waiting on' : 'After'} {label(from)} · {KIND_LABEL[link.kind]}
            {open ? '' : closedAs(stateFor(from))}
          </p>
        );
      })}
      {when ? <p>{when}</p> : null}
      <button
        type="button"
        onClick={onEditDates}
        aria-label={`Set dates for ${stepTitle(step)}`}
        className="self-start rounded-[var(--radius-input)] font-medium text-[var(--ink-secondary)] underline underline-offset-2 outline-offset-2 hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        Set dates
      </button>
    </div>
  );
}

/**
 * The dependency view around the board: what the lines mean above it, and every
 * link with the form to draw one below it.
 */
export function RailDependencyView({
  steps,
  stateFor,
  numberOf,
  plan,
  onAddLink,
  onRemoveLink,
  onReset,
  children,
}: {
  /** Every active step, in rail order. */
  steps: readonly ProjectRailStep[];
  stateFor: (step: ProjectRailStep) => StepState;
  numberOf: (step: ProjectRailStep) => string;
  plan: RailPlanPreview;
  onAddLink: (fromId: string, toId: string, kind: LinkKind) => void;
  onRemoveLink: (id: string) => void;
  onReset: () => void;
  /** The board, with its lines. */
  children: React.ReactNode;
}) {
  // Steps before the deal opened here are reference only: nothing waits on them.
  const planned = React.useMemo(() => steps.filter((s) => stateFor(s) !== 'prior'), [steps, stateFor]);
  const byId = React.useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const label = (s: ProjectRailStep) => `${numberOf(s)} · ${stepTitle(s)}`;
  // A skipped step will never be done, so it is never waited on.
  const closed = (s: ProjectRailStep) => {
    const state = stateFor(s);
    return state === 'done' || state === 'skipped';
  };
  // Links whose steps left the rail are not shown.
  const links = plan.links.filter((l) => byId.has(l.fromId) && byId.has(l.toId));

  return (
    <section aria-label="Dependencies" className="flex flex-col gap-[var(--space-3)]">
      {/* Preview: handoff E4 "Step dependencies, per-step dates and \"started\" facts". */}
      <PreviewBanner onReset={onReset} />
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Draw the links your team works to. Nothing here is read from the step briefs, and nothing is
        enforced. A step shows &ldquo;Waiting on&rdquo; only for a link you drew.
      </p>
      <ul
        aria-label="Line key"
        className="flex flex-wrap gap-x-[var(--space-4)] gap-y-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        <li className="flex items-center gap-[var(--space-2)]">
          <svg width="36" height="10" aria-hidden>
            <line x1="0" y1="5" x2="36" y2="5" stroke="var(--negative)" strokeWidth="2" />
          </svg>
          Hard: must wait
        </li>
        <li className="flex items-center gap-[var(--space-2)]">
          <svg width="36" height="10" aria-hidden>
            <line x1="0" y1="5" x2="36" y2="5" stroke="var(--hold)" strokeWidth="2" strokeDasharray="5 4" />
          </svg>
          Soft: should wait
        </li>
      </ul>

      {children}

      <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
        <h2 className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">Links on this rail</h2>
        {links.length === 0 ? (
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">No links drawn yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              <thead className="text-[var(--ink-tertiary)]">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Comes first</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Waits</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Kind</th>
                  <th scope="col" className="py-1 font-medium"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => {
                  const from = byId.get(link.fromId) as ProjectRailStep;
                  const to = byId.get(link.toId) as ProjectRailStep;
                  return (
                    <tr key={link.id} className="border-t border-[var(--stroke)]">
                      <td className="py-1.5 pr-3">{stepTitle(from)}</td>
                      <td className="py-1.5 pr-3">{stepTitle(to)}</td>
                      <td className="py-1.5 pr-3">{KIND_LABEL[link.kind]}</td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => onRemoveLink(link.id)}
                          aria-label={`Remove link: ${stepTitle(to)} waits on ${stepTitle(from)}`}
                          className="font-medium underline underline-offset-2 hover:text-[var(--ink)]"
                        >
                          Remove link
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <DrawLinkForm
          // A done or skipped step waits on nothing: it is offered only as the earlier step.
          waiting={planned.filter((s) => !closed(s))}
          steps={planned}
          links={links}
          label={label}
          onAddLink={onAddLink}
        />
      </div>
    </section>
  );
}

function DrawLinkForm({
  waiting,
  steps,
  links,
  label,
  onAddLink,
}: {
  /** The steps that can wait on another (not done or skipped). */
  waiting: readonly ProjectRailStep[];
  steps: readonly ProjectRailStep[];
  links: readonly DrawnLink[];
  label: (s: ProjectRailStep) => string;
  onAddLink: (fromId: string, toId: string, kind: LinkKind) => void;
}) {
  const [toId, setToId] = React.useState('');
  const [fromId, setFromId] = React.useState('');
  const [kind, setKind] = React.useState<LinkKind>('hard');
  const [problem, setProblem] = React.useState<string | null>(null);
  const formId = React.useId();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const why = linkProblem(links, fromId, toId);
    setProblem(why);
    if (why) return;
    onAddLink(fromId, toId, kind);
    setFromId('');
  };
  return (
    <form
      onSubmit={submit}
      aria-label="Draw a link"
      className="grid gap-[var(--space-3)] md:grid-cols-[1fr_1fr_180px_auto] md:items-end"
    >
      <div>
        <label className={FIELD_LABEL} htmlFor={`${formId}-to`}>
          Step
        </label>
        <select id={`${formId}-to`} value={toId} onChange={(e) => setToId(e.target.value)} className={FIELD_INPUT}>
          <option value="">Choose a step</option>
          {waiting.map((s) => (
            <option key={s.id} value={s.id}>
              {label(s)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`${formId}-from`}>
          Waits on
        </label>
        <select id={`${formId}-from`} value={fromId} onChange={(e) => setFromId(e.target.value)} className={FIELD_INPUT}>
          <option value="">Choose a step</option>
          {steps.map((s) => (
            <option key={s.id} value={s.id}>
              {label(s)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={FIELD_LABEL} htmlFor={`${formId}-kind`}>
          Kind
        </label>
        <select
          id={`${formId}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as LinkKind)}
          className={FIELD_INPUT}
        >
          <option value="hard">Hard: must wait</option>
          <option value="soft">Soft: should wait</option>
        </select>
      </div>
      <Button type="submit" variant="secondary">
        Draw link
      </Button>
      {problem ? (
        <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative-deep)] md:col-span-4">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

export function StepDatesDialog({
  step,
  dates,
  onClose,
  onSave,
}: {
  step: ProjectRailStep | null;
  dates: StepDates | undefined;
  onClose: () => void;
  onSave: (dates: StepDates) => void;
}) {
  const shown = useRetainedWhileClosing(step);
  const [draft, setDraft] = React.useState<{ id: string; start: string; target: string; dropDead: string } | null>(null);
  const id = React.useId();
  const value =
    draft && shown && draft.id === shown.id
      ? draft
      : { id: shown?.id ?? '', start: dates?.start ?? '', target: dates?.target ?? '', dropDead: dates?.dropDead ?? '' };
  const edit = (patch: Partial<{ start: string; target: string; dropDead: string }>) => setDraft({ ...value, ...patch });
  const problem = datesProblem(value.target, value.dropDead, value.start);
  const problemId = `${id}-problem`;
  const close = () => {
    setDraft(null);
    onClose();
  };
  return (
    <Dialog
      open={step !== null}
      onClose={close}
      dismissOnScrim={false}
      size="sm"
      eyebrow="Step dates"
      title={shown ? stepTitle(shown) : 'Step dates'}
      description="Kept in this browser only. They show beside the deal's target close."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={problem !== null}
            aria-describedby={problem ? problemId : undefined}
            onClick={() => {
              if (problem) return;
              onSave({
                start: value.start || undefined,
                target: value.target || undefined,
                dropDead: value.dropDead || undefined,
              });
              setDraft(null);
            }}
          >
            Set dates
          </Button>
        </>
      }
    >
      <p className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {/* Preview: handoff E4 "Step dependencies, per-step dates and \"started\" facts". */}
        <PreviewChip />
        <span>These dates show in this browser only. Nothing is saved to the deal.</span>
      </p>
      <div className="flex flex-col gap-[var(--space-3)]">
        <div>
          <label className={FIELD_LABEL} htmlFor={`${id}-start`}>
            Start date
          </label>
          <input
            id={`${id}-start`}
            type="date"
            value={value.start}
            onChange={(e) => edit({ start: e.target.value })}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`${id}-target`}>
            Target date
          </label>
          <input
            id={`${id}-target`}
            type="date"
            value={value.target}
            onChange={(e) => edit({ target: e.target.value })}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`${id}-drop`}>
            Drop-dead date
          </label>
          <input
            id={`${id}-drop`}
            type="date"
            value={value.dropDead}
            onChange={(e) => edit({ dropDead: e.target.value })}
            className={FIELD_INPUT}
          />
        </div>
        {problem ? (
          <p id={problemId} role="alert" className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export default RailDependencyView;
