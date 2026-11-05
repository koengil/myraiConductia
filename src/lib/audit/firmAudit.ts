/**
 * Firm audit projection (#173 G-03): one row of the firm's team inbox audit trail made screen-ready.
 *
 * GET /api/v1/discovery/team-mailboxes/audit returns the firm's own team inbox rows (ids, fixed codes, counts and
 * user names, never mail; the address only in `inboxes`, from the registry). This module owns every string such a
 * row shows on /discovery: the action label comes from the deal trail's describer (describeAuditRow), so both
 * trails name an action the same way (drift, and an access change or refused read of a team inbox, which the
 * describer would call "a mailbox", are worded here); the detail, the verdict, the inbox cell and the actor are built here from the
 * projected detail. The deal trail (AuditTrail.tsx, toAuditEvent) is untouched.
 *
 * The labels are design to confirm (UX/UI designer).
 */

import { dateLabel } from '@/components/discovery/IngestionHealth';
import { AUDIT_ACTOR_TYPE, DISCOVERY_AUDIT_ACTION, MODEL_GATEWAY_SERVICE_IDENTITY } from '@/lib/constants/audit';
import {
  DISCOVERY_WORKER_SERVICE_IDENTITY,
  DRIFT_STATUS,
  M365_RECORDER_SERVICE_IDENTITY,
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  READER_PASS_STATUS,
  TEAM_MAILBOX_AUDIT_VIEW,
  TEAM_MAILBOX_CHECK_REASON,
  TEAM_MAILBOX_CHECK_STATUS,
  type TeamMailboxCheckReason,
} from '@/lib/constants/discovery';
import type { TeamMailboxAuditInbox, TeamMailboxAuditRow, TeamMailboxAuditView } from '@/lib/discovery/api';

import { describeAuditRow } from './serverAudit';

/** The tones a verdict chip takes (a subset of the Badge atom's). */
export type FirmAuditTone = 'neutral' | 'positive' | 'negative' | 'hold';

export type FirmAuditEvent = {
  id: string;
  ts: string;
  /** The Inbox cell: the inbox's address, ALL_TEAM_INBOXES for a firm event, or REMOVED_INBOX. */
  inbox: string;
  /** Which of the three the Inbox cell is; only an address is shown in mono. */
  inboxKind: 'address' | 'firm' | 'removed';
  action: string;
  target: string;
  /** A verdict chip beside the action: a check's verified or refused, an ingest group's state. */
  verdict: { label: string; tone: FirmAuditTone } | null;
  /** "by <name>" for a person, the service's own label, "Service <identity>", or "Service". */
  actorLabel: string;
  /** An unlabelled service's code-shaped identity, which the row shows in mono after "Service". */
  actorCode: string | null;
};

/** The Inbox cell of a firm event: a Google ingest-group row belongs to the registration, never to one inbox (R16). */
export const ALL_TEAM_INBOXES = 'All team inboxes';
/** The Inbox cell of a row whose inbox has since been removed: the registry no longer gives its address. */
export const REMOVED_INBOX = 'Removed inbox';

/** The services that write team inbox rows, by their audit_log.service_identity (design R12). */
export const SERVICE_IDENTITY_LABEL: Record<string, string> = {
  [DISCOVERY_WORKER_SERVICE_IDENTITY]: 'Discovery worker',
  // The membership trigger closes a membership when its person loses their seat (20261019150000).
  'team-mailbox': 'Team inbox access rule',
  [M365_RECORDER_SERVICE_IDENTITY]: 'M365 recorder',
  'mailbox-consent': 'Mailbox consent',
  [MODEL_GATEWAY_SERVICE_IDENTITY]: 'Model gateway',
  // The approvals trigger writes an owner's capability switch, made by a reviewed migration (G-01, 20261023110100).
  // Design to confirm.
  'discovery-tenant-approvals': 'Owner approval',
};

/** One short phrase per Directory refusal (design R7's short reasons; design to confirm). */
export const CHECK_REASON_LABEL: Record<TeamMailboxCheckReason, string> = {
  [TEAM_MAILBOX_CHECK_REASON.GROUP]: 'Google Group, not a mailbox',
  [TEAM_MAILBOX_CHECK_REASON.ALIAS]: 'Alias, not the primary address',
  [TEAM_MAILBOX_CHECK_REASON.SUSPENDED]: 'Account suspended',
  [TEAM_MAILBOX_CHECK_REASON.NO_MAILBOX]: 'No mailbox yet',
  [TEAM_MAILBOX_CHECK_REASON.NOT_FOUND]: 'Not found in Workspace',
  [TEAM_MAILBOX_CHECK_REASON.IDENTITY_CHANGED]: 'Address moved to another account',
  [TEAM_MAILBOX_CHECK_REASON.DIRECTORY_DENIED]: 'Directory read not granted',
};

/** A stored pass with no finish row after an hour (the reads_notable view's started rows). */
export const NO_FINISH_RECORDED = 'No finish recorded';

const words = (code: string | undefined): string => (code ? code.replaceAll('_', ' ') : '');
const sentence = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : '');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const joined = (parts: string[]): string => parts.filter(Boolean).join(' · ');

/** The action label of a Google ingest-group row, from its status (R16). */
export function driftSentence(status: string | undefined, provider: string | undefined): string {
  const group = provider === MAILBOX_PROVIDER.GOOGLE ? 'Google ingest group' : 'ingest group';
  if (status === DRIFT_STATUS.UNAVAILABLE) return `Couldn't read the ${group}`;
  if (status === DRIFT_STATUS.IN_SYNC) return `${sentence(group)} matches the allowlist again`;
  return `${sentence(group)} differs from the allowlist`;
}

/** What a drift row says about the caller's own inboxes; computed against them only, by the RPC. */
export function driftTarget(thisInbox: TeamMailboxAuditRow['detail']['thisInbox']): string {
  if (thisInbox === 'missing') return 'This inbox is missing from the group';
  if (thisInbox === 'extra') return 'This inbox is in the group but not on the allowlist';
  if (thisInbox === 'both') return 'One team inbox is missing from the group, another is in it but not on the allowlist';
  return '';
}

/** "12 fetched, 3 excluded by policy, 9 stored": a finished pass's counts, those it carries, in that order. */
export function passCounts(detail: TeamMailboxAuditRow['detail']): string {
  return [
    isCount(detail.fetched) ? `${detail.fetched} fetched` : '',
    isCount(detail.excluded) ? `${detail.excluded} excluded by policy` : '',
    isCount(detail.stored) ? `${detail.stored} stored` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** "3 asked: 1 deal, 1 not a deal, 1 unreadable": a finished AI pass's counts, those it carries (G-01). */
export function proposalCounts(detail: TeamMailboxAuditRow['detail']): string {
  const answers = [
    isCount(detail.deal) ? plural(detail.deal, 'deal', 'deals') : '',
    isCount(detail.notDeal) ? `${detail.notDeal} not a deal` : '',
    isCount(detail.invalid) ? `${detail.invalid} unreadable` : '',
    isCount(detail.failed) && detail.failed > 0 ? `${detail.failed} failed` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const asked = isCount(detail.asked) ? `${detail.asked} asked` : '';
  return asked && answers ? `${asked}: ${answers}` : asked || answers;
}

/** "12 read, 3 milestones found": a rule detector pass's counts, those it carries (G-07). Copy: design to confirm. */
export function detectionCounts(detail: TeamMailboxAuditRow['detail']): string {
  return [
    isCount(detail.items) ? `${detail.items} read` : '',
    isCount(detail.events) ? `${plural(detail.events, 'milestone', 'milestones')} found` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function verdictOf(row: TeamMailboxAuditRow): FirmAuditEvent['verdict'] {
  // An owner's capability switch (G-01): on or off, as the reviewed migration left it.
  if (row.action === DISCOVERY_AUDIT_ACTION.TENANT_APPROVAL_CHANGED && typeof row.detail.on === 'boolean') {
    return row.detail.on ? { label: 'On', tone: 'positive' } : { label: 'Off', tone: 'neutral' };
  }
  const status = row.detail.status;
  if (!status) return null;
  if (row.action === DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CHECKED) {
    if (status === TEAM_MAILBOX_CHECK_STATUS.VERIFIED) return { label: 'Verified', tone: 'positive' };
    if (status === TEAM_MAILBOX_CHECK_STATUS.REFUSED) return { label: 'Refused', tone: 'negative' };
    return { label: sentence(words(status)), tone: 'neutral' };
  }
  if (row.action === DISCOVERY_AUDIT_ACTION.ALLOWLIST_DRIFT) {
    if (status === DRIFT_STATUS.UNAVAILABLE) return { label: 'Unavailable', tone: 'hold' };
    if (status === DRIFT_STATUS.IN_SYNC) return { label: 'In sync', tone: 'positive' };
    return { label: 'Differs', tone: 'hold' };
  }
  return null;
}

function targetOf(row: TeamMailboxAuditRow, view: TeamMailboxAuditView, fallback: string): string {
  const d = row.detail;
  switch (row.action) {
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CONNECTED:
      return '';
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CHECKED:
      // The verdict is the chip; the detail is why a refusal refused.
      if (d.status !== TEAM_MAILBOX_CHECK_STATUS.REFUSED || !d.reason) return '';
      return Object.hasOwn(CHECK_REASON_LABEL, d.reason)
        ? CHECK_REASON_LABEL[d.reason as TeamMailboxCheckReason]
        : sentence(words(d.reason));
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_ADDED:
      return row.subjectName ?? 'A person';
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_REMOVED:
      return joined([row.subjectName ?? 'A person', words(d.reason)]);
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_DISCONNECTED:
      return sentence(words(d.reason));
    case DISCOVERY_AUDIT_ACTION.MAILBOX_ACCESS_CHANGED:
      // The action already says paused, resumed or restarted; a window says from which day it reads.
      if (d.change === 'window_set') {
        if (!d.to) return '';
        const day = (value: string) => dateLabel(value) ?? value;
        return `First read from ${day(d.to)}${d.from ? `, was ${day(d.from)}` : ''}`;
      }
      if (d.change === 'paused' || d.change === 'resumed' || d.change === 'restarted') return '';
      return sentence(words(d.change));
    case DISCOVERY_AUDIT_ACTION.MAILBOX_REFUSED:
      return joined([
        sentence(words(d.reason)),
        d.purpose && d.purpose !== MAILBOX_GUARD_PURPOSE.PROVIDER_READ ? `for ${words(d.purpose)}` : '',
      ]);
    case DISCOVERY_AUDIT_ACTION.ALLOWLIST_DRIFT:
      return driftTarget(d.thisInbox);
    case DISCOVERY_AUDIT_ACTION.READER_PASS_STARTED:
      // The notable view lists a started pass only when no finish was recorded within the hour (design R9).
      return view === TEAM_MAILBOX_AUDIT_VIEW.READS_NOTABLE ? NO_FINISH_RECORDED : '';
    case DISCOVERY_AUDIT_ACTION.READER_PASS_FINISHED:
      return joined([
        d.status && d.status !== READER_PASS_STATUS.COMPLETE ? sentence(words(d.status)) : '',
        passCounts(d),
      ]);
    case DISCOVERY_AUDIT_ACTION.CANDIDATE_PROPOSED:
      return isCount(d.evidenceCount) ? plural(d.evidenceCount, 'message', 'messages') : '';
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_PROPOSAL_STARTED:
      return '';
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_PROPOSAL_FINISHED:
      return joined([sentence(words(d.outcome)), proposalCounts(d)]);
    case DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MILESTONES_DETECTED:
      return detectionCounts(d);
    case DISCOVERY_AUDIT_ACTION.TENANT_APPROVAL_CHANGED:
      // The verdict chip says on or off; the detail names the capability.
      return sentence(words(d.capability));
    default:
      return fallback;
  }
}

/**
 * The deal trail's describer names these two "a mailbox", which is right for a person's mailbox. On a row of one of
 * the firm's team inboxes (inboxId set) they are said of the team inbox instead.
 */
const TEAM_ACCESS_CHANGE_ACTION: Record<string, string> = {
  paused: 'Paused reading the team inbox',
  resumed: 'Resumed reading the team inbox',
  restarted: 'Restarted reading the team inbox',
  window_set: 'Set how far back the team inbox is read',
};

function teamInboxAction(row: TeamMailboxAuditRow): string | null {
  if (row.inboxId === null) return null;
  if (row.action === DISCOVERY_AUDIT_ACTION.MAILBOX_ACCESS_CHANGED) {
    const change = row.detail.change;
    return change && Object.hasOwn(TEAM_ACCESS_CHANGE_ACTION, change)
      ? TEAM_ACCESS_CHANGE_ACTION[change]
      : 'Changed how the team inbox is read';
  }
  if (row.action === DISCOVERY_AUDIT_ACTION.MAILBOX_REFUSED) return 'Refused a team inbox read';
  return null;
}

function inboxOf(row: TeamMailboxAuditRow, inboxes: TeamMailboxAuditInbox[]): Pick<FirmAuditEvent, 'inbox' | 'inboxKind'> {
  if (row.inboxId === null) return { inbox: ALL_TEAM_INBOXES, inboxKind: 'firm' };
  const address = inboxes.find((i) => i.id === row.inboxId)?.address;
  return address ? { inbox: address, inboxKind: 'address' } : { inbox: REMOVED_INBOX, inboxKind: 'removed' };
}

function actorOf(row: TeamMailboxAuditRow): Pick<FirmAuditEvent, 'actorLabel' | 'actorCode'> {
  if (row.actorType === AUDIT_ACTOR_TYPE.USER) {
    return { actorLabel: row.actorName ? `by ${row.actorName}` : 'by a user', actorCode: null };
  }
  const identity = row.serviceIdentity;
  if (identity && Object.hasOwn(SERVICE_IDENTITY_LABEL, identity)) {
    return { actorLabel: SERVICE_IDENTITY_LABEL[identity], actorCode: null };
  }
  // The RPC returns only a code-shaped identity, so one it lets through is safe to show; a free-text one is null.
  return identity ? { actorLabel: `Service ${identity}`, actorCode: identity } : { actorLabel: 'Service', actorCode: null };
}

/**
 * Map one firm audit row to the display shape. `inboxes` is the page's registry list (open inboxes carry their
 * address); `view` is the view the row was read in, which only changes what a started pass says.
 */
export function toFirmAuditEvent(
  row: TeamMailboxAuditRow,
  inboxes: TeamMailboxAuditInbox[],
  view: TeamMailboxAuditView = TEAM_MAILBOX_AUDIT_VIEW.ACCESS,
): FirmAuditEvent {
  const described = describeAuditRow({
    id: row.id,
    ts: row.ts,
    action: row.action,
    document_id: null,
    detail: row.detail as Record<string, unknown>,
    actor: null,
  });
  const action =
    row.action === DISCOVERY_AUDIT_ACTION.ALLOWLIST_DRIFT
      ? driftSentence(row.detail.status, row.detail.provider)
      : (teamInboxAction(row) ?? described.action);
  return {
    id: row.id,
    ts: row.ts,
    ...inboxOf(row, inboxes),
    action,
    target: targetOf(row, view, described.target),
    verdict: verdictOf(row),
    ...actorOf(row),
  };
}
