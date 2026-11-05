'use client';

import * as React from 'react';

import { Badge } from '@/components/atoms/Badge';
import { Button } from '@/components/atoms/Button';
import { Pill } from '@/components/atoms/Pill';
import { toFirmAuditEvent, type FirmAuditEvent } from '@/lib/audit/firmAudit';
import { TEAM_MAILBOX_AUDIT_VIEW } from '@/lib/constants/discovery';
import type {
  TeamMailboxAuditCursor,
  TeamMailboxAuditPage,
  TeamMailboxAuditRow,
  TeamMailboxAuditView,
} from '@/lib/discovery/api';

import { timeLabel } from './IngestionHealth';

/**
 * TeamInboxAuditTrail: the firm's team inbox audit trail (#173 G-03), on /discovery for the firm admin (under Team
 * inboxes) and the CCO (under Ingestion health). It shows the rows the firm's tamper-evident audit chain holds about
 * its own team inboxes: who connected one, each address check, who was given or lost access, pauses and first-read
 * windows, refused reads, the Google ingest group's state (a firm event, under "All team inboxes"), the reader passes
 * and, once candidates record their team inboxes, the deals firm rules proposed from one.
 *
 * Reads GET /api/v1/discovery/team-mailboxes/audit, which answers 404 to anyone but an active, internal admin or CCO
 * of a firm holding a team inbox (this renders nothing for them), one view at a time, newest first, with "Show
 * older" paging back by keyset. Every string a row shows comes from src/lib/audit/firmAudit.ts. Ids, fixed codes,
 * counts, names and the inbox's address only; never mail. The compliance instrument stays the console's
 * ComplianceRibbon; nothing here is a second one.
 *
 * Look and feel is the Workbench register (kit §11's light table, mono timestamps, dot pills, solid verdict chips);
 * the layout and the copy are design to confirm.
 */

export const TEAM_INBOX_AUDIT_ROUTE = '/api/v1/discovery/team-mailboxes/audit';

export const TEAM_INBOX_AUDIT_VIEWS: ReadonlyArray<{ id: TeamMailboxAuditView; label: string; empty: string }> = [
  {
    id: TEAM_MAILBOX_AUDIT_VIEW.ACCESS,
    label: 'Access and checks',
    empty: 'No access or check events are recorded yet.',
  },
  { id: TEAM_MAILBOX_AUDIT_VIEW.READS, label: 'All reads', empty: 'No reads are recorded yet.' },
  {
    id: TEAM_MAILBOX_AUDIT_VIEW.READS_NOTABLE,
    label: 'Reads with mail or problems',
    empty: 'No read has stored or excluded mail, or failed to finish.',
  },
];

export const TEAM_INBOX_AUDIT_INTRO =
  "Every connection, address check, change of access and read of the firm's team inboxes, from the tamper-evident audit chain. Mail content is never shown.";

export const TEAM_INBOX_AUDIT_ERROR = 'The team inbox audit trail could not be loaded. Try again shortly.';
export const TEAM_INBOX_AUDIT_OLDER_ERROR = 'Older rows could not be loaded. Try again shortly.';

const TOUCH = 'min-h-11 focus-visible:ring-2 focus-visible:ring-accent';

const HEADERS = ['Time', 'Inbox', 'Action', 'Detail', 'By'] as const;

/**
 * The route's URL for one page of a view. URLSearchParams encodes the cursor, so the `+` of the timestamp's offset
 * survives (an unencoded one decodes to a space, which the route refuses).
 */
export function auditPageUrl(view: TeamMailboxAuditView, before: TeamMailboxAuditCursor | null): string {
  const params = new URLSearchParams({ view });
  if (before) params.set('before', `${before.ts},${before.id}`);
  return `${TEAM_INBOX_AUDIT_ROUTE}?${params.toString()}`;
}

type Fetched = { kind: 'page'; page: TeamMailboxAuditPage } | { kind: 'hidden' } | { kind: 'error' };

async function fetchPage(view: TeamMailboxAuditView, before: TeamMailboxAuditCursor | null): Promise<Fetched> {
  try {
    const res = await fetch(auditPageUrl(view, before), { headers: { Accept: 'application/json' } });
    if (res.status === 404) return { kind: 'hidden' };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json()) as Partial<TeamMailboxAuditPage> | null;
    if (!body || !Array.isArray(body.inboxes) || !Array.isArray(body.rows)) return { kind: 'error' };
    return { kind: 'page', page: { inboxes: body.inboxes, rows: body.rows, next: body.next ?? null } };
  } catch {
    return { kind: 'error' };
  }
}

/** The rows of one view, oldest last; a later page appends, and a row already shown is not shown twice. */
type Shown = TeamMailboxAuditPage & { view: TeamMailboxAuditView };

type LoadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  /** retrying: "Try again" asked for the view once more, and the answer is not in yet. */
  | { status: 'error'; retrying: boolean }
  /** switching: the selected view is being read; viewFailed: that read failed, so its rows are not shown. */
  | { status: 'ready'; shown: Shown; switching: boolean; viewFailed: boolean };

function appendRows(shown: TeamMailboxAuditRow[], older: TeamMailboxAuditRow[]): TeamMailboxAuditRow[] {
  const ids = new Set(shown.map((r) => r.id));
  return [...shown, ...older.filter((r) => !ids.has(r.id))];
}

function InboxCell({ event }: { event: FirmAuditEvent }) {
  if (event.inboxKind === 'address') {
    return <span className="break-all font-mono text-[length:var(--text-xs)] text-[var(--ink)]">{event.inbox}</span>;
  }
  return <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{event.inbox}</span>;
}

function ActorCell({ event }: { event: FirmAuditEvent }) {
  if (event.actorCode) {
    return (
      <>
        Service <span className="font-mono">{event.actorCode}</span>
      </>
    );
  }
  return <>{event.actorLabel}</>;
}

const CELL = 'px-[var(--space-4)] py-[var(--space-3)] align-top';

function AuditTable({ shown, label }: { shown: Shown; label: string }) {
  const events = shown.rows.map((row) => toFirmAuditEvent(row, shown.inboxes, shown.view));
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-left">
        <thead>
          <tr>
            {HEADERS.map((h) => (
              <th
                key={h}
                scope="col"
                className="border-y border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} data-audit-row-id={event.id} className="border-b border-[var(--stroke)] last:border-b-0">
              <td className={`${CELL} whitespace-nowrap font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]`}>
                <time dateTime={event.ts}>{timeLabel(event.ts)}</time>
              </td>
              <td className={CELL}>
                <InboxCell event={event} />
              </td>
              <td className={CELL}>
                <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                  <Pill>Platform</Pill>
                  <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">{event.action}</span>
                  {event.verdict ? <Badge tone={event.verdict.tone}>{event.verdict.label}</Badge> : null}
                </div>
              </td>
              <td className={`${CELL} text-[length:var(--text-sm)] text-[var(--ink-secondary)]`}>{event.target}</td>
              <td className={`${CELL} text-[length:var(--text-sm)] text-[var(--ink-tertiary)]`}>
                <ActorCell event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heading() {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <h2 id="team-inbox-audit-heading" className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
        Team inbox audit trail
      </h2>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{TEAM_INBOX_AUDIT_INTRO}</p>
    </div>
  );
}

const SECTION =
  'flex flex-col rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]';

export function TeamInboxAuditTrail() {
  const [view, setView] = React.useState<TeamMailboxAuditView>(TEAM_MAILBOX_AUDIT_VIEW.ACCESS);
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [older, setOlder] = React.useState<'idle' | 'loading' | 'failed'>('idle');
  // Bumped by "Try again", so the effect asks for the same view once more.
  const [attempt, setAttempt] = React.useState(0);
  // A view switch makes an older page still in flight for the previous view stale.
  const generation = React.useRef(0);
  const olderInFlight = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    void fetchPage(view, null).then((result) => {
      if (cancelled) return;
      if (result.kind === 'hidden') {
        setState({ status: 'hidden' });
        return;
      }
      if (result.kind === 'error') {
        // Only the first read shows the error alone; a failed view switch keeps the pills, so another view can be read.
        setState((cur) =>
          cur.status === 'ready' ? { ...cur, switching: false, viewFailed: true } : { status: 'error', retrying: false },
        );
        return;
      }
      setState({ status: 'ready', shown: { view, ...result.page }, switching: false, viewFailed: false });
    });
    return () => {
      cancelled = true;
    };
  }, [view, attempt]);

  function selectView(next: TeamMailboxAuditView) {
    if (next === view) return;
    generation.current += 1;
    olderInFlight.current = false;
    setOlder('idle');
    setState((cur) => (cur.status === 'ready' ? { ...cur, switching: true, viewFailed: false } : cur));
    setView(next);
  }

  /** Asks for the current view again, after a first read or a view switch failed. */
  function retry() {
    generation.current += 1;
    olderInFlight.current = false;
    setOlder('idle');
    setState((cur) => {
      if (cur.status === 'error') return { status: 'error', retrying: true };
      if (cur.status === 'ready') return { ...cur, switching: true, viewFailed: false };
      return cur;
    });
    setAttempt((n) => n + 1);
  }

  async function showOlder() {
    if (state.status !== 'ready' || state.switching || !state.shown.next || olderInFlight.current) return;
    const { view: shownView, next } = state.shown;
    const mine = generation.current;
    olderInFlight.current = true;
    setOlder('loading');
    const result = await fetchPage(shownView, next);
    if (mine !== generation.current) return;
    olderInFlight.current = false;
    if (result.kind === 'hidden') {
      setState({ status: 'hidden' });
      return;
    }
    if (result.kind === 'error') {
      setOlder('failed');
      return;
    }
    setOlder('idle');
    setState((cur) =>
      cur.status === 'ready' && cur.shown.view === shownView
        ? {
            ...cur,
            shown: {
              view: shownView,
              // The registry list is current on every page; an older row's inbox is in it, open or closed.
              inboxes: result.page.inboxes,
              rows: appendRows(cur.shown.rows, result.page.rows),
              next: result.page.next,
            },
          }
        : cur,
    );
  }

  // Nothing until the first answer: most firms hold no team inbox, and the route's 404 hides the section for them.
  if (state.status === 'hidden' || state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <section aria-labelledby="team-inbox-audit-heading" className={`${SECTION} gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-4)]`}>
        <Heading />
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {TEAM_INBOX_AUDIT_ERROR}
        </p>
        <div>
          <Button variant="secondary" size="sm" className={TOUCH} disabled={state.retrying} onClick={retry}>
            Try again
          </Button>
        </div>
      </section>
    );
  }

  const selected = TEAM_INBOX_AUDIT_VIEWS.find((v) => v.id === view) ?? TEAM_INBOX_AUDIT_VIEWS[0];
  const { shown } = state;
  const count = shown.rows.length;

  let body: React.ReactNode;
  if (state.switching) {
    body = (
      <p role="status" className="border-t border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        Loading {selected.label.toLowerCase()}
      </p>
    );
  } else if (state.viewFailed) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-4)]">
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {TEAM_INBOX_AUDIT_ERROR}
        </p>
        <Button variant="secondary" size="sm" className={TOUCH} onClick={retry}>
          Try again
        </Button>
      </div>
    );
  } else if (count === 0) {
    body = (
      <p role="status" className="border-t border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {selected.empty}
      </p>
    );
  } else {
    body = (
      <>
        <AuditTable shown={shown} label={selected.label} />
        <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-3)]">
          <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
            {count} {count === 1 ? 'row' : 'rows'} shown
          </span>
          {shown.next ? (
            <Button
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={older === 'loading'}
              onClick={() => void showOlder()}
            >
              Show older
            </Button>
          ) : null}
        </div>
        {older === 'failed' ? (
          <p role="alert" className="px-[var(--space-5)] pb-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {TEAM_INBOX_AUDIT_OLDER_ERROR}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section aria-labelledby="team-inbox-audit-heading" className={SECTION}>
      <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)] px-[var(--space-5)] pb-[var(--space-3)] pt-[var(--space-4)]">
        <Heading />
        <div role="group" aria-label="Audit trail view" className="flex flex-wrap gap-[var(--space-1)]">
          {TEAM_INBOX_AUDIT_VIEWS.map((v) => {
            const pressed = v.id === view;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={pressed}
                onClick={() => selectView(v.id)}
                className={[
                  'inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-[var(--space-3)] ',
                  'font-sans text-[length:var(--text-sm)] font-medium leading-none ',
                  'transition-colors duration-150 ease-out ',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ',
                  pressed
                    ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
                    : 'bg-transparent text-[var(--ink-tertiary)] hover:text-[var(--ink)]',
                ].join('')}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </div>
      {body}
    </section>
  );
}

export default TeamInboxAuditTrail;
