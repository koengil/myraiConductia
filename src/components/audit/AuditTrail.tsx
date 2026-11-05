'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';

import {
  AUDIT_EVENT,
  eventBelongsToDeal,
  readAudit,
  type AuditEvent,
  type AuditKind,
} from '@/lib/audit/store';
import { fetchServerAudit, type ServerAuditResult } from '@/lib/audit/serverAudit';
import {
  resolveListedDeal,
  useActiveDealState,
  useDealListSource,
  useDeals,
} from '@/lib/deals/useDeals';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { DealListUnavailable, NotOnDeal } from '@/components/deals/DealsUnavailable';
import { Button } from '@/components/atoms/Button';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { AiSpendPanel } from './AiSpendPanel';
import { formatDayHeading, formatTime } from '@/lib/format/date';

/**
 * AuditTrail — the compliance record made visible.
 *
 * The thesis (Conductia compliance moat): every material action the MD takes
 * across the deal is tracked, timestamped, and preserved. This screen renders
 * TWO sources merged into one register: the append-only server audit_log
 * (platform events — mandate create, conflicts attestation, seat grants, CCO
 * notifications, rail advances, document views) fetched once per deal via
 * GET /api/v1/deals/{id}/audit, and the local demo log (chat prompts, step
 * actions, skills, documents). A fixture deal has no server record — the
 * fetch resolves null and the register stays local-only.
 *
 * Live by construction: reads the persisted local log via readAudit(), then
 * re-reads on the in-tab AUDIT_EVENT (fired by logAudit) and the cross-tab
 * `storage` event, so every surface that logs shows up here without a
 * refresh. Newest first, grouped by day, filterable by kind, exportable as
 * JSON (the merged register, not just the local slice).
 *
 * Token-driven throughout (light register sheet, hairline row dividers, mono
 * timestamps, white dot-category kind pills per kit §11) — no new CSS, no
 * hardcoded colour.
 */

// Kind → display label for the chip.
const KIND_LABEL: Record<AuditKind, string> = {
  chat: 'Chat',
  step: 'Step',
  file: 'File',
  folder: 'Folder',
  dataroom: 'Data room',
  skill: 'Skill',
  nav: 'Nav',
  platform: 'Platform',
};

// Kind → dot hue for the workbench dot-category pill (kit §03/§11): every
// kind renders the SAME white pill; only the 6px dot carries the category.
// Calm category hues, never verdict fills — an audit row is a record, not a
// judgment. Comms blue for chat, positive for steps (runs land), hold amber
// for document surfaces, the AI hue for skill runs, quiet gray for nav and
// platform plumbing.
const KIND_DOT: Record<AuditKind, string> = {
  chat: 'var(--sync)',
  skill: 'var(--ai)',
  step: 'var(--positive)',
  file: 'var(--hold)',
  folder: 'var(--hold)',
  dataroom: 'var(--hold)',
  nav: 'var(--ink-quiet)',
  platform: 'var(--ink-quiet)',
};

type FilterId = 'all' | 'chat' | 'step' | 'documents' | 'skill' | 'platform';

const FILTERS: ReadonlyArray<{
  id: FilterId;
  label: string;
  kinds: AuditKind[] | null; // null = every kind
}> = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'chat', label: 'Chats', kinds: ['chat'] },
  { id: 'step', label: 'Steps', kinds: ['step'] },
  { id: 'documents', label: 'Documents', kinds: ['file', 'folder', 'dataroom'] },
  { id: 'skill', label: 'Skills', kinds: ['skill'] },
  { id: 'platform', label: 'Platform', kinds: ['platform'] },
];

// The Person column. Server rows name who acted (or "Conductia" for a service
// or model row, set in serverAudit), and the signed-in person's own server rows
// read "You"; browser-local rows are only ever written by the person signed in
// on this browser, so they read "You" too. The export keeps the real name.
// Until the signed-in person is known, a row a person wrote stays blank: it
// may be their own, and their name must not flash before "You".
function personLabel(event: AuditEvent, myId: string | null, userKnown: boolean): string {
  if (!event.person) return 'You';
  if (event.personId && !userKnown) return '';
  if (myId && event.personId === myId) return 'You';
  return event.person;
}

// Column widths, shared by the column header and every row so they line up.
const TIME_COL = 'w-[70px]';
const KIND_COL = 'sm:w-[96px]';
const PERSON_COL = 'sm:w-[148px]';

// Group the (already newest-first) log into contiguous day buckets.
function groupByDay(
  events: AuditEvent[],
): Array<{ key: string; label: string; events: AuditEvent[] }> {
  const groups: Array<{ key: string; label: string; events: AuditEvent[] }> = [];
  for (const event of events) {
    const date = new Date(event.ts);
    const key = date.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.events.push(event);
    } else {
      groups.push({ key, label: formatDayHeading(date), events: [event] });
    }
  }
  return groups;
}

export function AuditTrail() {
  const [events, setEvents] = React.useState<AuditEvent[]>([]);
  // undefined: reading; null: the read failed; 'not-on-deal': the route
  // refused the deal; a list: the trail.
  const [serverResult, setServerResult] = React.useState<ServerAuditResult | undefined>(undefined);
  const [serverAttempt, setServerAttempt] = React.useState(0);
  const [filter, setFilter] = React.useState<FilterId>('all');
  // COMPLIANCE: the audit record is PER DEAL — show only actions taken on the
  // active deal, never another deal's. Entries are stamped with the deal code
  // name at log time (see logAudit callers).
  const params = useParams();
  const projectId = resolveProjectId(
    params?.projectId as string | string[] | undefined,
  );
  // The per-row deal chip belongs to the cross-deal view only (no deal in the
  // URL); a deal-scoped trail would repeat the same chip on every row.
  const showDealChip = !params?.projectId;
  // G22: never fall back to a seed deal (Project Summit) for a real code.
  // #162: when the deal list failed, the placeholder cannot scope the local
  // log to this deal, so the register states that instead of a short or
  // empty record.
  const {
    deal,
    unavailable: dealUnavailable,
    retry: retryDeals,
  } = useActiveDealState(projectId);
  const { deals, loading: dealsLoading } = useDeals();
  const dealSource = useDealListSource();
  const listedDeal = resolveListedDeal(projectId, deals, dealSource);
  const { state: userState } = useCurrentUser();
  const myId = userState.status === 'ready' ? userState.data.user.id : null;
  const userKnown = userState.status !== 'loading';

  // Live subscription: read on mount, then re-read whenever the log changes,
  // in this tab (AUDIT_EVENT) or another (storage). SSR reads empty, so the
  // first client render matches the server and hydration stays clean.
  React.useEffect(() => {
    const sync = () => setEvents(readAudit());
    sync();
    window.addEventListener(AUDIT_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(AUDIT_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // The platform trail: the deal's append-only audit_log, fetched once per
  // deal (and again on Try again). A failed read resolves null and is stated
  // as a failure.
  React.useEffect(() => {
    let cancelled = false;
    void fetchServerAudit(projectId).then((mapped) => {
      if (!cancelled) setServerResult(mapped);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, serverAttempt]);
  // A refused read is never an empty trail. A deal in the viewer's own list
  // that the route does not know is a fixture deal with no server record:
  // its register stays local-only. Any other refusal is the not-on-deal
  // state, decided once the list has answered.
  const serverRefused = serverResult === 'not-on-deal';
  const notOnDeal = serverRefused && !dealUnavailable && !dealsLoading && listedDeal === null;
  const hasListedDeal = listedDeal !== null;
  const serverEvents = React.useMemo<AuditEvent[] | null | undefined>(
    () => (serverResult === 'not-on-deal' ? (hasListedDeal ? [] : undefined) : serverResult),
    [serverResult, hasListedDeal],
  );
  const serverFailed = serverEvents === null;
  // Still reading: no count and no empty copy yet.
  const serverPending = serverEvents === undefined && !notOnDeal;
  const retryServer = () => {
    setServerResult(undefined);
    setServerAttempt((n) => n + 1);
  };
  // A disabled Export names its reason: the failed read's own line, the
  // loading line while the read is pending, or a short line while the record
  // holds nothing to export.
  const failedLineId = React.useId();
  const exportReasonId = React.useId();
  const pendingLineId = React.useId();

  const activeFilter = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const merged = React.useMemo(() => {
    // Scope the LOCAL log to this deal only. Unstamped events used to appear
    // on every deal (one shared localStorage key) — that leaked other deals'
    // data-room / skill / nav actions onto a newly created mandate. Server
    // events are already deal-scoped by the endpoint. Merge newest-first.
    const forDeal = events.filter((e) => eventBelongsToDeal(e, deal));
    return [...forDeal, ...(serverEvents ?? [])].sort((a, b) => b.ts - a.ts);
  }, [events, serverEvents, deal]);
  const filtered = React.useMemo(
    () =>
      activeFilter.kinds
        ? merged.filter((e) => activeFilter.kinds!.includes(e.kind))
        : merged,
    [merged, activeFilter],
  );
  const groups = React.useMemo(() => groupByDay(filtered), [filtered]);
  const nothingToExport = serverEvents != null && merged.length === 0;

  function handleExport() {
    // A real, working download: serialise the merged register (platform +
    // local, not the filtered view; the button says "Export all" while a
    // filter is on) and hand it off as a JSON blob. A server row exports its
    // stored action key as `action` (compliance exports carry machine values),
    // a local row its screen text; the screen's wording travels as `label`.
    // `detail` is the server row's stored payload (recipients, override
    // outcome), null on a local row, whose own context line travels as `note`.
    const payload = JSON.stringify(
      merged.map(({ actionKey, serverDetail, detail: note, ...event }) => ({
        ...event,
        action: actionKey ?? event.action,
        label: event.action,
        detail: serverDetail ?? null,
        ...(note ? { note } : {}),
      })),
      null,
      2,
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `conductia-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    <section
      aria-label="Audit Trail"
      className="flex h-full min-h-0 flex-col bg-[var(--surface-warm)]"
    >
      {/* Header — the compliance framing, filters, count, export. Fixed; the
          list below is the scroll region. */}
      <header className="page-shell shrink-0 border-b border-[var(--stroke)] py-[var(--space-5)]">
        <span className="eyebrow">Compliance record</span>
        <h1 className="display-1 mt-[var(--space-2)] text-[var(--ink)]">
          Audit Trail
        </h1>
        <p className="mt-[var(--space-2)] max-w-[62ch] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Every action on this deal, who took it and when.
        </p>

        {/* The deal's AI spend (#109), read from the ledger the routes write. */}
        {notOnDeal ? null : <AiSpendPanel dealId={projectId} />}

        {notOnDeal ? null : (
          <div className="mt-[var(--space-4)] flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-3)]">
            {/* Filter by kind. Selection fills with the single accent. */}
            <div
              role="group"
              aria-label="Filter audit events"
              className="flex flex-wrap gap-[var(--space-2)]"
            >
              {FILTERS.map((f) => {
                const selected = f.id === filter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    aria-pressed={selected}
                    className={[
                      'inline-flex h-[28px] items-center rounded-[var(--radius-pill)] px-[var(--space-3)] ',
                      'font-sans text-[length:var(--text-xs)] font-medium leading-none ',
                      'transition-colors duration-150 ease-out ',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ',
                      selected
                        ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
                        : 'bg-transparent text-[var(--ink-tertiary)] hover:text-[var(--ink)]',
                    ].join('')}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            {dealUnavailable ? null : (
              <div className="ml-auto flex items-center gap-[var(--space-3)]">
                {/* A failed or pending platform read has no honest count. A
                    failed read is stated once, in the register below. */}
                {serverPending || serverFailed ? null : (
                  <span
                    data-testid="audit-event-count"
                    className="inline-flex items-center gap-1.5 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]"
                  >
                    <span
                      aria-hidden
                      className="inline-block size-1.5 rounded-full bg-[var(--positive)]"
                    />
                    {filtered.length} {filtered.length === 1 ? 'event' : 'events'}
                  </span>
                )}
                {nothingToExport ? (
                  <span
                    id={exportReasonId}
                    className="font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
                  >
                    Nothing to export yet.
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={merged.length === 0 || serverEvents === undefined || serverFailed}
                  aria-describedby={
                    serverFailed
                      ? failedLineId
                      : serverPending
                        ? pendingLineId
                        : nothingToExport
                          ? exportReasonId
                          : undefined
                  }
                  className="inline-flex h-[28px] items-center rounded-[var(--radius-control)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)] disabled:opacity-40"
                >
                  {activeFilter.kinds ? `Export all (${merged.length})` : 'Export'}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {/* The register — the scroll region. A white register sheet (kit §11)
          under the warm header band. */}
      <div className="page-shell min-h-0 flex-1 overflow-y-auto bg-[var(--surface)] py-[var(--space-4)]">
        {!dealUnavailable && serverFailed ? (
          // The record could not be read: say so, in the deal-list framing.
          // Browser-local rows may still list below, never alone as the record.
          <div className="flex flex-col items-start gap-[var(--space-3)] py-[var(--space-4)]">
            <p id={failedLineId} role="alert" className="text-[length:var(--text-md)] text-[var(--ink-secondary)]">
              The audit trail could not be loaded.
            </p>
            <Button variant="primary" size="sm" onClick={retryServer}>
              Try again
            </Button>
          </div>
        ) : null}
        {!dealUnavailable && serverPending ? (
          <p id={pendingLineId} role="status" className="py-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
            Loading the audit trail.
          </p>
        ) : null}
        {dealUnavailable ? (
          <DealListUnavailable onRetry={retryDeals} />
        ) : notOnDeal ? (
          <NotOnDeal />
        ) : filtered.length === 0 ? (
          serverFailed || serverPending ? null : (
          <div className="flex h-full min-h-[240px] items-center justify-center">
            <p className="max-w-[42ch] text-center text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
              {merged.length === 0
                ? 'No activity yet. Actions you take across the deal are recorded here.'
                : 'No events of this kind yet.'}
            </p>
          </div>
          )
        ) : (
          <div className="flex flex-col gap-[var(--space-5)]">
            {/* Column header (wide screens). On a phone the person sits on a
                second line under the event, so the header would mislead. It
                sticks over the list's top padding so no row shows above it;
                the day headings stick under it. */}
            <div
              aria-hidden
              className="sticky top-[calc(var(--space-4)*-1)] z-20 -mb-[var(--space-2)] -mt-[var(--space-4)] hidden h-12 items-end gap-[var(--space-3)] border-b border-[var(--stroke)] bg-[var(--surface)] pb-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)] sm:flex"
            >
              <span className={`${TIME_COL} shrink-0`}>Time</span>
              <span className={`${KIND_COL} shrink-0`}>Kind</span>
              <span className={`${PERSON_COL} shrink-0`}>Person</span>
              <span className="min-w-0 flex-1">Event</span>
            </div>
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <div className="sticky top-0 z-10 flex items-baseline sm:top-8 gap-[var(--space-3)] bg-[var(--surface)] pb-[var(--space-2)]">
                  <h2 className="font-sans text-[length:var(--text-xs)] font-normal text-[var(--ink-tertiary)]">
                    {group.label}
                  </h2>
                  <span className="font-mono text-[length:var(--text-xxs)] tabular-nums text-[var(--ink-tertiary)]">
                    {group.events.length}
                  </span>
                  <span className="h-px flex-1 bg-[var(--stroke)]" />
                </div>
                <ol role="list">
                  {group.events.map((event) => (
                    <li
                      key={event.id}
                      className="flex min-h-[48px] flex-wrap items-center gap-x-[var(--space-3)] gap-y-[2px] border-b border-[var(--stroke)] py-[var(--space-2)] sm:flex-nowrap"
                    >
                      <time
                        dateTime={new Date(event.ts).toISOString()}
                        className={`${TIME_COL} shrink-0 font-mono text-[length:var(--text-xxs)] tabular-nums text-[var(--ink-tertiary)]`}
                      >
                        {formatTime(event.ts)}
                      </time>
                      <span className={`${KIND_COL} flex shrink-0`}>
                        <span className="inline-flex items-center gap-[6px] rounded-[var(--radius-pill)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[10px] py-[3px] text-[length:var(--text-xxs)] font-medium text-[var(--ink-secondary)]">
                          <span
                            aria-hidden
                            className="h-[6px] w-[6px] shrink-0 rounded-full"
                            style={{ background: KIND_DOT[event.kind] }}
                          />
                          {KIND_LABEL[event.kind]}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[var(--space-2)] sm:order-last">
                        <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                          {event.action}
                        </span>
                        <span
                          title={event.target}
                          className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
                        >
                          {event.target}
                          {event.detail ? (
                            <span className="ml-2 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                              {event.detail}
                            </span>
                          ) : null}
                        </span>
                        {showDealChip && event.deal ? (
                          <span
                            data-testid="audit-row-deal"
                            className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--stroke)] px-1.5 py-px font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]"
                          >
                            {event.deal}
                          </span>
                        ) : null}
                      </span>
                      {/* Person comes after the event in reading order: on a
                          phone it is the second line under the event; on wide
                          screens the event moves last, so this is a column. */}
                      <span
                        title={personLabel(event, myId, userKnown) || undefined}
                        className={`w-full truncate pl-[calc(70px+var(--space-3))] text-[length:var(--text-xs)] text-[var(--ink-secondary)] ${PERSON_COL} sm:shrink-0 sm:pl-0 sm:text-[length:var(--text-sm)]`}
                      >
                        <span className="sr-only">Person: </span>
                        <span data-testid="audit-row-person">{personLabel(event, myId, userKnown)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default AuditTrail;
