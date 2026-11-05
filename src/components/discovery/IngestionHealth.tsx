'use client';

import * as React from 'react';

import { Badge, type Tone } from '@/components/atoms/Badge';
import { Button } from '@/components/atoms/Button';
import { StageStatus } from '@/components/shell/StageStatus';
import {
  BACKFILL_WINDOW_DEFAULT_DAYS,
  BACKFILL_WINDOW_MAX_DAYS,
  DELEGATION_STATUS,
  DRIFT_STATUS,
  HISTORY_WINDOW_EXCEEDED,
  HISTORY_WINDOW_HALT_DAYS,
  MAILBOX_PROVIDER,
  MAILBOX_REFUSAL_REASON,
  REGISTRATION_STATUS,
  SOURCE_KIND,
  SITE_REFUSAL_REASON,
  SOURCE_STATUS,
  type MailboxProvider,
  type ReaderPassGroup,
  type SourceHealthState,
} from '@/lib/constants/discovery';
import type {
  AllowlistHealth,
  IngestionHealth as Health,
  IngestionSourceHealth,
  ReaderHealth,
  ReaderPassHealth,
  ReaderPassTotals,
  ReaderRegistrationHealth,
} from '@/lib/discovery/api';
import { formatDate, formatDateTime } from '@/lib/format/date';

import { FIELD_CLASS } from './CorrectionDialog';

/**
 * IngestionHealth: the discovery connector's health on /discovery, for the
 * firm admin who runs it and for the control room. Reads
 * GET /api/v1/discovery/health, which answers counts and sync state only:
 * which sources are configured, how far each has read, when it last synced,
 * what it ledgered and routed, how many the exclusion policy skipped (a count
 * under every policy version) beside the policy's current version as its own
 * line, its last error, and its last mail check, with the last 24 hours'
 * passes, as outcomes and counts (#370). Never a subject, a participant or a party, and never
 * which rule or address excluded an item. For anyone else the route answers 404 and this
 * renders nothing.
 *
 * Per provider it also shows the reader registration (for Google, the
 * delegation status the reader last saw), the allowlist group drift as counts,
 * and for each source its checkpoint age, why the guard is holding it, for a
 * Gmail mailbox the window its first read takes (#353), and, for
 * the firm's admin, a pause or resume control, for a halted mailbox Restart
 * reading, and, before a Gmail mailbox's first read, Change window. Each source shows one state badge (the database's evidence-based
 * state, with a reason line where one helps) and the card opens with a reader
 * line: is the firm's mail being read. Every control refetches the health
 * instead of patching it, and the card refetches every minute while it is
 * visible and again when the page comes back, with an "Updated" line from the
 * last successful read, so a stopped worker never keeps a healthy card on an
 * open page (#409 stack audit, S1). Reconciliation is not built: it
 * is shown as such, never as a clean state. The compliance instrument stays
 * the console's ComplianceRibbon; nothing here is a second one.
 */

export function timeLabel(value: string | null): string {
  if (!value) return 'Never';
  const label = formatDateTime(Date.parse(value), { timeZone: 'UTC' });
  return label ? `${label} UTC` : 'Never';
}

/** A calendar date ('YYYY-MM-DD', UTC) as "Jul 17, 2026": timeLabel without the time. Null when it is not one. */
export function dateLabel(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return formatDate(`${value}T00:00:00Z`, { timeZone: 'UTC' }) || null;
}

type WindowSource = Partial<Pick<IngestionSourceHealth, 'kind' | 'provider' | 'backfillSince'>>;

/** The window is a Google mailbox's: the one reader that honours it (#353; Graph is follow-up F1). */
function hasWindow(source: WindowSource): boolean {
  return source.kind === SOURCE_KIND.MAILBOX && source.provider === MAILBOX_PROVIDER.GOOGLE;
}

/**
 * The Window line (#353): "Reads mail from Jul 17, 2026", or "Whole mailbox" for a source with no window (one that
 * read before windows existed). Null, so no line, for any other source and for an older payload without the key.
 */
export function windowLabel(source: WindowSource): string | null {
  if (!hasWindow(source) || source.backfillSince === undefined) return null;
  if (source.backfillSince === null) return 'Whole mailbox';
  const date = dateLabel(source.backfillSince);
  return date ? `Reads mail from ${date}` : null;
}

/** What a restart reads again: from the window's first day when one is set, else the whole mailbox. */
export function restartScopeLabel(source: WindowSource): string {
  const date = hasWindow(source) ? dateLabel(source.backfillSince) : null;
  return date ? `Restarting reads this mailbox again from ${date}.` : 'Restarting reads this mailbox again from the start.';
}

/** The UTC calendar date ('YYYY-MM-DD') `daysBack` days before `now`: the clock the set-window RPC bounds by, not the browser's. */
export function utcDateIso(now: number, daysBack = 0): string {
  const at = new Date(now);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - daysBack)).toISOString().slice(0, 10);
}

/** What the window editor offers: today (UTC) back to BACKFILL_WINDOW_MAX_DAYS before it, and the 90-day default. */
export function windowBounds(now: number): { min: string; max: string; defaultSince: string } {
  return {
    min: utcDateIso(now, BACKFILL_WINDOW_MAX_DAYS),
    max: utcDateIso(now),
    defaultSince: utcDateIso(now, BACKFILL_WINDOW_DEFAULT_DAYS),
  };
}

/**
 * Shown under the date while the chosen start is earlier than the default (design to confirm). The days are the
 * worker's halt rule (HISTORY_WINDOW_HALT_DAYS), not a Gmail retention period.
 */
export const WINDOW_LONG_HINT = `A longer window makes the first read longer. A first read that takes more than ${HISTORY_WINDOW_HALT_DAYS} days can halt.`;

type WindowFailure = 'locked' | 'range' | 'refused' | 'error';

/** Why a window was not saved, by the route's status: 409 window_locked, 400 out of range, 404 any refusal, else. */
export const WINDOW_FAILURE: Record<WindowFailure, string> = {
  locked: 'Reading has started. The window is fixed for this pass.',
  range: 'Choose a date within the last two years.',
  refused: 'Changing the window is not available right now.',
  error: 'The window could not be saved. Try again shortly.',
};

const CHECKPOINT: Record<IngestionSourceHealth['checkpointState'], { label: string; tone: Tone }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  backfilling: { label: 'Backfilling', tone: 'hold' },
  incremental: { label: 'Up to date', tone: 'positive' },
};

const SOURCE_STATE: Record<SourceHealthState, { label: string; tone: Tone }> = {
  up_to_date: { label: 'Up to date', tone: 'positive' },
  reading: { label: 'Reading', tone: 'neutral' },
  not_started: { label: 'Not started', tone: 'neutral' },
  stale: { label: 'Stale', tone: 'hold' },
  halted: { label: 'Halted', tone: 'negative' },
  delegation_broken: { label: 'Access approval broken', tone: 'negative' },
  waiting: { label: 'Waiting for access', tone: 'hold' },
  failing: { label: 'Failing', tone: 'negative' },
  paused: { label: 'Paused', tone: 'hold' },
  switched_off: { label: 'Switched off', tone: 'neutral' },
};

/** The source's state as a label and tone; an older payload without one keeps the checkpoint badge it had. */
export function sourceStateBadge(source: Pick<IngestionSourceHealth, 'state' | 'checkpointState'>): { label: string; tone: Tone } {
  return (source.state && SOURCE_STATE[source.state]) ?? CHECKPOINT[source.checkpointState];
}

export function sourceKindLabel(kind: IngestionSourceHealth['kind']): string {
  return kind === 'mailbox' ? 'Mailbox' : 'SharePoint site';
}

const PROVIDER_LABEL: Record<MailboxProvider, string> = {
  [MAILBOX_PROVIDER.MICROSOFT]: 'Microsoft 365',
  [MAILBOX_PROVIDER.GOOGLE]: 'Gmail',
};
const PROVIDER_READER_LABEL: Record<MailboxProvider, string> = {
  [MAILBOX_PROVIDER.MICROSOFT]: 'Microsoft 365',
  [MAILBOX_PROVIDER.GOOGLE]: 'Google Workspace',
};

/** A mailbox names its provider; a SharePoint site is Microsoft's by definition. */
export function sourceLabel(source: Pick<IngestionSourceHealth, 'kind' | 'provider'>): string {
  if (source.kind !== SOURCE_KIND.MAILBOX) return sourceKindLabel(source.kind);
  const provider = PROVIDER_LABEL[source.provider];
  return provider ? `${provider} mailbox` : sourceKindLabel(source.kind);
}

/** The age of the resume point, in the coarsest unit that keeps it exact enough to judge. */
export function ageLabel(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * One plain line for the states that need a reason; nothing for the others. Stale ages the source's last activity
 * (its newest pass row or progress mark, the clock the reader line uses), or its last pass on an older payload.
 */
export function sourceStateReason(
  source: Pick<IngestionSourceHealth, 'state' | 'lastPassAgeSeconds' | 'lastActivityAgeSeconds'> & WindowSource,
): string | null {
  const activityAge = typeof source.lastActivityAgeSeconds === 'number' ? source.lastActivityAgeSeconds : source.lastPassAgeSeconds;
  switch (source.state) {
    case 'halted':
      return `Mail history expired before mail reading caught up. ${restartScopeLabel(source)}`;
    case 'delegation_broken':
      return "Google refused Conductia's access to this mailbox. A Google Workspace admin restores it, and reading resumes on the next mail check.";
    case 'stale':
      return typeof activityAge === 'number'
        ? `No completed read and no mail reading progress in the last 15 min; last mail activity ${ageLabel(activityAge)}.`
        : 'No mail check recorded for this mailbox.';
    default:
      return null;
  }
}

const LAST_ERROR_LABEL: Record<string, string> = { [HISTORY_WINDOW_EXCEEDED]: 'Mail history expired' };

export function lastErrorLabel(code: string): string {
  return LAST_ERROR_LABEL[code] ?? code;
}

/**
 * The reader line. "Last mail check" means the worker recorded an attempt on a readable mailbox then, whatever its
 * outcome; idle shows nothing.
 */
export function readerLine(reader: ReaderHealth): { label: string; tone: Tone; detail: string } | null {
  const last = timeLabel(reader.lastActiveAt);
  switch (reader.state) {
    case 'reading':
      return { label: 'Reading', tone: 'positive', detail: `Last mail check ${last}` };
    case 'active':
      return { label: 'Running', tone: 'neutral', detail: `Last mail check ${last}. No mailbox is reading right now; see each mailbox below.` };
    case 'not_reading':
      return {
        label: 'Not reading',
        tone: 'negative',
        detail: reader.lastActiveAt
          ? `No mail check since ${last}. Mail reading may be stopped, or retrying failing mailboxes with growing delays.`
          : 'No mail check recorded.',
      };
    case 'switched_off':
      return { label: 'Switched off', tone: 'neutral', detail: 'Reading is switched off.' };
    default:
      return null;
  }
}

/**
 * Every reason the guard can give (mailbox_guard_state.last_reason's vocabulary:
 * the mailbox verdict, the worker's group verdicts, and the site reasons), in
 * words an admin can act on. A reason this table does not know, from a newer
 * database, still renders as a plain held-by-the-guard line, never as raw
 * snake case and never as nothing.
 */
const WAITING_LABEL: Record<string, string> = {
  [MAILBOX_REFUSAL_REASON.NO_INVITE]: 'No accepted invitation for this address',
  [MAILBOX_REFUSAL_REASON.SEAT_INACTIVE]: 'The seat is not active',
  [MAILBOX_REFUSAL_REASON.EXTERNAL]: "Not a user of the firm's own bank",
  [MAILBOX_REFUSAL_REASON.NO_CONSENT]: "Waiting for the user's consent",
  [MAILBOX_REFUSAL_REASON.DOMAIN]: "The address's domain is not registered",
  [MAILBOX_REFUSAL_REASON.OWNER_MISMATCH]: 'The owner is not the consenting user',
  [MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP]: 'Not matched to one member of the group',
  [MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE]: 'Group unreadable',
  [MAILBOX_REFUSAL_REASON.REGISTRATION_INACTIVE]: 'Mail reading is not set up for this provider',
  [MAILBOX_REFUSAL_REASON.PROVIDER_MISMATCH]: "Read through another provider",
  [MAILBOX_REFUSAL_REASON.NO_SOURCE]: 'No source record for this address',
  [MAILBOX_REFUSAL_REASON.SOURCE_PAUSED]: 'Paused',
  // A team inbox (#581). Look and feel: design to confirm.
  [MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_UNVERIFIED]: 'Waiting for the address check',
  [MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_DISCONNECTED]: 'The team inbox was removed',
  [MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_PERSON]: "This is a person's address",
  [SITE_REFUSAL_REASON.SITE_NOT_REGISTERED]: 'The site is not registered',
  [SITE_REFUSAL_REASON.SITE_WRONG_FIRM]: "The site is not the firm's own",
  [SITE_REFUSAL_REASON.SITE_REGISTRANT_LOST]: 'The admin who registered the site no longer has access',
};

export function waitingLabel(reason: string): string {
  return WAITING_LABEL[reason] ?? 'Held until access is confirmed';
}

/** Registration status in plain words: pending is waiting on the firm's admin, disabled is off. */
export function readingStateLabel(status: ReaderRegistrationHealth['status']): string {
  switch (status) {
    case REGISTRATION_STATUS.ACTIVE:
      return 'on';
    case REGISTRATION_STATUS.PENDING:
      return 'waiting for approval';
    default:
      return 'off';
  }
}

export function delegationBadge(status: ReaderRegistrationHealth['delegationStatus'] | undefined): {
  label: string;
  tone: Tone;
} {
  switch (status) {
    case DELEGATION_STATUS.OK:
      return { label: 'Access approved by your admin', tone: 'positive' };
    case DELEGATION_STATUS.MISSING:
      return { label: 'Access not approved by your admin', tone: 'negative' };
    case DELEGATION_STATUS.ERROR:
      return { label: 'Approval check failed', tone: 'hold' };
    default:
      return { label: 'Not checked yet', tone: 'neutral' };
  }
}

export function groupBadge(entry: Pick<AllowlistHealth, 'status'> | undefined): { label: string; tone: Tone } {
  switch (entry?.status) {
    case DRIFT_STATUS.IN_SYNC:
      return { label: 'Group in sync', tone: 'positive' };
    case DRIFT_STATUS.DRIFT:
      return { label: 'Group drift', tone: 'hold' };
    case DRIFT_STATUS.UNAVAILABLE:
      return { label: 'Group unreadable', tone: 'hold' };
    default:
      return { label: 'Group not checked yet', tone: 'neutral' };
  }
}

/**
 * "N excluded by policy" is a count of the ledger's policy skips under every policy version the tenant has had.
 * It is never joined to a version number: the current version is its own line ("Exclusion policy v2"), because
 * "10 excluded by policy v2" would claim version 2 excluded ten. The policy's skips are among the skipped rows,
 * so "skipped" here is the rest (unsupported types, size limits), and the two never add up twice.
 */
export function excludedLabel(count: number | undefined): string | null {
  return count !== undefined && count > 0 ? `${count} excluded by policy` : null;
}

export function policyVersionLabel(version: number | null | undefined): string | null {
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? `Exclusion policy v${version}` : null;
}

export function countsLabel(
  source: Pick<IngestionSourceHealth, 'itemsLedgered' | 'itemsRouted' | 'itemsSkipped' | 'itemsExcluded'>,
): string {
  const excluded = excludedLabel(source.itemsExcluded);
  const otherSkipped = Math.max(0, source.itemsSkipped - (source.itemsExcluded ?? 0));
  const parts = [`${source.itemsLedgered} read`, `${source.itemsRouted} routed`];
  if (excluded) parts.push(excluded);
  if (otherSkipped > 0) parts.push(`${otherSkipped} skipped`);
  return parts.join(', ');
}

const PASS_GROUP: Record<ReaderPassGroup, { label: string; tone: Tone }> = {
  completed: { label: 'Completed', tone: 'positive' },
  continued: { label: 'Continued', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'hold' },
  refused: { label: 'Refused', tone: 'hold' },
  failed: { label: 'Failed', tone: 'negative' },
};

/**
 * A mail check's outcome as a label and a tone, never colour alone (Workbench HANDOVER). An unfinished pass reads
 * In progress only while `live` (the source's latestPassLive: the row's own liveness rule) holds, so the badge and
 * the row never disagree; an older payload without it keeps the pass's own state.
 */
export function passBadge(pass: Pick<ReaderPassHealth, 'state' | 'group'>, live?: boolean): { label: string; tone: Tone } {
  if (pass.state !== 'ended' && typeof live === 'boolean') {
    return live ? { label: 'In progress', tone: 'neutral' } : { label: 'No end recorded', tone: 'negative' };
  }
  if (pass.state === 'in_progress') return { label: 'In progress', tone: 'neutral' };
  if (pass.state === 'no_end_recorded' || !pass.group) return { label: 'No end recorded', tone: 'negative' };
  return PASS_GROUP[pass.group] ?? { label: 'Ended', tone: 'neutral' };
}

export function passTimeLabel(pass: Pick<ReaderPassHealth, 'state' | 'startedAt' | 'endedAt'>): string {
  if (pass.state === 'ended') return `Started ${timeLabel(pass.startedAt)}, ended ${timeLabel(pass.endedAt)}`;
  return `Started ${timeLabel(pass.startedAt)}`;
}

export function passCountsLabel(pass: Pick<ReaderPassHealth, 'fetched' | 'excluded' | 'stored'>): string {
  return `${pass.fetched} fetched, ${pass.excluded} excluded by policy, ${pass.stored} stored`;
}

/** "Last 24 h: 12 mail checks, 10 completed, 1 continued, 1 failed. 340 fetched, 12 excluded by policy, 300 stored." */
export function passTotalsLabel(totals: ReaderPassTotals): string {
  if (totals.passes === 0) return 'Last 24 h: no mail checks.';
  const buckets: Array<[number, string]> = [
    [totals.completed, 'completed'],
    [totals.continued, 'continued'],
    [totals.stopped, 'stopped'],
    [totals.refused, 'refused'],
    [totals.failed, 'failed'],
    [totals.noEndRecorded, 'with no end recorded'],
  ];
  const parts = buckets.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const head = `${totals.passes} mail ${totals.passes === 1 ? 'check' : 'checks'}`;
  return `Last 24 h: ${[head, ...parts].join(', ')}. ${passCountsLabel(totals)}.`;
}

const TOUCH = 'min-h-11 focus-visible:ring-2 focus-visible:ring-accent';

function SourceRow({
  source,
  canManage,
  onChanged,
}: {
  source: IngestionSourceHealth;
  canManage: boolean;
  onChanged: () => void;
}) {
  const badge = sourceStateBadge(source);
  const reason = sourceStateReason(source);
  const windowLine = windowLabel(source);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // Why the last restart did not happen: 'refused' (a 404: the route answers it for every refusal, the once-a-day
  // cooldown among them, and names no reason, so neither does the card) or 'error' (anything else); null when it did
  // not fail.
  const [restartFailed, setRestartFailed] = React.useState<'refused' | 'error' | null>(null);
  // Restart re-reads the whole mailbox, so it asks first (as RemoveStepControl does); the ref stops a double submit.
  const [confirmingRestart, setConfirmingRestart] = React.useState(false);
  const restartingRef = React.useRef(false);
  const paused = source.status === SOURCE_STATUS.PAUSED;
  // The pause route serves live Gmail mailboxes only in this release; an archived source is closed for good.
  const manageable =
    canManage &&
    source.kind === SOURCE_KIND.MAILBOX &&
    source.provider === MAILBOX_PROVIDER.GOOGLE &&
    source.archived !== true;
  // Any halted, unarchived mailbox, whatever its state: a paused and halted source can be restarted (it stays paused).
  const restartable =
    canManage && source.kind === SOURCE_KIND.MAILBOX && source.lastError === HISTORY_WINDOW_EXCEEDED && source.archived !== true;
  // #353: the window can be set on a live Gmail mailbox until its first read starts. windowLocked is the server's own
  // refusal predicate (not checkpointState, which reads a reset source as not started), and an older payload without
  // it offers nothing.
  const windowEditable = manageable && source.windowLocked === false;
  // The open editor: the chosen date and the bounds taken when it opened (UTC, the RPC's clock); null when closed.
  const [windowEdit, setWindowEdit] = React.useState<{ draft: string; min: string; max: string; defaultSince: string } | null>(null);
  const [windowFailed, setWindowFailed] = React.useState<WindowFailure | null>(null);
  const savingWindowRef = React.useRef(false);

  function openWindowEditor() {
    const bounds = windowBounds(Date.now());
    setWindowFailed(null);
    setWindowEdit({ ...bounds, draft: source.backfillSince ?? bounds.defaultSince });
  }

  async function saveWindow() {
    if (savingWindowRef.current || !windowEdit) return;
    savingWindowRef.current = true;
    setBusy(true);
    setWindowFailed(null);
    try {
      const res = await fetch(`/api/v1/discovery/sources/${source.id}/window`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ since: windowEdit.draft }),
      });
      if (res.ok) {
        setWindowEdit(null);
        onChanged();
        return;
      }
      setWindowFailed(res.status === 409 ? 'locked' : res.status === 400 ? 'range' : res.status === 404 ? 'refused' : 'error');
    } catch {
      setWindowFailed('error');
    } finally {
      savingWindowRef.current = false;
      setBusy(false);
    }
  }

  async function change(status: 'active' | 'paused') {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/v1/discovery/sources/${source.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`source status: ${res.status}`);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setBusy(true);
    setRestartFailed(null);
    try {
      const res = await fetch(`/api/v1/discovery/sources/${source.id}/restart`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) {
        setRestartFailed('refused');
        return;
      }
      if (!res.ok) throw new Error(`source restart: ${res.status}`);
      setConfirmingRestart(false);
      onChanged();
    } catch {
      setRestartFailed('error');
    } finally {
      restartingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] py-[var(--space-4)] last:border-b-0"
      data-source-id={source.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
          <span className="break-all font-mono text-[length:var(--text-sm)] text-[var(--ink)]">{source.address}</span>
          <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {sourceLabel(source)}
            {source.archived === true ? ', archived' : paused ? ', paused' : ''}
            {source.ownerAssigned ? '' : ', no owner assigned'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </div>
      {reason ? (
        <p
          className={`text-[length:var(--text-sm)] ${badge.tone === 'negative' ? 'text-[var(--negative-deep)]' : 'text-[var(--hold-deep)]'}`}
        >
          {reason}
        </p>
      ) : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-[var(--space-4)] gap-y-[var(--space-1)] text-[length:var(--text-sm)]">
        <dt className="text-[var(--ink-tertiary)]">Last sync</dt>
        <dd className="font-mono text-[var(--ink-secondary)]">{timeLabel(source.lastSyncedAt)}</dd>
        {source.checkpointAgeSeconds !== null && source.checkpointAgeSeconds !== undefined ? (
          <>
            <dt className="text-[var(--ink-tertiary)]">Checkpoint</dt>
            <dd className="text-[var(--ink-secondary)]">{ageLabel(source.checkpointAgeSeconds)}</dd>
          </>
        ) : null}
        <dt className="text-[var(--ink-tertiary)]">Items</dt>
        <dd className="text-[var(--ink-secondary)]">{countsLabel(source)}</dd>
        {windowLine ? (
          <>
            <dt className="text-[var(--ink-tertiary)]">Window</dt>
            <dd className="font-mono text-[var(--ink-secondary)]">{windowLine}</dd>
          </>
        ) : null}
        {source.latestPass ? (
          <>
            <dt className="text-[var(--ink-tertiary)]">Last mail check</dt>
            <dd className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)] text-[var(--ink-secondary)]">
              <Badge tone={passBadge(source.latestPass, source.latestPassLive).tone}>
                {passBadge(source.latestPass, source.latestPassLive).label}
              </Badge>
              <span className="font-mono">{passTimeLabel(source.latestPass)}</span>
              <span>{passCountsLabel(source.latestPass)}</span>
            </dd>
          </>
        ) : null}
        {source.waitingFor ? (
          <>
            <dt className="text-[var(--ink-tertiary)]">Access</dt>
            <dd className="text-[var(--hold-deep)]">{waitingLabel(source.waitingFor)}</dd>
          </>
        ) : null}
        {source.lastError ? (
          <>
            <dt className="text-[var(--ink-tertiary)]">Last error</dt>
            <dd className="text-[var(--negative-deep)]">
              {lastErrorLabel(source.lastError)}, {timeLabel(source.lastErrorAt)}
            </dd>
          </>
        ) : null}
      </dl>
      {manageable || restartable ? (
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          {windowEditable && !windowEdit ? (
            <Button
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={busy}
              aria-label={`Change window for ${source.address}`}
              onClick={openWindowEditor}
            >
              Change window
            </Button>
          ) : null}
          {windowEditable && windowEdit ? (
            <div role="group" aria-label={`Set window for ${source.address}`} className="flex w-full flex-col gap-[var(--space-2)]">
              <label className="block max-w-xs">
                <span className="bank-label">Read mail from</span>
                <input
                  type="date"
                  value={windowEdit.draft}
                  min={windowEdit.min}
                  max={windowEdit.max}
                  onChange={(e) => {
                    const draft = e.target.value;
                    setWindowEdit((cur) => (cur ? { ...cur, draft } : cur));
                    setWindowFailed(null);
                  }}
                  className={FIELD_CLASS}
                />
              </label>
              {windowEdit.draft && windowEdit.draft < windowEdit.defaultSince ? (
                <p className="text-[length:var(--text-sm)] text-[var(--hold-deep)]">{WINDOW_LONG_HINT}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                <Button
                  variant="secondary"
                  size="sm"
                  className={TOUCH}
                  disabled={busy}
                  aria-label={`Cancel window change for ${source.address}`}
                  onClick={() => {
                    setWindowEdit(null);
                    setWindowFailed(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className={TOUCH}
                  disabled={busy || !windowEdit.draft}
                  aria-label={`Save window for ${source.address}`}
                  onClick={() => void saveWindow()}
                >
                  Save
                </Button>
              </div>
              {windowFailed ? (
                <span role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
                  {WINDOW_FAILURE[windowFailed]}
                </span>
              ) : null}
            </div>
          ) : null}
          {restartable && !confirmingRestart ? (
            <Button
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={busy}
              aria-label={`Restart reading ${source.address}`}
              onClick={() => setConfirmingRestart(true)}
            >
              Restart reading
            </Button>
          ) : null}
          {restartable && confirmingRestart ? (
            <div role="group" aria-label={`Confirm restart for ${source.address}`} className="flex flex-wrap items-center gap-[var(--space-2)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{restartScopeLabel(source)}</p>
              <Button
                variant="secondary"
                size="sm"
                className={TOUCH}
                disabled={busy}
                aria-label={`Cancel restart for ${source.address}`}
                onClick={() => {
                  setConfirmingRestart(false);
                  setRestartFailed(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={TOUCH}
                disabled={busy}
                aria-label={`Confirm restart reading ${source.address}`}
                onClick={() => void restart()}
              >
                Restart reading
              </Button>
            </div>
          ) : null}
          {manageable ? (
            <Button
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={busy}
              aria-label={`${paused ? 'Resume' : 'Pause'} reading ${source.address}`}
              onClick={() => void change(paused ? SOURCE_STATUS.ACTIVE : SOURCE_STATUS.PAUSED)}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
          {failed ? (
            <span role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
              The change could not be saved. Try again shortly.
            </span>
          ) : null}
          {restartFailed ? (
            <span role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
              {restartFailed === 'refused'
                ? 'Restart is not available right now.'
                : 'The restart could not be saved. Try again shortly.'}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RegistrationLine({
  registration,
  allowlist,
}: {
  registration: ReaderRegistrationHealth;
  allowlist: AllowlistHealth | undefined;
}) {
  const isGoogle = registration.provider === MAILBOX_PROVIDER.GOOGLE;
  const delegation = delegationBadge(registration.delegationStatus);
  // Microsoft has no delegation check and no group entry until its mirror has run.
  const group = isGoogle || allowlist ? groupBadge(allowlist) : null;
  const drifted = allowlist?.status === DRIFT_STATUS.DRIFT;
  return (
    <li
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] py-[var(--space-3)] first:pt-0 last:border-b-0"
      data-provider={registration.provider}
    >
      <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
        {PROVIDER_READER_LABEL[registration.provider]} mail reading is {readingStateLabel(registration.status)}
      </span>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {isGoogle ? <Badge tone={delegation.tone}>{delegation.label}</Badge> : null}
        {group ? <Badge tone={group.tone}>{group.label}</Badge> : null}
        {drifted && allowlist ? (
          <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {allowlist.missingCount} missing from the group, {allowlist.extraCount} extra in the group
          </span>
        ) : null}
      </div>
      {isGoogle && registration.delegationCheckedAt ? (
        <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          Approval checked {timeLabel(registration.delegationCheckedAt)}
        </span>
      ) : null}
    </li>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'hidden' }
  /** fetchedAt: the last successful read (client clock); refreshFailed: the latest read after it failed. */
  | { status: 'ready'; health: Health; fetchedAt: number; refreshFailed: boolean };

/** How often an open, visible card reads the health again. */
export const HEALTH_REFRESH_MS = 60_000;

/** The freshness line: when the card last read the health, and whether the latest read failed. */
export function updatedLabel(fetchedAt: number, now: number): string {
  return `Updated ${ageLabel(Math.max(0, Math.floor((now - fetchedAt) / 1000)))}`;
}

export function IngestionHealth() {
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [version, setVersion] = React.useState(0);
  // The clock the "Updated" line ages against, advanced by the timer below (render stays pure).
  const [now, setNow] = React.useState(() => Date.now());
  const inFlight = React.useRef(false);
  // Every control refetches the health: the database's state, not a client-side patch, drives the card.
  const reload = React.useCallback(() => setVersion((v) => v + 1), []);
  // The timer, the page coming back and focus refetch too, but never while the page is hidden or a read is running.
  const refresh = React.useCallback(() => {
    if (document.hidden || inFlight.current) return;
    reload();
  }, [reload]);
  const hidden = state.status === 'hidden';

  React.useEffect(() => {
    // A viewer the route answers 404 for sees nothing, so nothing is polled for them.
    if (hidden) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      refresh();
    }, HEALTH_REFRESH_MS);
    const onVisible = () => {
      if (document.hidden) return;
      setNow(Date.now());
      refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [hidden, refresh]);

  React.useEffect(() => {
    let cancelled = false;
    inFlight.current = true;
    fetch('/api/v1/discovery/health', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`discovery health: ${res.status}`);
        return ((await res.json()) as { health?: Health }).health ?? null;
      })
      .then((health) => {
        if (cancelled) return;
        setState(health ? { status: 'ready', health, fetchedAt: Date.now(), refreshFailed: false } : { status: 'hidden' });
      })
      .catch(() => {
        // A failed refetch keeps the card it had and says so; only the first load shows the error.
        if (!cancelled) setState((cur) => (cur.status === 'ready' ? { ...cur, refreshFailed: true } : { status: 'error' }));
      })
      .finally(() => {
        if (!cancelled) inFlight.current = false;
      });
    return () => {
      cancelled = true;
      inFlight.current = false;
    };
  }, [version]);

  if (state.status === 'hidden') return null;
  if (state.status === 'loading') {
    return (
      <StageStatus kind="loading">
        <p role="status">Loading ingestion health</p>
      </StageStatus>
    );
  }
  if (state.status === 'error') {
    return (
      <StageStatus kind="error">
        <p role="alert">Ingestion health could not be loaded. Try again shortly.</p>
      </StageStatus>
    );
  }

  const { registration, sources, totals } = state.health;
  const registrations = state.health.registrations ?? [];
  const allowlist = state.health.allowlist ?? [];
  const canManage = state.health.viewerCanManageSources === true;
  const excludedTotal = excludedLabel(totals.itemsExcluded);
  const policyLine = policyVersionLabel(state.health.policyVersion);
  const reader = state.health.reader ? readerLine(state.health.reader) : null;

  return (
    <section
      aria-label="Ingestion health"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">Ingestion health</h2>
        {state.health.registrations ? null : (
          <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {registration ? `Mail reading is ${readingStateLabel(registration.status)}` : 'Mail reading is not set up'}
          </span>
        )}
      </div>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {updatedLabel(state.fetchedAt, now)}.
        {state.refreshFailed ? (
          <>
            {' '}
            <span role="status" className="text-[var(--hold-deep)]">
              Could not refresh, retrying.
            </span>
          </>
        ) : null}
      </p>
      {reader ? (
        <div role="group" aria-label="Mail reading" className="flex flex-wrap items-center gap-[var(--space-2)]">
          <Badge tone={reader.tone}>{reader.label}</Badge>
          <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{reader.detail}</span>
        </div>
      ) : null}
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {totals.sources} {totals.sources === 1 ? 'source' : 'sources'}, {totals.itemsLedgered} items read,{' '}
        {totals.itemsRouted} routed, {excludedTotal ? `${excludedTotal}, ` : ''}
        {totals.itemsStored} stored, {totals.candidatesProposed} proposed{' '}
        {totals.candidatesProposed === 1 ? 'deal' : 'deals'}.
      </p>
      {totals.passesLast24h ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{passTotalsLabel(totals.passesLast24h)}</p>
      ) : null}
      {policyLine ? (
        <div>
          <Badge tone="neutral">{policyLine}</Badge>
        </div>
      ) : null}
      {state.health.registrations ? (
        <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
          {registrations.length === 0 ? (
            <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              Mail reading is not set up.
            </p>
          ) : (
            <ul aria-label="Mail reading by provider" className="flex list-none flex-col p-0">
              {registrations.map((entry) => (
                <RegistrationLine
                  key={entry.provider}
                  registration={entry}
                  allowlist={allowlist.find((row) => row.provider === entry.provider)}
                />
              ))}
            </ul>
          )}
          {state.health.reconciliation === 'not_built' ? (
            <div>
              <Badge tone="neutral">Reconciliation not built yet</Badge>
            </div>
          ) : null}
        </div>
      ) : null}
      {sources.length === 0 ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No content sources are configured.
        </p>
      ) : (
        <ul aria-label="Content sources" className="flex list-none flex-col p-0">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} canManage={canManage} onChanged={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default IngestionHealth;
