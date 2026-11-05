'use client';

import * as React from 'react';

import { Mail, RefreshCw, X } from 'lucide-react';

import { Button, Pill } from '@/components/atoms';
import { Disclosure, DisclosureGroup } from '@/components/overlay';
import { useProjectId } from '@/lib/project/useProjectId';
import { DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';
import { accessSummary } from '@/lib/team/accessPhase';
import {
  canOpenInvite,
  resendInviteRequest,
  viewerFromMe,
  type MeBody,
  type Viewer,
} from '@/lib/team/inviteAccess';
import {
  groupByCompany,
  type LiveCompanySection,
  type LiveMember,
  type LiveRoster,
} from '@/lib/team/roster';
import { invitesShownTo, rosterShownTo } from '@/lib/team/rosterVisibility';
import { InviteModal } from './InviteModal';
import { RecipientAffiliationEditor } from './RecipientAffiliationEditor';
import { peekRecipientAddition,clearRecipientAddition } from '@/lib/team/recipientAddition';
import { NotOnDeal } from '@/components/deals/DealsUnavailable';
import { PartyColumn, PARTY_COLUMN_GRID } from './PartyColumn';
import { MemberDetail } from './MemberDetail';
import { DealInviteButton } from './DealInvite';
import type { InviteResendResult } from '@/components/wizard/inviteQueue';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * Live Team roster for platform_onboarding (flag ON).
 *
 * Live data, not fixtures: the roster from GET /api/v1/deals/{dealId}/members
 * grouped by company, the pending invites from GET /api/v1/invites?dealId, and
 * the viewer's identity from GET /api/v1/me. Two groups: your firm, then the
 * outside parties, one card per firm. A person's detail opens inline under
 * their row, one at a time (a single-open DisclosureGroup); nothing opens
 * across the screen.
 *
 * "Invite to deal" here brings colleagues at your own firm only. Outside
 * parties get access from the Data Room ("Give data room access", the same
 * external seat); Team lists who has it, read-only. The one exception is the
 * recipient handoff from Mail (the "Invite … to deal" link opens "Add
 * recipient to deal"), which keeps every firm
 * because a sent-to address can belong to either side.
 *
 * An outside viewer (a seller's or a buyer's people) sees only their own firm
 * and the bank's deal team, and no "Data room access" list. Display filter
 * only. The members API still returns every seat (handoff E25).
 */

export type PendingInvite = {
  id: string;
  email: string;
  companyId: string;
  companyRole: string;
  dealId: string | null;
  dealRole: string | null;
  status: string;
  deliveryStatus: string;
};

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** The column an outside viewer with no company on record sits in. */
const OWN_SEAT_SECTION = '__own_seat__';
const UNAFFILIATED_SECTION = '__unaffiliated__';

function partyLabel(partyRole: string | null): string {
  if (partyRole === 'bank') return 'Advisory bank';
  if (partyRole === 'target') return 'Seller (target)';
  if (partyRole === 'co_seller') return 'Co-seller';
  if (partyRole === 'acquirer_shortlist') return 'Buyer (shortlisted)';
  if (partyRole === 'counterparty') return 'Counterparty';
  return 'Other firm';
}

function roleLabel(dealRole: string): string {
  return DEAL_ROLE_LABELS[dealRole as DealRole] ?? dealRole;
}

function memberName(member: LiveMember): string {
  return member.displayName ?? member.fullName ?? member.email ?? member.userId;
}

/** The row's own text: name, then role and email. Shown once; the detail does not repeat it. */
function MemberRowTitle({ member }: { member: LiveMember }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-[length:var(--text-base)] font-medium text-[var(--ink)]">
        {memberName(member)}
      </span>
      <span className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {roleLabel(member.dealRole)}
        {member.email ? ` · ${member.email}` : ''}
      </span>
    </span>
  );
}

function PendingInviteRow({
  invite,
  onResend,
  onRevoke,
  busy,
  error,
}: {
  invite: PendingInvite;
  onResend: (id: string) => void;
  onRevoke: (id: string) => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <li className="flex min-h-[var(--space-12)] flex-col gap-[var(--space-2)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
      <div className="min-w-0">
        <p className="truncate text-[length:var(--text-sm)] text-[var(--ink)]">{invite.email}</p>
        <p className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Invite pending
          {invite.dealRole ? ` · ${roleLabel(invite.dealRole)}` : ''}
          {invite.deliveryStatus === 'unsent' ? ' · Email failed. Resend.' : ''}
        </p>
        {error ? (
          <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative,red)]">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-2)]">
        <button
          type="button"
          disabled={busy}
          onClick={() => onResend(invite.id)}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
          Resend
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onRevoke(invite.id)}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
          Revoke
        </button>
      </div>
    </li>
  );
}

export function LiveTeamRoster() {
  const dealId = useProjectId();
  return <ProjectTeamRoster key={dealId} />;
}

function ProjectTeamRoster() {
  const dealId = useProjectId();

  const [roster, setRoster] = React.useState<LiveRoster | null>(null);
  /** The roster read failed: a plain sentence and Try again, never the server's text. */
  const [rosterFailed, setRosterFailed] = React.useState(false);
  /** The members read answered 404: the viewer is not on this deal, and a retry cannot change that. A 403 is an account gate (MFA, suspended) and stays a failed read. */
  const [notOnDeal, setNotOnDeal] = React.useState(false);
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  /** /me has answered (or failed). Grouping waits for it, so "Your firm" never flips. */
  const [viewerSettled, setViewerSettled] = React.useState(false);
  /** /me failed: the page shows the bank's people only, with a retry. */
  const [viewerFailed, setViewerFailed] = React.useState(false);
  const [viewerAttempt, setViewerAttempt] = React.useState(0);
  const [invites, setInvites] = React.useState<PendingInvite[]>([]);
  // The invite list is served only to viewers who may manage deal members, the
  // same check the invite POST runs, so its answer gates the bank-side button (#396).
  // Only a 403 means "not allowed"; any other failure leaves it undecided (null).
  const [inviteListAllowed, setInviteListAllowed] = React.useState<boolean | null>(null);
  const [recipientEmail,setRecipientEmail] = React.useState(()=>peekRecipientAddition(dealId, 'team'));
  const [inviteOpen, setInviteOpen] = React.useState(Boolean(recipientEmail));
  const [inviteBusyId, setInviteBusyId] = React.useState<string | null>(null);
  const [inviteRowError, setInviteRowError] = React.useState<Record<string, string>>({});

  const loadRoster = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/deals/${dealId}/members`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) {
        setNotOnDeal(true);
        setRosterFailed(false);
        setRoster(null);
        return;
      }
      if (!res.ok) {
        setNotOnDeal(false);
        setRosterFailed(true);
        return;
      }
      setNotOnDeal(false);
      setRosterFailed(false);
      setRoster((await res.json()) as LiveRoster);
    } catch {
      setNotOnDeal(false);
      setRosterFailed(true);
    }
  }, [dealId]);

  const loadInvites = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/invites?dealId=${dealId}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) setInviteListAllowed(true);
      else if (res.status === 403) setInviteListAllowed(false);
      if (!res.ok) {
        // The server withholds the invite list from viewers without manage
        // rights. The roster stays useful without it.
        setInvites([]);
        return;
      }
      const body = (await res.json()) as { invites: PendingInvite[] };
      setInvites(body.invites.filter((i) => i.status === 'pending'));
    } catch {
      setInvites([]);
    }
  }, [dealId]);

  React.useEffect(() => {
    void (async () => {
      await Promise.all([loadRoster(), loadInvites()]);
    })();
  }, [loadRoster, loadInvites]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let known = false;
      try {
        const res = await fetch('/api/v1/me', { headers: { Accept: 'application/json' } });
        if (res.ok) {
          const body = (await res.json()) as MeBody;
          if (cancelled) return;
          setViewer(viewerFromMe(body, dealId));
          known = true;
        }
      } catch {
        // Handled below: an unknown viewer sees the bank's people only.
      } finally {
        if (!cancelled) {
          setViewerFailed(!known);
          setViewerSettled(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, viewerAttempt]);

  const resendInvite = React.useCallback(
    async (inviteId: string): Promise<InviteResendResult> => {
      setInviteBusyId(inviteId);
      setInviteRowError((prev) => ({ ...prev, [inviteId]: '' }));
      try {
        const result = await resendInviteRequest(inviteId);
        if (result.ok) await loadInvites();
        if (result.error) setInviteRowError((prev) => ({ ...prev, [inviteId]: result.error ?? '' }));
        return result;
      } finally {
        setInviteBusyId(null);
      }
    },
    [loadInvites],
  );

  const revokeInvite = React.useCallback(
    async (inviteId: string) => {
      setInviteBusyId(inviteId);
      setInviteRowError((prev) => ({ ...prev, [inviteId]: '' }));
      try {
        const res = await fetch(`/api/v1/invites/${inviteId}`, { method: 'DELETE' });
        if (!res.ok) {
          const message = await readError(res);
          setInviteRowError((prev) => ({ ...prev, [inviteId]: message }));
        }
        await loadInvites();
      } finally {
        setInviteBusyId(null);
      }
    },
    [loadInvites],
  );

  // An outside viewer sees their own firm and the bank's deal team only
  // (display filter only; the members API still returns every seat, handoff E25).
  // Until /me answers, or if it fails, the page fails closed: the bank's
  // people only, no Data room access list, no invite.
  const viewerIsOutside = Boolean(viewer?.isExternal);
  const bankOnlyView = viewerIsOutside || viewer === null;
  const shownRoster = roster ? rosterShownTo(roster, viewer) : null;
  const shownInvites = invitesShownTo(invites, viewer);
  const sections: LiveCompanySection[] = shownRoster ? groupByCompany(shownRoster) : [];
  const invitesByCompany = new Map<string, PendingInvite[]>();
  for (const invite of shownInvites) {
    const list = invitesByCompany.get(invite.companyId) ?? [];
    list.push(invite);
    invitesByCompany.set(invite.companyId, list);
  }
  const orphanInvites = shownInvites.filter(
    (invite) => !sections.some((section) => section.companyId === invite.companyId),
  );

  // "Your firm" is the bank for bank users and the viewer's own company for an
  // outside party's people. Nothing is grouped until /me answers; if it
  // fails, only the bank's people show, as the bank's deal team. An outside
  // viewer with no company on record keeps their own seat under "Your firm"
  // rather than an empty heading.
  let ownSections: LiveCompanySection[];
  let outsideSections: LiveCompanySection[];
  if (viewer?.isExternal && viewer.companyId === null) {
    const self = sections.flatMap((section) => section.members).filter((m) => m.userId === viewer.id);
    ownSections =
      self.length > 0
        ? [{ companyId: OWN_SEAT_SECTION, companyName: 'Your seat', partyRole: null, members: self }]
        : [];
    outsideSections = sections
      .map((section) =>
        section.companyId === UNAFFILIATED_SECTION
          ? { ...section, members: section.members.filter((m) => m.userId !== viewer.id) }
          : section,
      )
      .filter((section) => section.members.length > 0);
  } else if (viewer === null) {
    ownSections = [];
    outsideSections = sections.filter((section) => section.members.length > 0);
  } else {
    const ownCompanyId = viewer.isExternal ? viewer.companyId : (roster?.bankCompanyId ?? null);
    ownSections = sections.filter((section) => section.companyId === ownCompanyId);
    outsideSections = sections.filter((section) => section.companyId !== ownCompanyId);
  }
  // Outside parties reach the data room, gated by their phase; your own firm's
  // people are not listed here. Bank viewers only.
  const dataRoomPeople = outsideSections.flatMap((section) =>
    section.members
      .filter((member) => member.isExternal)
      .map((member) => ({ member, firm: section.companyName })),
  );

  // No invite until the roster is in: a deal whose members read is refused
  // (404 or 403) is not one the viewer can invite to (handoff E31).
  const canInvite = roster !== null && canOpenInvite(viewer, inviteListAllowed, 'internal');
  const viewerIsMd = Boolean(viewer?.isDealMd);

  const renderInvite = (invite: PendingInvite) => (
    <PendingInviteRow
      key={invite.id}
      invite={invite}
      onResend={resendInvite}
      onRevoke={revokeInvite}
      busy={inviteBusyId === invite.id}
      error={inviteRowError[invite.id] || null}
    />
  );

  const renderSection = (section: LiveCompanySection) => {
    const pending = invitesByCompany.get(section.companyId) ?? [];
    return (
      <PartyColumn
        headingLevel={3}
        key={section.companyId}
        label={section.companyName}
        count={section.members.length}
        meta={
          section.companyId === OWN_SEAT_SECTION ? undefined : (
            <Pill className="w-fit">{partyLabel(section.partyRole)}</Pill>
          )
        }
      >
        {section.members.map((member) => (
          <li key={member.userId}>
            <Disclosure
              value={member.userId}
              title={<MemberRowTitle member={member} />}
              meta={member.isExternal ? accessSummary(member) : undefined}
            >
              {/* Keyed per person: nothing typed for one person carries to the next. */}
              <MemberDetail
                key={member.userId}
                dealId={dealId}
                member={member}
                companyMembers={section.members}
                viewerIsMd={viewerIsMd}
                onChanged={() => {
                  void loadRoster();
                }}
              />
            </Disclosure>
          </li>
        ))}
        {pending.map(renderInvite)}
      </PartyColumn>
    );
  };

  return (
    <section
      aria-label="Team roster"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--surface-warm)]"
    >
      <header className="flex shrink-0 flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]">
        <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
          <h1 className="text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
            Team
          </h1>
          {canInvite ? (
            <DealInviteButton
              mode="internal"
              onClick={() => {
                setRecipientEmail(null);
                setInviteOpen(true);
              }}
            />
          ) : null}
        </div>
        {viewer && !viewer.isExternal && inviteListAllowed === false ? (
          <p role="note" className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Invitations are sent by the deal MD or a member they delegate.
          </p>
        ) : null}
      </header>

      <div className="flex flex-col gap-[var(--space-6)] px-[var(--space-5)] py-[var(--space-5)]">
        {notOnDeal ? <NotOnDeal className="py-0" /> : null}
        {rosterFailed ? (
          // The Audit Trail's load-error pattern: a plain sentence, then Try again.
          <div className="flex flex-col items-start gap-[var(--space-3)]">
            <p role="alert" className="text-[length:var(--text-md)] text-[var(--ink-secondary)]">
              The team could not be loaded.
            </p>
            <Button variant="primary" size="sm" onClick={() => void loadRoster()}>
              Try again
            </Button>
          </div>
        ) : null}
        {viewerFailed ? (
          <div role="alert" className="flex flex-wrap items-center gap-[var(--space-3)]">
            <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              Your access could not be checked. Showing the bank&apos;s deal team.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setViewerSettled(false);
                setViewerFailed(false);
                setViewerAttempt((n) => n + 1);
              }}
            >
              {TRY_AGAIN_COPY}
            </Button>
          </div>
        ) : null}
        {!rosterFailed && roster && sections.length === 0 && shownInvites.length === 0 ? (
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            No one is on this deal yet.
          </p>
        ) : null}

        {roster && viewerSettled && sections.length > 0 ? (
          // One group for the whole page: opening a person closes whoever was open.
          <DisclosureGroup single>
            {!bankOnlyView || ownSections.length > 0 ? (
              <section aria-labelledby="team-own-firm" className="flex flex-col gap-[var(--space-3)]">
                <h2 id="team-own-firm" className="text-[length:var(--text-base)] font-semibold text-[var(--ink)]">
                  Your firm
                </h2>
                <div className={PARTY_COLUMN_GRID}>{ownSections.map(renderSection)}</div>
              </section>
            ) : null}

            <section aria-labelledby="team-outside" className="flex flex-col gap-[var(--space-3)]">
              <h2 id="team-outside" className="text-[length:var(--text-base)] font-semibold text-[var(--ink)]">
                {bankOnlyView ? "The bank's deal team" : 'Outside parties'}
              </h2>
              {outsideSections.length > 0 || orphanInvites.length > 0 ? (
                <div className={PARTY_COLUMN_GRID}>
                  {outsideSections.map(renderSection)}
                  {orphanInvites.length > 0 ? (
                    <PartyColumn
                      headingLevel={3}
                      label="Pending invitations"
                      heading={
                        <span className="inline-flex items-center gap-[6px]">
                          <Mail size={14} strokeWidth={1.75} aria-hidden />
                          Pending invitations
                        </span>
                      }
                      count={orphanInvites.length}
                    >
                      {orphanInvites.map(renderInvite)}
                    </PartyColumn>
                  ) : null}
                </div>
              ) : (
                <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                  {bankOnlyView
                    ? 'No one from the bank is on this deal yet.'
                    : 'No outside parties on this deal yet.'}
                </p>
              )}
            </section>
          </DisclosureGroup>
        ) : null}

        {roster && viewerSettled && !bankOnlyView ? (
          <section
            aria-labelledby="team-data-room"
            className="flex max-w-3xl flex-col gap-[var(--space-2)]"
          >
            <h2 id="team-data-room" className="text-[length:var(--text-base)] font-semibold text-[var(--ink)]">
              Data room access
            </h2>
            {dataRoomPeople.length > 0 ? (
              <ul className="m-0 flex list-none flex-col divide-y divide-[var(--stroke)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-0">
                {dataRoomPeople.map(({ member, firm }) => (
                  <li
                    key={member.userId}
                    className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-3)] gap-y-[var(--space-1)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)]"
                  >
                    <span className="min-w-0 text-[var(--ink)]">
                      {memberName(member)}
                      <span className="text-[var(--ink-secondary)]"> · {firm}</span>
                    </span>
                    <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                      {accessSummary(member)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
                No outside parties have data room access yet.
              </p>
            )}
          </section>
        ) : null}
      </div>

      {shownRoster && viewer ? <RecipientAffiliationEditor dealId={dealId} roster={shownRoster} invites={shownInvites}/> : null}
      {recipientEmail && viewer && !canInvite && (viewer.isExternal || inviteListAllowed !== null) ? <p role="status" className="p-5 text-[length:var(--text-sm)]">A deal manager must add this recipient to the deal.</p> : null}
      {inviteOpen && shownRoster && (!recipientEmail || canInvite) ? (
        <InviteModal
          dealId={dealId}
          roster={shownRoster}
          viewer={viewer}
          // The Mail handoff keeps every firm; Team's own button is your firm only.
          scope={recipientEmail ? undefined : 'internal'}
          initialRecipientEmail={recipientEmail ?? undefined}
          onClose={() => {setInviteOpen(false);setRecipientEmail(null);clearRecipientAddition();}}
          onCreated={() => {
            clearRecipientAddition();
            void loadInvites();
            void loadRoster();
          }}
          onResend={resendInvite}
        />
      ) : null}
    </section>
  );
}

export default LiveTeamRoster;
