'use client';

import * as React from 'react';
import Link from 'next/link';

import { Badge, Button, Card } from '@/components/atoms';
import { DEAL_ROLE } from '@/lib/constants/roles';
import { MAILBOX_READING_REASON as REASON, type MailboxReadingReason } from '@/lib/constants/discovery';
import { formatDate, formatDateTime, formatTime } from '@/lib/format/date';

type Status = {
  eligible: boolean;
  reason?: 'no_invite' | 'domain' | 'not_on_a_deal' | null;
  /** An open consent on the caller's current seated invite, the one the guard reads. */
  consented: boolean;
  /** An open consent exists and none is on the current seated invite (an older invite, or no seat). */
  staleConsent?: boolean;
  since?: string | null;
  address?: string;
  /**
   * Database eligibility: the guard allows the address (a source exists, is the caller's and active, and the consent
   * and seat stand). It does not say a pass is running, so the card never promises a read.
   */
  reading?: boolean;
  /** The guard's own reason, when `reading` is false and the member has consented; see mailbox_reading_reason. */
  readingReason?: MailboxReadingReason | null;
};

// /api/v1/discovery/google-mailbox as the route returns it (discovery_google_mailbox_status). Declared here, like
// Status above: this file imports nothing from src/lib/discovery. Only a member whose opt-in created a Google source
// is `connected`; opting in is the one button below, and there is no second connect step.
type GoogleStatus =
  | { connected: false }
  | {
      connected: true;
      address?: string;
      /** The bank-owned ingest group the member must be in, and its Workspace domain. */
      group?: string | null;
      domain?: string | null;
      /** A firm admin paused the source. */
      paused?: boolean;
      /** The guard last refused the address because the member is not in the ingest group. */
      waitingForGroup?: boolean;
      /**
       * First-sync status of the member's own source (#341): its ingestion health state, the end of the first full
       * read, the last successful sync, and whether Google refused the firm's delegation. No mail is ever in it.
       */
      state?: string | null;
      backfillCompletedAt?: string | null;
      lastSyncedAt?: string | null;
      delegationRefused?: boolean;
    };

const COPY_CONNECTED_LINE = "You're connected. Conductia reads your mailbox each time it checks for new deals.";

const COPY = {
  title: 'Deal discovery',
  // The step is someone on a deal adding the member on its Team page; the card links straight there (TeamLink).
  notEligible:
    "Conductia reads a mailbox only for people invited to one of your firm's deals. Someone on the deal adds you from its Team page.",
  notEligibleDomain: (domain: string) =>
    `Conductia reads only mailboxes on your firm's mail domains, and ${domain} is not one of them. Ask your firm admin to add ${domain}.`,
  // One click is open to the MD and the deal team of a deal (A2): a member on no deal is told what to do, and Connect is withheld.
  notOnADeal:
    "Conductia connects a mailbox only for members who are the MD or on the deal team of a deal. The deal's MD adds you on its Team page, then you connect your mailbox here.",
  // An open consent that the guard does not read under the current invitation (C12).
  staleOlder:
    'Your consent covers an earlier invitation, so your mailbox is not read under your current one. Connect again to read it, or stop reading to end the earlier consent.',
  staleNoSeat: (address: string) =>
    `Your consent to read ${address} is still on record, and reading is paused because no current invitation covers it. Stop reading to end that consent.`,
  offBody: (address: string) =>
    `Conductia can read ${address} to find deals your firm may be working on. Colleagues see what it finds only on deals they can already see, and message text stays visible to you alone.`,
  // #461: stopping deletes what Conductia stored from the mailbox. A message a colleague's connected mailbox also
  // holds is theirs too, so it stays with their mailbox.
  offDisclosure:
    "If you stop later, reading ends and Conductia deletes the mail it stored from your mailbox, with what it found in that mail. Mail that a colleague's connected mailbox also holds stays with theirs.",
  checkbox: 'I agree that Conductia reads my mailbox for deal discovery.',
  connect: 'Connect my mailbox',
  connected: 'Connected',
  // The reading guard says yes, but the health check is late: never the green Connected.
  connectedDelayed: 'Connected, check delayed',
  // A statement of eligibility, never a promise of a pass.
  onBody: (address: string, date: string) =>
    `${COPY_CONNECTED_LINE} The mailbox is ${address}.${date ? ` Connected since ${date}.` : ''}`,
  stop: 'Stop reading my mailbox',
  confirm:
    "Reading stops, and Conductia deletes the mail it stored from your mailbox, with what it found in that mail. Mail that a colleague's connected mailbox also holds stays with theirs.",
  confirmStop: 'Stop reading',
  cancel: 'Cancel',
  afterConnect: COPY_CONNECTED_LINE,
  // Consent is recorded, but the guard will not read the mailbox until the firm admin acts (see readingStep).
  afterConnectPending: 'Your consent is recorded. Conductia does not read your mailbox yet.',
  notReading: 'Not reading yet',
  pendingBody: (address: string, date: string) =>
    `Consent is on record${date ? ` since ${date}` : ''}, and Conductia does not read ${address} yet.`,
  afterWithdraw: 'Your mailbox is no longer read.',
  error: 'The change did not save. Try again.',
} as const;

// The Gmail instruction, shown to a member whose opt-in created a Google source. Statements, no questions.
const GMAIL = {
  title: 'Gmail',
  waiting: 'Waiting to be added to the group',
  paused: 'Paused by your firm',
  // The group refused the address on the last pass: the one step is the admin adding the member, true whether the group is invite-only or open.
  join: (group: string) => `Ask your Google admin to add you to ${group}. Reading starts on the next check after you are added.`,
  // No refusal on record: the requirement stays in sight, since the card cannot see group membership.
  member: (group: string) => `Conductia reads your mailbox only while you are in your firm's Google group ${group}.`,
  openGroup: (group: string) => `Open ${group}`,
  // First-sync status (#341). Delegation is the firm's Google admin step, so the member is told whom to ask.
  refused: 'Access not granted',
  refusedLine: "Your firm's Google admin has not granted access",
  refusedStep:
    "Ask your firm's Google Workspace admin to give Conductia read access to Gmail (domain-wide delegation). Reading starts on the next check after access is granted.",
  starting: 'First sync starting',
  running: 'First sync running',
  // A pass is running after the first full read: it may be catching up, so "Up to date" waits for it to finish.
  checking: (checked: string) => (checked ? `Checking for new mail. Last synced ${checked}.` : 'Checking for new mail.'),
  upToDate: (checked: string) => (checked ? `Up to date, last checked ${checked}` : 'Up to date'),
  arrives: 'New mail arrives within minutes',
  stale: (checked: string) =>
    `Conductia has not checked your mailbox recently${checked ? `, last checked ${checked}` : ''}. Ask your firm admin to check that reading is running.`,
  // The reader is off for the whole firm (a switch or the registration), or stopped for this mailbox: the firm admin's step.
  switchedOff: 'Reading is switched off for your firm',
  switchedOffStep: 'Your consent stands. Reading starts when your firm admin switches it on.',
  halted: 'Reading stopped',
  haltedStep: 'Gmail no longer holds the history Conductia needs to continue. Ask your firm admin to restart reading for your mailbox.',
  failing: 'The last sync did not finish',
  failingStep: 'Conductia tries again on the next check. If it keeps failing, ask your firm admin to check reading.',
} as const;

// Health states in which the reader does not run for this mailbox whatever Google says. A switch-off beats any
// failure, as in discovery_source_health_state, so a lingering delegation error is not the step to name.
const READER_OFF: ReadonlySet<string> = new Set(['switched_off', 'halted']);

/** Google refused the firm's delegation, unless the reader is off for this mailbox anyway. */
function delegationRefused(gmail: Extract<GoogleStatus, { connected: true }>): boolean {
  return gmail.state === 'delegation_broken' || (gmail.delegationRefused === true && !READER_OFF.has(gmail.state ?? ''));
}

/** The first-sync lines for a Google source, or null when the badge already says it (paused, waiting) or the state is unknown. */
function syncLines(gmail: Extract<GoogleStatus, { connected: true }>): string[] | null {
  if (gmail.state === 'switched_off') return [GMAIL.switchedOff, GMAIL.switchedOffStep];
  if (gmail.state === 'halted') return [GMAIL.halted, GMAIL.haltedStep];
  if (delegationRefused(gmail)) return [GMAIL.refusedLine, GMAIL.refusedStep];
  const checked = formatChecked(gmail.lastSyncedAt);
  switch (gmail.state) {
    case 'not_started':
      return [GMAIL.starting];
    // A live pass after the first full read checks for new mail; "Up to date" waits until the pass finishes.
    case 'reading':
      return gmail.backfillCompletedAt ? [GMAIL.checking(checked)] : [GMAIL.running];
    case 'up_to_date':
      return [GMAIL.upToDate(checked), GMAIL.arrives];
    case 'stale':
      return [GMAIL.stale(checked)];
    case 'failing':
      return [GMAIL.failing, GMAIL.failingStep];
    default:
      return null;
  }
}

const TOUCH = 'min-h-11 focus-visible:ring-2 focus-visible:ring-accent';
const TEXT_LINK = 'inline-flex min-h-11 items-center rounded-[var(--radius-control)] text-(length:--text-sm) font-medium text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * What stands between a recorded consent and a read, and the step that ends it. The reasons are the guard's own
 * (mailbox_reading_reason): the source is owned by someone else or by no one, is paused, is missing, or is on a
 * provider that cannot read the address; or the member's seat, domain or deal role is the gap.
 */
function readingStep(reason: MailboxReadingReason | null | undefined, address: string, domain: string): string {
  switch (reason) {
    case REASON.OWNER_MISMATCH:
      return `${address} is set up for reading under someone else at your firm. Ask your firm admin to assign it to you.`;
    case REASON.SOURCE_PAUSED:
      return `Your firm admin paused reading for ${address}. Ask them to resume it.`;
    case REASON.NO_SOURCE:
      return `${address} is not set up for reading yet. Ask your firm admin to set it up.`;
    case REASON.REGISTRATION_INACTIVE:
      return `Reading for ${address} is switched off at your firm. Ask your firm admin to switch it on.`;
    case REASON.DOMAIN:
      return COPY.notEligibleDomain(domain);
    case REASON.NOT_ON_A_DEAL:
      return COPY.notOnADeal;
    default:
      return `Ask your firm admin to check reading for ${address}.`;
  }
}

/** Why the member cannot connect: the mail domain, no deal role, or no invitation. */
function notEligibleText(reason: Status['reason'], domain: string): string {
  if (reason === 'domain') return COPY.notEligibleDomain(domain);
  if (reason === 'not_on_a_deal') return COPY.notOnADeal;
  return COPY.notEligible;
}

type TeamLinkTarget = { href: string; label: string };

/** Where a member with no seat goes when there is no deal to name: their deal list. */
const DEAL_LIST_LINK: TeamLinkTarget = { href: '/projects', label: 'Open your deals' };

/**
 * The Team page where the member gets added: a deal they MD first, else the first deal they can see, else the deal
 * list. Read from /api/v1/deals (the list the Conductor Center uses); asked for only while `active`.
 */
function useTeamLink(active: boolean): TeamLinkTarget | null {
  const [target, setTarget] = React.useState<TeamLinkTarget | null>(null);
  React.useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      let next = DEAL_LIST_LINK;
      try {
        const res = await fetch('/api/v1/deals');
        if (res.ok) {
          const body = (await res.json()) as {
            deals?: Array<{ id: string; code?: string | null; codename?: string | null; dealRole?: string | null }>;
          } | null;
          const deals = body?.deals ?? [];
          const deal = deals.find((d) => d.dealRole === DEAL_ROLE.MD) ?? deals[0];
          if (deal) {
            next = {
              // The deal code is the route segment the shell names deals by; the id is the fallback.
              href: `/projects/${encodeURIComponent(deal.code || deal.id)}/team`,
              label: deal.codename ? `Open the Team page for ${deal.codename}` : "Open the deal's Team page",
            };
          }
        }
      } catch {
        // The deal list is always a place to start from.
      }
      if (live) setTarget(next);
    })();
    return () => {
      live = false;
    };
  }, [active]);
  return active ? target : null;
}

async function isNotEligible(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: string } | null;
    return body?.error === 'not_eligible';
  } catch {
    return false;
  }
}

/** The Google Groups page of an ingest group, or null when the group is not an address. */
function groupUrl(group: string, domain?: string | null): string | null {
  const [local, groupDomain] = group.split('@');
  const host = domain || groupDomain;
  if (!local || !host) return null;
  return `https://groups.google.com/a/${encodeURIComponent(host)}/g/${encodeURIComponent(local)}`;
}

/** A short time for today, else the date with the time: "3:04 PM", or "Oct 15, 2026, 3:04 PM". */
function formatChecked(at?: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === new Date().toDateString()) return formatTime(date);
  return formatDateTime(date);
}

function formatSince(since?: string | null): string {
  return since ? formatDate(since) : '';
}

/**
 * `canConnect` is the `deal_discovery` flag. Off, the card only ever offers
 * withdrawal to a member who already consented; it shows nothing else.
 */
export function MailboxConsentCard({ canConnect }: { canConnect: boolean }) {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [agreed, setAgreed] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [withdrew, setWithdrew] = React.useState(false);
  const [google, setGoogle] = React.useState<GoogleStatus | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/v1/discovery/mailbox-consent');
        if (!live) return;
        if (!res.ok) return setNotice(COPY.error);
        setStatus((await res.json()) as Status);
      } catch {
        if (live) setNotice(COPY.error);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // The Gmail instruction follows the opt-in: it is asked for only once the member is consented, and only while
  // the flag lets them connect. Any failure, or a member with no Google source, shows no Gmail section.
  const optedIn = status?.consented === true;
  React.useEffect(() => {
    if (!canConnect || !optedIn) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/v1/discovery/google-mailbox');
        if (!live || !res.ok) return;
        setGoogle((await res.json()) as GoogleStatus);
      } catch {
        // No Gmail section is the safe reading of a status that cannot be loaded.
      }
    })();
    return () => {
      live = false;
    };
  }, [canConnect, optedIn]);

  async function refresh() {
    const res = await fetch('/api/v1/discovery/mailbox-consent');
    if (!res.ok) throw new Error(String(res.status));
    const next = (await res.json()) as Status;
    setStatus(next);
    setAgreed(false);
    // A refused connect that the fresh status still calls eligible has no
    // reason to show: say the change did not save.
    if (next.eligible) setNotice(COPY.error);
  }

  async function change(method: 'POST' | 'DELETE') {
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch('/api/v1/discovery/mailbox-consent', { method });
      if (!res.ok) {
        // The status was stale: the invite or the domain changed since the card
        // loaded. Read it again so the card shows why (audit round 1, item 23).
        if (method === 'POST' && res.status === 403 && (await isNotEligible(res))) {
          await refresh();
          return;
        }
        throw new Error(String(res.status));
      }
      const next = (await res.json()) as Status;
      setStatus(next);
      // A fresh opt-in or a withdrawal makes the Gmail status stale: the effect above asks again once consented.
      setGoogle(null);
      // "Reading starts" is said only when the status says the guard will read the mailbox.
      setNotice(method === 'POST' ? (next.reading === true ? COPY.afterConnect : COPY.afterConnectPending) : COPY.afterWithdraw);
      setWithdrew(method === 'DELETE');
      setAgreed(false);
      setConfirming(false);
    } catch {
      setNotice(COPY.error);
    } finally {
      setBusy(false);
    }
  }

  // A consent the guard does not read: on an older invitation, or held while no seat covers it (C12).
  // It is not "Connected", but the member must always be able to see and end it.
  const consented = status?.consented === true;
  const stale = !consented && status?.staleConsent === true;
  // A member who needs a seat is sent straight to a Team page, not told to find an admin.
  const teamLink = useTeamLink(canConnect && status !== null && !status.eligible && status.reason !== 'domain');

  // Flag off: only a member who holds a consent sees the card, and only to stop. Once
  // they stop there is nothing to connect, so it falls quiet after its notice.
  if (!canConnect && !consented && !stale && !withdrew) return null;

  const address = status?.address ?? 'your mailbox';
  const domain = status?.address?.split('@')[1] || 'your mail domain';

  // Whatever `eligible` says: a member can always withdraw.
  const stopControl = (
    <>
      <div>
        <Button variant="secondary" className={TOUCH} disabled={busy} onClick={() => setConfirming(true)}>
          {COPY.stop}
        </Button>
      </div>
      {confirming ? (
        <div
          role="group"
          aria-label={COPY.stop}
          className="flex flex-wrap items-center gap-(--space-3) rounded-card border border-[var(--stroke)] bg-surface p-(--space-3)"
        >
          <p className="text-(length:--text-sm) text-ink">{COPY.confirm}</p>
          <Button className={TOUCH} disabled={busy} onClick={() => void change('DELETE')}>
            {COPY.confirmStop}
          </Button>
          <Button variant="secondary" className={TOUCH} onClick={() => setConfirming(false)}>
            {COPY.cancel}
          </Button>
        </div>
      ) : null}
    </>
  );

  const notEligibleCopy = (
    <div className="flex flex-col gap-(--space-2)">
      <p className="text-(length:--text-sm) text-ink-secondary">
        {notEligibleText(status?.reason, domain)}
      </p>
      {teamLink ? (
        <div>
          <Link
            href={teamLink.href}
            className={TEXT_LINK}
          >
            {teamLink.label}
          </Link>
        </div>
      ) : null}
    </div>
  );

  const connectForm = (
    <>
      <p className="text-(length:--text-sm) text-ink-secondary">{COPY.offBody(address)}</p>
      <p className="text-(length:--text-sm) text-ink-secondary">{COPY.offDisclosure}</p>
      <label className="flex min-h-11 items-start gap-(--space-2) text-(length:--text-sm) text-ink">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        {COPY.checkbox}
      </label>
      <div>
        <Button variant="primary" className={TOUCH} disabled={!agreed || busy} onClick={() => void change('POST')}>
          {COPY.connect}
        </Button>
      </div>
    </>
  );

  let body: React.ReactNode = null;
  if (consented) {
    // A Google member is only read while in the bank's ingest group. The database verdict (`reading`) cannot see
    // that, so the card never says "connected" while the guard last refused the address for it.
    const gmail = google?.connected === true ? google : null;   // the effect only fills it while opted in
    const paused = gmail?.paused === true;
    const waitingForGroup = gmail?.waitingForGroup === true && !paused;
    // Google refused the firm's delegation: the address is connected in name only, so the card never says Connected.
    const refused = !paused && gmail !== null && delegationRefused(gmail);
    // The reader is off for the firm or stopped for this mailbox: never Connected, and the sync line names the step.
    const readerOff = !paused && READER_OFF.has(gmail?.state ?? '');
    const reading = status?.reading === true && !waitingForGroup && !paused && !refused && !readerOff;
    const checkDelayed = reading && gmail?.state === 'stale';
    const sync = gmail && !paused && !waitingForGroup ? syncLines(gmail) : null;
    const group = gmail?.group ?? null;
    const groupLink = group ? groupUrl(group, gmail?.domain) : null;
    body = (
      <div className="flex flex-col gap-(--space-3)">
        <div>
          <Badge tone={reading && !checkDelayed ? 'positive' : 'hold'}>
            {paused
              ? GMAIL.paused
              : waitingForGroup
                ? GMAIL.waiting
                : refused
                  ? GMAIL.refused
                  : checkDelayed
                    ? COPY.connectedDelayed
                    : reading
                      ? COPY.connected
                      : COPY.notReading}
          </Badge>
        </div>
        {gmail && !paused ? (
          <div role="group" aria-label="Gmail sync" className="flex flex-col gap-(--space-1) empty:hidden">
            {sync?.map((line, index) => (
              <p
                key={line}
                className={index === 0 ? 'text-(length:--text-sm) font-medium text-ink' : 'text-(length:--text-sm) text-ink-secondary'}
              >
                {line}
              </p>
            ))}
          </div>
        ) : null}
        {reading ? (
          <p className="text-(length:--text-sm) text-ink-secondary">{COPY.onBody(address, formatSince(status?.since))}</p>
        ) : (
          <>
            <p className="text-(length:--text-sm) text-ink-secondary">{COPY.pendingBody(address, formatSince(status?.since))}</p>
            {waitingForGroup || refused || readerOff ? null : (
              <p className="text-(length:--text-sm) text-ink-secondary">{readingStep(status?.readingReason, address, domain)}</p>
            )}
          </>
        )}
        {gmail && group && !paused ? (
          <section
            aria-labelledby="gmail-instruction-title"
            className="flex flex-col gap-(--space-2) border-t border-[var(--stroke)] pt-(--space-3)"
          >
            <h4 id="gmail-instruction-title" className="text-(length:--text-sm) font-semibold text-ink">
              {GMAIL.title}
            </h4>
            <p className="text-(length:--text-sm) text-ink">{waitingForGroup ? GMAIL.join(group) : GMAIL.member(group)}</p>
            {groupLink ? (
              <div>
                <a
                  href={groupLink}
                  target="_blank"
                  rel="noreferrer"
                  className={TEXT_LINK}
                >
                  {GMAIL.openGroup(group)}
                </a>
              </div>
            ) : null}
          </section>
        ) : null}
        {stopControl}
      </div>
    );
  } else if (stale && status) {
    const noSeat = status.reason === 'no_invite';
    body = (
      <div className="flex flex-col gap-(--space-3)">
        <p className="text-(length:--text-sm) text-ink-secondary">{noSeat ? COPY.staleNoSeat(address) : COPY.staleOlder}</p>
        {stopControl}
        {!canConnect || noSeat ? null : status.eligible ? connectForm : notEligibleCopy}
      </div>
    );
  } else if (!canConnect) {
    body = null;
  } else if (status && !status.eligible) {
    body = notEligibleCopy;
  } else if (status) {
    body = <div className="flex flex-col gap-(--space-3)">{connectForm}</div>;
  }

  return (
    // The picker banner's CONNECT_GMAIL_HREF lands here.
    <Card id="deal-discovery" className="scroll-mt-(--space-6)">
      <h3 className="text-(length:--text-md) font-semibold text-ink">{COPY.title}</h3>
      <div className="mt-(--space-3)">{body}</div>
      <p role="status" aria-live="polite" className="mt-(--space-3) text-(length:--text-sm) text-ink-secondary empty:mt-0">
        {notice}
      </p>
    </Card>
  );
}
