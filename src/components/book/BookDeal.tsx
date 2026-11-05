'use client';

/**
 * The Book deal view (#191 slice 2) — Storm's deck slide 10 as a live
 * preview: "the deal, organized and in motion."
 *
 * Left: Deal Status — the deal's REAL rail position rolled up into the
 * canonical 5 phases (done ✓ / current ● / to-do), with the "Day N · in
 * <phase> · next: <phase>" header line. Right: Deal Console — TASK | SOURCE
 * | STATUS with the agent-vs-human assignment first-class, mock-backed and
 * labeled (no task system exists yet).
 *
 * FULLY ADDITIVE: a sibling of the rail, never a replacement — it reads the
 * same deal data and touches none of the rail's code. Route exists only
 * with the book_view flag on (the page 404s otherwise).
 */

import Link from 'next/link';
import * as React from 'react';

import { formatCloseDate, formatFee } from '@/lib/book/data';
import {
  DEAL_CLOSE_DATE_MIN_ISO,
  DEAL_FEE_USD_MAX,
  checkFeeUsd,
  checkTargetCloseDate,
  maxTargetCloseDateIso,
} from '@/lib/validation/inputPolicy';
import {
  LIFECYCLE_CATEGORIES,
  LIFECYCLE_CATEGORY_LABEL,
  SCHEDULE_STATUSES,
  type ScheduleStatus,
} from '@/lib/constants/deals';
import { DealListUnavailable, NotOnDeal } from '@/components/deals/DealsUnavailable';
import { resolveListedDeal, useDealListSource, useDeals } from '@/lib/deals/useDeals';
import { useFlag } from '@/lib/flags/FlagsContext';
import { useProjectId } from '@/lib/project/useProjectId';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { canAccessDestination } from '@/lib/perspective/access';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import { PreviewBanner, PreviewChip } from '@/components/overlay';
import { bookPhases, consoleTasks, dealDay, nextPhaseName } from '@/lib/book/dealStatus';
import type { MockConsoleSource, MockConsoleStatus, MockConsoleSubtask } from '@/lib/mock/scale';
import type { FixtureDeal } from '@/lib/rail/deals';

/** The quiet links beside the Book label: the deal folder and the rail. */
const HEADER_LINK =
  'rounded-[var(--radius-control)] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]';

/** The Deal console's Preview banner: the rows are samples, not this deal's work. */
export const CONSOLE_SAMPLE_MESSAGE = "Sample tasks. These are not this deal's work yet.";

/** How the console will route work once real tasks exist. */
export const CONSOLE_FOOTER = 'Conductia drafts, your team reviews, you sign off.';

const SOURCE_LABEL: Record<MockConsoleSource, string> = {
  agent: 'Agent',
  agent_vp: 'Agent + VP',
  // Sample rows only: "Deal team", not a seniority title the glossary lacks.
  svp: 'Deal team',
  md: 'MD',
};

const STATUS_LABEL: Record<MockConsoleStatus, string> = {
  md_review: 'MD review',
  vp_review: 'VP review',
  // "In progress" is reserved vocabulary (glossary: the current step), so a
  // sample task that is under way reads "Open", like its open sub-items.
  in_progress: 'Open',
  completed: 'Completed',
};

function SourceChip({ source }: { source: MockConsoleSource }) {
  const agentish = source === 'agent' || source === 'agent_vp';
  // Workbench chip grammar (kit §03): field-gray fill, radius 6; agent-run
  // rows read in full ink. No violet — these are assignments, not a live run.
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-[6px] bg-[var(--surface-subtle)] px-[var(--space-2)] py-[var(--space-1)] font-mono text-[length:var(--text-xxs)] font-medium leading-none ${
        agentish ? 'text-[var(--ink)]' : 'text-[var(--ink-secondary)]'
      }`}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

function SubtaskList({ subtasks }: { subtasks: readonly MockConsoleSubtask[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--text-xs)]">
      {subtasks.map((item) => (
        <li key={item.title} className="flex items-center gap-1">
          <span className="sr-only">{item.done ? 'Done:' : 'Open:'}</span>
          <span
            aria-hidden
            className={item.done ? 'text-[var(--positive-deep)]' : 'text-[var(--ink-tertiary)]'}
          >
            {item.done ? '✓' : '○'}
          </span>
          <span className={item.done ? 'text-[var(--ink-tertiary)]' : 'text-[var(--ink-secondary)]'}>
            {item.title}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* Phase meter grammar (kit §10): done reads positive (the rail's step cards
 * precedent), the current mark is ink, to-dos sit on the field-gray track. */
function PhaseMark({ state }: { state: 'done' | 'current' | 'todo' }) {
  if (state === 'done') {
    return (
      <span aria-hidden className="text-[length:var(--text-base)] text-[var(--positive-deep)]">
        ✓
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--ink)]" />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 rounded-full border border-[var(--stroke-strong)] bg-[var(--surface-subtle)]"
    />
  );
}

/* React's documented adjust-state-during-render idiom (setState in the render
 * body). It replaces a value-carrying `key` on the parent: remounting the
 * editor on every save discarded the "Saved." receipt the MD had just earned. */
function useEditorValue(stored: string): [string, (next: string) => void] {
  const [value, setValue] = React.useState(stored);
  const [lastStored, setLastStored] = React.useState(stored);
  if (lastStored !== stored) {
    setLastStored(stored);
    setValue(stored);
  }
  return [value, setValue];
}

/**
 * PATCH one or more graduated Book fields (#191) on the deal and reload the
 * list. The server decides who may set them (MD or admin); a refusal is
 * shown, not swallowed. Shared by the three field editors below.
 */
function useBookFieldSave(dealId: string, onSaved: () => void) {
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = async (payload: Record<string, string | number | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/deals/${dealId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(body.error ?? `Could not save (${res.status}).`);
        return;
      }
      setNotice('Saved.');
      onSaved();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return { busy, notice, setNotice, save };
}

const EDITOR_INPUT =
  'rounded-[var(--radius-control)] border-0 bg-[var(--surface-subtle)] px-2.5 py-1.5 text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]';
const EDITOR_INPUT_NUMERIC = `${EDITOR_INPUT} font-mono tabular-nums`;
const EDITOR_BUTTON =
  'rounded-[var(--radius-control)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] disabled:opacity-50';

export const NO_CHANGE_COPY = 'No change to save.';

/**
 * A Book field's Save. At the stored value it stays in view, disabled, with
 * a visible reason its aria-describedby points at (the S6-24 pattern).
 */
function SaveFieldButton({
  label,
  unchanged,
  disabled,
  onClick,
}: {
  label: string;
  unchanged: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const reasonId = React.useId();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled || unchanged}
        aria-describedby={unchanged ? reasonId : undefined}
        className={EDITOR_BUTTON}
      >
        Save
      </button>
      {unchanged ? (
        <span id={reasonId} className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {NO_CHANGE_COPY}
        </span>
      ) : null}
    </>
  );
}

/**
 * The target close date — the first graduated Book field (#191). Read-only
 * when the API is off (the fixture demo cannot persist it); with the API on,
 * an inline date + Save that PATCHes the deal and reloads the list.
 */
function TargetClose({
  deal,
  editable,
  onSaved,
}: {
  deal: FixtureDeal;
  editable: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useEditorValue(deal.targetCloseDate ?? '');
  const { busy, notice, setNotice, save } = useBookFieldSave(deal.id, onSaved);

  const shown = deal.targetCloseDate ? formatCloseDate(deal.targetCloseDate) : 'Not set';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[length:var(--text-base)]">
      <span className="text-[var(--ink-secondary)]">
        Target close: <span className="font-mono font-medium tabular-nums text-[var(--ink)]">{shown}</span>
      </span>
      {editable ? (
        <>
          {/* Kit §06: filled borderless input on field gray. */}
          <input
            type="date"
            aria-label="Target close date"
            min={DEAL_CLOSE_DATE_MIN_ISO}
            max={maxTargetCloseDateIso()}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setNotice(null);
            }}
            className={EDITOR_INPUT_NUMERIC}
          />
          <SaveFieldButton
            label="Save target close"
            onClick={() => {
              const checked = checkTargetCloseDate(value ? value : null);
              if (!checked.ok) {
                setNotice(checked.message);
                return;
              }
              void save({ targetCloseDate: checked.value });
            }}
            disabled={busy}
            unchanged={(value || '') === (deal.targetCloseDate ?? '')}
          />
          <span role="status" aria-live="polite" className="text-[var(--ink-tertiary)]">
            {notice}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The mandate fee in whole USD — Book graduation field 2 (#191). */
function Fee({ deal, editable, onSaved }: { deal: FixtureDeal; editable: boolean; onSaved: () => void }) {
  const stored = deal.feeUsd == null ? '' : String(deal.feeUsd);
  const [value, setValue] = useEditorValue(stored);
  // A number input reports '' for unparseable text (e.g. "5,100,000"); that
  // must not be mistaken for "withdraw the fee". badInput blocks the save.
  const [badInput, setBadInput] = React.useState(false);
  const { busy, notice, setNotice, save } = useBookFieldSave(deal.id, onSaved);
  const shown = deal.feeUsd != null ? formatFee(deal.feeUsd) : 'Not set';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[length:var(--text-base)]">
      <span className="text-[var(--ink-secondary)]">
        Fee: <span className="font-mono font-medium tabular-nums text-[var(--ink)]">{shown}</span>
      </span>
      {editable ? (
        <>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={DEAL_FEE_USD_MAX}
            step={1}
            aria-label="Fee in US dollars"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setBadInput(Boolean(e.target.validity?.badInput));
              setNotice(null);
            }}
            className={EDITOR_INPUT_NUMERIC}
          />
          <SaveFieldButton
            label="Save fee"
            onClick={() => {
              const checked = checkFeeUsd(value === '' ? null : Number(value));
              if (!checked.ok) {
                setNotice(checked.message);
                return;
              }
              void save({ feeUsd: checked.value });
            }}
            disabled={busy || badInput}
            unchanged={!badInput && value === stored}
          />
          <span role="status" aria-live="polite" className="text-[var(--ink-tertiary)]">
            {notice}
          </span>
        </>
      ) : null}
    </div>
  );
}

const SCHEDULE_LABEL: Record<ScheduleStatus, string> = {
  ahead: 'Ahead',
  on_time: 'On time',
  late: 'Late',
};

/** The MD's read of the deal against plan — Book graduation field 3 (#191). */
function Schedule({ deal, editable, onSaved }: { deal: FixtureDeal; editable: boolean; onSaved: () => void }) {
  const [value, setValue] = useEditorValue(deal.scheduleStatus ?? '');
  const { busy, notice, setNotice, save } = useBookFieldSave(deal.id, onSaved);
  const shown = deal.scheduleStatus ? SCHEDULE_LABEL[deal.scheduleStatus] : 'Not set';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[length:var(--text-base)]">
      <span className="text-[var(--ink-secondary)]">
        Schedule: <span className="font-medium text-[var(--ink)]">{shown}</span>
      </span>
      {editable ? (
        <>
          <select
            aria-label="Schedule status"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setNotice(null);
            }}
            className={EDITOR_INPUT}
          >
            <option value="">Not set</option>
            {SCHEDULE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABEL[s]}
              </option>
            ))}
          </select>
          <SaveFieldButton
            label="Save schedule status"
            onClick={() => void save({ scheduleStatus: value === '' ? null : value })}
            disabled={busy}
            unchanged={value === (deal.scheduleStatus ?? '')}
          />
          <span role="status" aria-live="polite" className="text-[var(--ink-tertiary)]">
            {notice}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Storm's lifecycle category — Book graduation field 4 (#191). Never unset. */
function Category({ deal, editable, onSaved }: { deal: FixtureDeal; editable: boolean; onSaved: () => void }) {
  // Absent only on a fixture deal; a real deal always carries one (NOT NULL,
  // default 'live').
  const stored = deal.lifecycleCategory ?? '';
  const [value, setValue] = useEditorValue(stored || 'live');
  const { busy, notice, setNotice, save } = useBookFieldSave(deal.id, onSaved);
  const shown = deal.lifecycleCategory ? LIFECYCLE_CATEGORY_LABEL[deal.lifecycleCategory] : 'Not set';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[length:var(--text-base)]">
      <span className="text-[var(--ink-secondary)]">
        Category: <span className="font-medium text-[var(--ink)]">{shown}</span>
      </span>
      {editable ? (
        <>
          <select
            aria-label="Lifecycle category"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setNotice(null);
            }}
            className={EDITOR_INPUT}
          >
            {LIFECYCLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {LIFECYCLE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <SaveFieldButton
            label="Save lifecycle category"
            onClick={() => void save({ lifecycleCategory: value })}
            disabled={busy}
            unchanged={value === stored}
          />
          <span role="status" aria-live="polite" className="text-[var(--ink-tertiary)]">
            {notice}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The page's name (the Book tab), shown as its eyebrow. */
const BOOK_PAGE_TITLE = 'Book';

export function BookDeal() {
  const projectId = useProjectId();
  const { state, deals, reload } = useDeals();
  const apiCreateEnabled = useFlag('gate0_api_create');
  const dealSource = useDealListSource();
  const { state: userState } = useCurrentUser();
  // The shell's own rule: an outside party gets the external destination set.
  // Shown only once the viewer is known, so an outside party never sees it flash.
  const canOpenFolder =
    userState.status === 'ready' &&
    canAccessDestination(userState.data.user.is_external ? 'external' : 'storm', 'dealFolder');
  // Listed deals only (id OR code, fixture fallback where the source allows
  // it), never the pending placeholder: the Book states a deal's facts, so a
  // deal not in the viewer's list gets the not-on-deal state, never a page
  // of placeholder values under the raw code.
  const deal = resolveListedDeal(projectId, deals, dealSource);

  // While the deal list is in flight nothing is known yet: painting from a
  // partial list and then snapping is a lie for one frame. The rail guards
  // the same way (DealRail returns null while loading).
  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-[1080px] px-6 py-10 text-[length:var(--text-base)] text-[var(--ink-tertiary)]">
        Loading the deal…
      </div>
    );
  }
  // The list failed (#162): checked before the not-found copy, so a deal is
  // never "not here" (or a placeholder) because its list did not load.
  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        <DealListUnavailable onRetry={reload} />
      </div>
    );
  }
  if (!deal) {
    return (
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        {/* The page's one h1, the page title: never the deal's code or name. */}
        <NotOnDeal title={BOOK_PAGE_TITLE} />
      </div>
    );
  }

  const phases = bookPhases(deal);
  const current = phases.find((p) => p.state === 'current');
  const next = nextPhaseName(deal);
  const tasks = consoleTasks(deal);

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        <div className="mb-1 flex items-baseline justify-between">
          {/* Quiet sentence-case label — the uppercase eyebrow is retired. */}
          <p className="eyebrow">{BOOK_PAGE_TITLE}</p>
          <div className="flex items-baseline gap-4">
            {canOpenFolder ? (
              <Link
                href={`/projects/${deal.id}/deal-folder`}
                className={HEADER_LINK}
              >
                {DESTINATION_TITLES.dealFolder}
              </Link>
            ) : null}
            <Link
              href={`/projects/${deal.id}/rail`}
              className={HEADER_LINK}
            >
              Open the rail
            </Link>
          </div>
        </div>
        {/* The deal codename IS deal identity — the one sanctioned serif
            moment on this screen (kit §01). The code lives in the deal
            switcher menu, not on the page. */}
        <h1 className="deal-identity mb-4 text-[var(--ink)]">{deal.codename}</h1>
        {/* Editable only where a save can succeed: the API is on AND the
            viewer holds the MD seat (the server enforces the same; a
            non-MD would only ever see a 403). */}
        <div className="mb-8 flex flex-col gap-2">
          <TargetClose
            key={`close:${deal.id}`}
            deal={deal}
            editable={apiCreateEnabled && deal.dealRole === 'md'}
            onSaved={reload}
          />
          <Fee
            key={`fee:${deal.id}`}
            deal={deal}
            editable={apiCreateEnabled && deal.dealRole === 'md'}
            onSaved={reload}
          />
          <Schedule
            key={`schedule:${deal.id}`}
            deal={deal}
            editable={apiCreateEnabled && deal.dealRole === 'md'}
            onSaved={reload}
          />
          <Category
            key={`category:${deal.id}`}
            deal={deal}
            editable={apiCreateEnabled && deal.dealRole === 'md'}
            onSaved={reload}
          />
        </div>

        <div className="grid gap-10 lg:grid-cols-[1fr_1fr]">
          {/* Deal Status */}
          <section className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-7">
            <h2 className="display-1 text-[var(--ink)]">
              Deal status
            </h2>
            <p className="mb-6 mt-1.5 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              Day {dealDay(deal)} · in {current?.name ?? phases[0].name}
              {next ? ` · next: ${next}` : ''}
            </p>
            <ol className="flex flex-col gap-5">
              {phases.map((phase) => (
                <li
                  key={phase.index}
                  className="flex items-start gap-3"
                  aria-current={phase.state === 'current' ? 'step' : undefined}
                >
                  {/* The state is visual (mark) AND spoken (sr-only), as the
                      rail's step cards do. */}
                  <span className="sr-only">
                    {phase.state === 'done'
                      ? 'Complete:'
                      : phase.state === 'current'
                        ? 'Current phase:'
                        : 'Upcoming:'}
                  </span>
                  <span className="mt-0.5 flex w-4 justify-center">
                    <PhaseMark state={phase.state} />
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-[length:var(--text-md)] ${
                        phase.state === 'current'
                          ? 'font-semibold text-[var(--ink)]'
                          : phase.state === 'done'
                            ? 'text-[var(--ink-secondary)]'
                            : 'text-[var(--ink-tertiary)]'
                      }`}
                    >
                      {phase.name}
                    </p>
                    <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{phase.gloss}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Deal Console */}
          <section className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-7">
            {/* The task list below is sample content, not this deal's tasks yet.
                Honest-preview marker; handoff E21 "Real tasks for the Book's deal console".
                The rows never sit under the deal's real phase or step: that
                would read as this deal's own work. */}
            <h2 className="display-1 flex items-center gap-3 text-[var(--ink)]">
              Deal console
              <PreviewChip />
            </h2>
            <PreviewBanner message={CONSOLE_SAMPLE_MESSAGE} className="mb-5 mt-3" />
            <table className="w-full text-left text-[length:var(--text-base)]">
              <thead>
                {/* Kit §05: gray 12px sans headers, no caps, no tracking. */}
                <tr className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
                  <th className="pb-3 pr-4 font-medium">Task</th>
                  <th className="pb-3 pr-4 font-medium">Source</th>
                  <th className="pb-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const done = task.subtasks.filter((s) => s.done).length;
                  return (
                    <tr key={task.title} className="border-t border-[var(--stroke)] align-top">
                      <td className="py-3.5 pr-4 text-[var(--ink)]">
                        {task.title}
                        <SubtaskList subtasks={task.subtasks} />
                      </td>
                      <td className="py-3.5 pr-4">
                        <SourceChip source={task.source} />
                      </td>
                      <td className="py-3.5 text-[var(--ink-secondary)]">
                        {STATUS_LABEL[task.status]}
                        <span className="mt-1 block font-mono text-[length:var(--text-xxs)] tabular-nums text-[var(--ink-tertiary)]">
                          {done} of {task.subtasks.length} done
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-6 border-t border-[var(--stroke)] pt-4 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              {CONSOLE_FOOTER}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
