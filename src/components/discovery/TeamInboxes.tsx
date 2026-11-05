'use client';

import * as React from 'react';

import { Badge, type Tone } from '@/components/atoms/Badge';
import { Button } from '@/components/atoms/Button';
import { StageStatus } from '@/components/shell/StageStatus';
import {
  MAILBOX_REFUSAL_REASON,
  SOURCE_STATUS,
  TEAM_MAILBOX_ATTESTATION_VERSION,
  TEAM_MAILBOX_CHECK_REASON,
  TEAM_MAILBOX_CHECK_STATUS,
  TEAM_MAILBOX_WINDOW_MAX_DAYS,
  type TeamMailboxCheckReason,
} from '@/lib/constants/discovery';
import type { TeamMailbox, TeamMailboxMember, TeamMailboxPerson } from '@/lib/discovery/api';

import { FIELD_CLASS } from './CorrectionDialog';
import { timeLabel } from './IngestionHealth';

/**
 * TeamInboxes: the firm admin's card for admin-managed team inboxes (#581), on /discovery under
 * IngestionHealth. A team inbox (deals@) is a shared mailbox nobody signs in as, so the admin
 * registers it here: the address, an optional first-read window, and a ticked statement that it
 * is a firm mailbox and not a person's. The worker then checks the address in the Google
 * Directory and the row moves from Checking the address to Ready, or to a plain refusal that is
 * retried every tick, so granting the missing access turns it Ready on its own.
 *
 * Each inbox also lists the people with access and lets the admin add a colleague (a select of
 * `eligible` minus `members`) or remove one after an inline confirm (#581, phase 9).
 *
 * Reads GET /api/v1/discovery/team-mailboxes, which answers 404 to anyone but the firm's admin
 * (this renders nothing for them), and refetches every minute while visible and when the page
 * comes back, as IngestionHealth does. Connect, Remove, Add and Remove-a-person call the route
 * and then refetch: the database's state drives the card, never a client-side patch. The card
 * shows ids, an address, names, a state and a date; never mail. The compliance instrument stays the console's ComplianceRibbon.
 *
 * Look and feel is the Workbench register (cards, hairlines, solid verdict chips); the layout
 * and the copy are design to confirm (thread T7).
 */

/** How often an open, visible card reads the list again. */
export const TEAM_INBOXES_REFRESH_MS = 60_000;

const TOUCH = 'min-h-11 focus-visible:ring-2 focus-visible:ring-accent';

/**
 * The text of the statement the admin ticks. Changing its meaning means a new
 * TEAM_MAILBOX_ATTESTATION_VERSION: the version, not the string, is what is stored and audited.
 */
export const ATTESTATION_TEXT =
  "This is a mailbox the firm owns and may read, not a person's. Conductia will read it to find deals.";

/** One line per refusal reason (design to confirm, T7). A reason this table does not know still renders plainly. */
const REFUSED_COPY: Record<TeamMailboxCheckReason, string> = {
  [TEAM_MAILBOX_CHECK_REASON.GROUP]:
    'This is a Google Group. Conductia reads a user mailbox; connect the account the group delivers to.',
  [TEAM_MAILBOX_CHECK_REASON.ALIAS]: 'This is an alias. Connect the primary address.',
  [TEAM_MAILBOX_CHECK_REASON.SUSPENDED]: 'This account is suspended in your Workspace.',
  [TEAM_MAILBOX_CHECK_REASON.NO_MAILBOX]: 'This account has no mailbox yet.',
  [TEAM_MAILBOX_CHECK_REASON.NOT_FOUND]: 'Not found in your Workspace.',
  [TEAM_MAILBOX_CHECK_REASON.IDENTITY_CHANGED]: 'This address now belongs to a different account. Connect it again.',
  [TEAM_MAILBOX_CHECK_REASON.DIRECTORY_DENIED]:
    "Conductia can't check this address yet. Your Workspace admin needs to grant directory read.",
};

export function refusedCopy(reason: string | null): string {
  return (reason && (REFUSED_COPY as Record<string, string>)[reason]) || 'This address could not be verified.';
}

export const TRANSIENT_NOTE = "The last check didn't reach your Workspace. Conductia will try again shortly.";

/** The one badge a team inbox shows. A pause only changes a verified inbox; a refusal or a pending check says more. */
export function teamInboxBadge(
  inbox: Pick<TeamMailbox, 'checkStatus' | 'sourceStatus' | 'readRefusal'>,
): { label: string; tone: Tone } {
  if (inbox.checkStatus === TEAM_MAILBOX_CHECK_STATUS.REFUSED) return { label: 'Refused', tone: 'negative' };
  if (inbox.checkStatus === TEAM_MAILBOX_CHECK_STATUS.PENDING) return { label: 'Checking the address', tone: 'neutral' };
  if (inbox.sourceStatus === SOURCE_STATUS.PAUSED) return { label: 'Paused', tone: 'hold' };
  // Verified, but the live reader reads only direct members of the ingest group (audit item 3): never Ready until then.
  if (notInIngestGroup(inbox)) return { label: 'Not in the ingest group', tone: 'negative' };
  // The worker could not read the ingest group, so it read nothing (mirror_unavailable fails closed): not Ready either.
  if (groupUnreadable(inbox)) return { label: "Can't read the ingest group", tone: 'hold' };
  return { label: 'Ready', tone: 'positive' };
}

/** The worker's last read was refused because the ingest group itself could not be read. */
export function groupUnreadable(inbox: Pick<TeamMailbox, 'readRefusal'>): boolean {
  return inbox.readRefusal === MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE;
}

/** What it means (design to confirm). Nothing for the admin to change on the inbox; the next pass tries again. */
export const GROUP_UNREADABLE_NOTE =
  "Conductia couldn't read the ingest group on its last pass, so this inbox wasn't read. It tries again on the next pass. If this persists, check the directory permissions in your Workspace.";

/** The worker's last read was refused because the address is not a direct member of the ingest group. */
export function notInIngestGroup(inbox: Pick<TeamMailbox, 'readRefusal'>): boolean {
  return inbox.readRefusal === MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP;
}

/** What the admin does about it (design to confirm). The Workspace admin adds it; nobody signs in as a team inbox. */
export const NOT_IN_GROUP_NOTE =
  "Ask your Workspace admin to add this address directly to Conductia's ingest group, by its primary address. Reading starts on the next pass.";

/** What each refusal of connect says, by the code the route answers. */
const CONNECT_ERROR_COPY: Record<string, string> = {
  not_eligible: 'Only the firm admin can connect a team inbox.',
  person_address: "This is a person's address. They connect it themselves from their profile.",
  provider_unresolved: 'Conductia cannot tell which mail provider serves this address. Check that its domain is registered to your firm.',
  provider_unsupported: 'Team inboxes on Microsoft 365 are not available yet.',
  out_of_range: `Choose a start date within the last ${TEAM_MAILBOX_WINDOW_MAX_DAYS} days, no later than today.`,
  invalid_address: 'Enter a full email address, such as deals@yourfirm.com.',
  attestation_required: 'The confirmation text has changed. Reload the page and confirm again.',
};
const CONNECT_ERROR_DEFAULT = 'The team inbox could not be connected. Try again shortly.';

export function connectErrorCopy(status: number, code: string | undefined): string {
  const named = code && Object.prototype.hasOwnProperty.call(CONNECT_ERROR_COPY, code) ? CONNECT_ERROR_COPY[code] : undefined;
  if (named) return named;
  if (status === 400) return 'Check the address and the start date, then try again.';
  return CONNECT_ERROR_DEFAULT;
}

/** `YYYY-MM-DD` of a UTC day, `daysAgo` before `now`. The route's window is counted in UTC days, so the bounds are too. */
export function utcDay(now: number, daysAgo = 0): string {
  return new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : undefined;
}

function ConnectTeamInbox({ onConnected }: { onConnected: (alreadyConnected: boolean) => void }) {
  const [address, setAddress] = React.useState('');
  const [since, setSince] = React.useState('');
  const [attested, setAttested] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submittingRef = React.useRef(false);
  const addressId = React.useId();
  const sinceId = React.useId();
  const [now] = React.useState(() => Date.now());

  const canSubmit = address.trim() !== '' && attested && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/discovery/team-mailboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          address: address.trim(),
          attestationVersion: TEAM_MAILBOX_ATTESTATION_VERSION,
          ...(since ? { backfillSince: since } : {}),
        }),
      });
      if (!res.ok) {
        setError(connectErrorCopy(res.status, await errorCode(res)));
        return;
      }
      setAddress('');
      setSince('');
      setAttested(false);
      // The connect reply is the registration alone; the list read carries the state the card shows.
      onConnected(res.status === 200);
    } catch {
      setError(CONNECT_ERROR_DEFAULT);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label="Connect a team inbox"
      noValidate
      className="flex flex-col gap-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-4)]"
    >
      <div className="grid grid-cols-1 gap-[var(--space-3)] sm:grid-cols-[1fr_auto]">
        <div>
          <label htmlFor={addressId} className="bank-label">
            Team inbox address
          </label>
          <input
            id={addressId}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={320}
            placeholder="deals@yourfirm.com"
            className={`${FIELD_CLASS} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={sinceId} className="bank-label">
            First read from (optional)
          </label>
          <input
            id={sinceId}
            type="date"
            value={since}
            min={utcDay(now, TEAM_MAILBOX_WINDOW_MAX_DAYS)}
            max={utcDay(now)}
            onChange={(e) => setSince(e.target.value)}
            className={FIELD_CLASS}
          />
        </div>
      </div>
      <label className="flex items-start gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        <input
          type="checkbox"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />
        <span>{ATTESTATION_TEXT}</span>
      </label>
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" size="sm" className={TOUCH} disabled={!canSubmit}>
          Connect team inbox
        </Button>
      </div>
    </form>
  );
}

/** The name a person is listed by; the address stands in for a missing name. */
function personLabel(person: Pick<TeamMailboxPerson, 'name' | 'email'>): string {
  return person.name.trim() !== '' ? person.name : person.email;
}

/** What adding a person says when the route refuses, by the status it answers. 404 is not an error here: the next read says why. */
export const ADD_MEMBER_ERROR_COPY = {
  not_eligible_member:
    'This person cannot be added. Only active colleagues seated in the firm who are not firm admins can read a team inbox.',
  failed: 'The person could not be added. Try again shortly.',
} as const;

export const REMOVE_MEMBER_ERROR_COPY = 'The person could not be removed. Try again shortly.';

/**
 * One person with access, with an inline confirm before Remove (the rail's RemoveStepControl pattern).
 * Removing closes the membership: the person's own mail, deals and deal memberships are not touched.
 */
function MemberRow({
  inbox,
  member,
  onChanged,
}: {
  inbox: Pick<TeamMailbox, 'id' | 'address'>;
  member: TeamMailboxMember;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const removingRef = React.useRef(false);
  const who = personLabel(member);

  async function remove() {
    if (removingRef.current) return;
    removingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/discovery/team-mailboxes/${encodeURIComponent(inbox.id)}/members/${encodeURIComponent(member.userId)}`,
        { method: 'DELETE', headers: { Accept: 'application/json' } },
      );
      // 404: the inbox is gone or the viewer is no longer its admin. Either way the next read says which.
      if (!res.ok && res.status !== 404) throw new Error(`remove team inbox member: ${res.status}`);
      setConfirming(false);
      onChanged();
    } catch {
      setError(REMOVE_MEMBER_ERROR_COPY);
    } finally {
      removingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-[var(--space-2)] py-[var(--space-2)]" data-team-member-id={member.userId}>
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <div className="flex min-w-0 flex-col">
          <span className="text-[length:var(--text-sm)] text-[var(--ink)]">{who}</span>
          <span className="break-all font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{member.email}</span>
        </div>
        {!confirming ? (
          <Button
            variant="secondary"
            size="sm"
            className={TOUCH}
            disabled={busy}
            aria-label={`Remove ${who} from ${inbox.address}`}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div
          role="group"
          aria-label={`Confirm removal of ${who} from ${inbox.address}`}
          className="flex flex-wrap items-center gap-[var(--space-2)]"
        >
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {who} will stop seeing what this inbox finds. Their own mail and deals are not affected.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className={TOUCH}
            disabled={busy}
            aria-label={`Cancel removal of ${who} from ${inbox.address}`}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            className={TOUCH}
            disabled={busy}
            aria-label={`Confirm removal of ${who} from ${inbox.address}`}
            onClick={() => void remove()}
          >
            Remove
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** A select of the colleagues who could be added, and Add. `candidates` is already `eligible` minus `members`. */
function AddPerson({
  inbox,
  candidates,
  hasEligible,
  onChanged,
}: {
  inbox: Pick<TeamMailbox, 'id' | 'address'>;
  candidates: TeamMailboxPerson[];
  /** Whether anyone at all is eligible, members included: it tells "everyone has access" from "no one can be added". */
  hasEligible: boolean;
  onChanged: () => void;
}) {
  const [chosen, setChosen] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const addingRef = React.useRef(false);
  const selectId = React.useId();
  // A choice that has since been added elsewhere or has lost eligibility is no choice: the select falls back to empty.
  const value = candidates.some((c) => c.userId === chosen) ? chosen : '';

  if (candidates.length === 0) {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {hasEligible
          ? 'Everyone who can be added already has access.'
          : 'No colleagues can be added yet. A person must be an active colleague seated in the firm and not a firm admin.'}
      </p>
    );
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (value === '' || addingRef.current) return;
    addingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/discovery/team-mailboxes/${encodeURIComponent(inbox.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ userId: value }),
      });
      if (res.status === 422) {
        const code = await errorCode(res);
        setError(code === 'not_eligible_member' ? ADD_MEMBER_ERROR_COPY.not_eligible_member : ADD_MEMBER_ERROR_COPY.failed);
        // The person's eligibility changed since the card loaded: the next read drops them from the choices.
        onChanged();
        return;
      }
      // 404: the inbox is gone or the viewer is no longer its admin; the next read says which.
      if (!res.ok && res.status !== 404) {
        setError(ADD_MEMBER_ERROR_COPY.failed);
        return;
      }
      setChosen('');
      onChanged();
    } catch {
      setError(ADD_MEMBER_ERROR_COPY.failed);
    } finally {
      addingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void add(e)}
      aria-label={`Add a person to ${inbox.address}`}
      className="flex flex-col gap-[var(--space-2)]"
    >
      <div className="flex flex-wrap items-end gap-[var(--space-3)]">
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor={selectId} className="bank-label">
            Add a person
          </label>
          <select id={selectId} value={value} onChange={(e) => setChosen(e.target.value)} className={FIELD_CLASS}>
            <option value="">Choose a colleague</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name.trim() !== '' ? `${c.name} (${c.email})` : c.email}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary" size="sm" className={TOUCH} disabled={value === '' || busy}>
          Add
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Who can read one team inbox: the members the admin has added, and a select of everyone else who could be.
 * `eligible` includes the current members, so the choices are `eligible` minus `members`. A member promoted to
 * firm admin since stays listed, so the admin can still remove them.
 */
function PeopleWithAccess({ inbox, onChanged }: { inbox: TeamMailbox; onChanged: () => void }) {
  const memberIds = new Set(inbox.members.map((m) => m.userId));
  const candidates = inbox.eligible.filter((p) => !memberIds.has(p.userId));
  return (
    <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
      <h3 className="bank-label">People with access</h3>
      {inbox.members.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No one has access yet. People you add see the candidates this inbox finds.
        </p>
      ) : (
        <ul aria-label="People with access" className="flex list-none flex-col p-0">
          {inbox.members.map((m) => (
            <MemberRow key={m.userId} inbox={inbox} member={m} onChanged={onChanged} />
          ))}
        </ul>
      )}
      <AddPerson inbox={inbox} candidates={candidates} hasEligible={inbox.eligible.length > 0} onChanged={onChanged} />
    </div>
  );
}

function TeamInboxRow({ inbox, onChanged }: { inbox: TeamMailbox; onChanged: () => void }) {
  const badge = teamInboxBadge(inbox);
  const refused = inbox.checkStatus === TEAM_MAILBOX_CHECK_STATUS.REFUSED;
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const removingRef = React.useRef(false);

  async function remove() {
    if (removingRef.current) return;
    removingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/discovery/team-mailboxes/${encodeURIComponent(inbox.id)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 409) {
        // The inbox read mail since the card last loaded: Remove is gone from the next read.
        setConfirming(false);
        setError('This inbox holds mail now, so it can no longer be removed.');
        onChanged();
        return;
      }
      if (res.status === 404) {
        // Already gone, or the viewer is no longer the admin: the next read says which.
        onChanged();
        return;
      }
      if (!res.ok) throw new Error(`remove team inbox: ${res.status}`);
      setConfirming(false);
      onChanged();
    } catch {
      setError('The inbox could not be removed. Try again shortly.');
    } finally {
      removingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] py-[var(--space-4)] last:border-b-0"
      data-team-mailbox-id={inbox.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
          <span className="break-all font-mono text-[length:var(--text-sm)] text-[var(--ink)]">{inbox.address}</span>
          <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Gmail, connected {timeLabel(inbox.connectedAt)}
            {inbox.backfillSince ? `, first read from ${inbox.backfillSince}` : ''}
          </span>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {refused ? (
        <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">{refusedCopy(inbox.checkReason)}</p>
      ) : null}
      {!refused && inbox.lastCheckError ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--hold-deep)]">
          {TRANSIENT_NOTE}
        </p>
      ) : null}
      {!refused && inbox.sourceStatus !== SOURCE_STATUS.PAUSED && notInIngestGroup(inbox) ? (
        <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">{NOT_IN_GROUP_NOTE}</p>
      ) : null}
      {!refused && inbox.sourceStatus !== SOURCE_STATUS.PAUSED && groupUnreadable(inbox) ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--hold-deep)]">{GROUP_UNREADABLE_NOTE}</p>
      ) : null}
      <PeopleWithAccess inbox={inbox} onChanged={onChanged} />
      {inbox.removable ? (
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          {!confirming ? (
            <Button
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={busy}
              aria-label={`Remove ${inbox.address}`}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Remove
            </Button>
          ) : (
            <div role="group" aria-label={`Confirm removal of ${inbox.address}`} className="flex flex-wrap items-center gap-[var(--space-2)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Nothing has been read from this inbox. Removing it closes the connection.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className={TOUCH}
                disabled={busy}
                aria-label={`Cancel removal of ${inbox.address}`}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={TOUCH}
                disabled={busy}
                aria-label={`Confirm removal of ${inbox.address}`}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </li>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'hidden' }
  /** refreshFailed: the latest read after the one shown failed. */
  | { status: 'ready'; inboxes: TeamMailbox[]; refreshFailed: boolean };

export function TeamInboxes() {
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [version, setVersion] = React.useState(0);
  const [note, setNote] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
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
    const timer = window.setInterval(refresh, TEAM_INBOXES_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
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
    fetch('/api/v1/discovery/team-mailboxes', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`team inboxes: ${res.status}`);
        const body = (await res.json()) as { teamMailboxes?: TeamMailbox[] };
        return Array.isArray(body.teamMailboxes) ? body.teamMailboxes : [];
      })
      .then((inboxes) => {
        if (cancelled) return;
        setState(inboxes ? { status: 'ready', inboxes, refreshFailed: false } : { status: 'hidden' });
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
        <p role="status">Loading team inboxes</p>
      </StageStatus>
    );
  }
  if (state.status === 'error') {
    return (
      <StageStatus kind="error">
        <p role="alert">Team inboxes could not be loaded. Try again shortly.</p>
      </StageStatus>
    );
  }

  return (
    <section
      aria-labelledby="team-inboxes-heading"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]"
    >
      <div className="flex flex-col gap-[var(--space-1)]">
        <h2 id="team-inboxes-heading" className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          Team inboxes
        </h2>
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          A shared mailbox such as deals@. Conductia checks the address in your Google Workspace before it reads anything.
        </p>
        {state.refreshFailed ? (
          <p role="status" className="text-[length:var(--text-sm)] text-[var(--hold-deep)]">
            Could not refresh, retrying.
          </p>
        ) : null}
      </div>
      {state.inboxes.length === 0 ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No team inboxes are connected.
        </p>
      ) : (
        <ul aria-label="Team inboxes" className="flex list-none flex-col p-0">
          {state.inboxes.map((inbox) => (
            <TeamInboxRow key={inbox.id} inbox={inbox} onChanged={reload} />
          ))}
        </ul>
      )}
      {note ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {note}
        </p>
      ) : null}
      <ConnectTeamInbox
        onConnected={(alreadyConnected) => {
          setNote(alreadyConnected ? 'That address is already connected.' : null);
          reload();
        }}
      />
    </section>
  );
}

export default TeamInboxes;
