'use client';

import * as React from 'react';
import { RecipientAffiliationFields } from './RecipientAffiliationFields';
import type { RecipientAffiliation } from '@/lib/constants/recipientAffiliations';

import {
  COMPANY_ROLE,
  DEAL_ROLE_LABELS,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
  resolvePreferredDealRole,
} from '@/lib/constants/roles';
import { PerimeterPreview } from '@/components/onboarding/PerimeterPreview';
import {
  LOOKS_LIKE_EMAIL,
  SmartLookupCard,
  type LookupResult,
} from '@/components/onboarding/SmartLookupCard';
import type { InviteResendResult } from '@/components/wizard/inviteQueue';
import type { LiveRoster } from '@/lib/team/roster';
import { RESEND_UNDELIVERED, type InviteScope, type Viewer } from '@/lib/team/inviteAccess';
import { accessPhaseName, accessPhaseOptions } from '@/lib/team/accessPhase';
import { preflightInvite } from '@/lib/team/invitePreflight';
import { Dialog } from '@/components/overlay';

/**
 * InviteModal: bring a new person onto the deal (platform_onboarding).
 *
 * The server enforces every rule; this form only avoids dead ends. `scope`
 * picks which firms the form offers:
 * - `internal` ("Invite to deal", Team): the viewer's own firm. For the bank
 *   that is a deal_team / legal / read_only seat; an external director invites
 *   into their own company only, as a member.
 * - `data-room` ("Give data room access", Data Room): an outside party's
 *   company, on the party-derived seller or buyer seat with the invitee
 *   flagged director or member, and the phase their data room view reaches.
 * - omitted: every firm on the deal. Only Team's recipient handoff from Mail
 *   (the "Invite … to deal" link opens "Add recipient to deal") uses it,
 *   because a sent-to address can belong to either.
 * Recipient mode (the deal relationship is required and sent as
 * recipientAffiliation) is keyed on `initialRecipientEmail`, in any scope: the
 * Data Room handoff from Mail ("Give … data room access") uses it with
 * scope="data-room".
 * The external seat and every API call are the same in each scope.
 */

const SCOPE_TITLE: Record<InviteScope | 'any', string> = {
  internal: 'Invite to deal',
  'data-room': 'Give data room access',
  // The Mail handoff: the sent-to address may belong to your firm or to an
  // outside party, so neither "Invite to deal" (your firm) nor "Give data
  // room access" (outside parties) would be true.
  any: 'Add recipient to deal',
};

const SCOPE_DESCRIPTION: Record<InviteScope | 'any', string | undefined> = {
  internal: 'Colleagues at your firm join this deal.',
  // No sentence here: an outside party's seat reaches more than the data room
  // (the deal's pages, Team, Mail, Audit Trail), and the "What they can see"
  // preview below lists exactly what, for the access chosen.
  'data-room': undefined,
  any: undefined,
};

const INTERNAL_DEAL_ROLES = INTERNAL_ASSIGNABLE_DEAL_ROLES.map((value) => ({
  value,
  label: DEAL_ROLE_LABELS[value],
}));

const SELLER_PARTY_ROLES = ['target', 'co_seller'];

type CompanyOption = {
  companyId: string;
  companyName: string;
  isBank: boolean;
  /** For a party company, the seat its people take on this deal. */
  externalDealRole: 'seller' | 'buyer' | null;
};

type Created = {
  id: string;
  email: string;
  deliveryStatus: string;
  existingAccount?: boolean;
  accessGranted?: boolean;
  resendError?: string;
};

type DomainConfirmation = {
  id: string;
  classification: 'mismatch' | 'personal' | 'unverified';
  snapshot: string;
};

async function parseBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function InviteModal({
  dealId,
  roster,
  viewer,
  onClose,
  onCreated,
  onResend,
  initialRecipientEmail,
  scope,
}: {
  initialRecipientEmail?: string;
  /** Which firms the form offers. Omit only for Team's recipient handoff from Mail; recipient mode does not depend on it. */
  scope?: InviteScope;
  dealId: string;
  roster: LiveRoster;
  viewer: Viewer | null;
  onClose: () => void;
  onCreated: () => void;
  onResend: (inviteId: string) => Promise<InviteResendResult>;
}) {
  const options = React.useMemo<CompanyOption[]>(() => {
    const bank: CompanyOption | null = roster.bankCompanyId
      ? {
          companyId: roster.bankCompanyId,
          companyName:
            roster.members.find((m) => m.companyId === roster.bankCompanyId)?.companyName ??
            'Advisory bank',
          isBank: true,
          externalDealRole: null,
        }
      : null;
    const parties: CompanyOption[] = roster.parties.map((party) => ({
      companyId: party.companyId,
      companyName: party.companyName ?? 'Unknown company',
      isBank: false,
      externalDealRole: SELLER_PARTY_ROLES.includes(party.partyRole) ? 'seller' : 'buyer',
    }));
    let list: CompanyOption[];
    if (scope === 'internal') {
      // Your own firm: the bank for bank users, your party for an external one.
      list = viewer?.isExternal
        ? parties.filter((o) => o.companyId === viewer.companyId)
        : bank
          ? [bank]
          : [];
    } else if (scope === 'data-room') {
      list = parties;
    } else {
      list = bank ? [bank, ...parties] : parties;
    }
    // An external director's own company must be selectable even if the party
    // list failed to resolve a name for it.
    if (
      viewer?.isExternal &&
      viewer.companyId &&
      !list.some((o) => o.companyId === viewer.companyId)
    ) {
      list.push({
        companyId: viewer.companyId,
        companyName: 'Your firm',
        isBank: false,
        externalDealRole: 'seller',
      });
    }
    return list;
  }, [roster, viewer, scope]);

  const viewerLocked = Boolean(viewer?.isExternal);
  // Team's invite is the viewer's own firm, so there is nothing to choose: the
  // control shows the firm and stays fixed.
  const companyFixed = viewerLocked || scope === 'internal';
  // An external inviter has exactly one company and no choice to make. An
  // internal one starts with NO company selected rather than defaulting to the
  // advisory bank: the select used to show a company the inviter never picked,
  // which then travelled into lookup as "the selected company" and made every
  // counterparty address contradict it. Unset is a state the control can hold,
  // so the value on screen is the value that is sent (A5(b), A13).
  const initialCompanyId = viewerLocked
    ? (viewer?.companyId ?? '')
    : scope === 'internal'
      ? (roster.bankCompanyId ?? '')
      : '';

  const [email, setEmail] = React.useState(initialRecipientEmail ?? '');
  const recipientMode = initialRecipientEmail !== undefined;
  const [affiliation,setAffiliation] = React.useState<RecipientAffiliation|''>('');
  const [representedCompanyId,setRepresentedCompanyId] = React.useState('');
  const [companyId, setCompanyId] = React.useState(initialCompanyId);
  const [internalRole, setInternalRole] = React.useState<string>(initialRecipientEmail !== undefined ? 'read_only' : INTERNAL_DEAL_ROLES[0].value);
  const [externalCompanyRole, setExternalCompanyRole] = React.useState<string>(
    COMPANY_ROLE.MEMBER,
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicateInviteId, setDuplicateInviteId] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<Created | null>(null);
  const [domainConfirmation, setDomainConfirmation] = React.useState<DomainConfirmation | null>(null);
  // The disclosure phase the inviter confirms on screen. It travels with the
  // invitation and is the phase actually granted at acceptance, so what the
  // preview showed is what the invitee gets.
  const [phase, setPhase] = React.useState(0);
  const [companyTouched, setCompanyTouched] = React.useState(false);
  const [phaseTouched, setPhaseTouched] = React.useState(false);
  const [roleTouched, setRoleTouched] = React.useState(false);
  const [companyRolePolicy, setCompanyRolePolicy] = React.useState<
    LookupResult['companyRolePolicy']
  >(null);
  // What the current recommendation put into the form, so exactly that much can
  // be taken back when it stops being current (criterion A14).
  const appliedRef = React.useRef<{
    key: string;
    email: string;
    phase: number;
    companyId: string | null;
    previousCompanyId: string;
    role: string | null;
    previousRole: string;
  } | null>(null);

  const selectedOption = options.find((o) => o.companyId === companyId) ?? null;
  const isBankTarget = Boolean(selectedOption?.isBank) && !viewerLocked;
  const activeCompanyRolePolicy =
    companyRolePolicy?.companyId === companyId ? companyRolePolicy : null;
  const roleBlocked = Boolean(
    selectedOption &&
      !selectedOption.isBank &&
      activeCompanyRolePolicy &&
      !activeCompanyRolePolicy.memberAllowed &&
      (recipientMode || !activeCompanyRolePolicy.directorAllowed),
  );

  const submit = React.useCallback(async () => {
    if (!email.trim() || !companyId) {
      setError('Email and company are required.');
      return;
    }
    if (recipientMode && !isBankTarget && (!affiliation || (affiliation.endsWith('_advisor') && !representedCompanyId))) {
      setError('Choose the recipient’s deal relationship and represented party.');
      return;
    }
    if (roleBlocked) {
      setError(
        'This company needs its first active director. A firm admin must send the invitation.',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    setDuplicateInviteId(null);
    try {
      const dealRole = isBankTarget
        ? internalRole
        : (selectedOption?.externalDealRole ?? 'seller');
      const companyRole = viewerLocked
        ? COMPANY_ROLE.MEMBER
        : isBankTarget
          ? COMPANY_ROLE.MEMBER
          : externalCompanyRole;
      // `phase` is part of the snapshot: changing it invalidates a domain
      // confirmation obtained for a different disclosure level, so the inviter
      // reconfirms rather than sending a seat they never saw previewed.
      const snapshot = JSON.stringify({
        email: email.trim().toLowerCase(),
        companyId,
        companyRole,
        dealId,
        dealRole,
        phase,
      });
      const confirmationId =
        domainConfirmation?.snapshot === snapshot ? domainConfirmation.id : undefined;
      if (!confirmationId) {
        const preflight = await preflightInvite({
          email: email.trim(),
          companyId,
          companyRole,
          dealId,
          dealRole,
        });
        if (preflight.kind === 'error') {
          setError(
            preflight.message ??
              (preflight.status
                ? `Request failed (${preflight.status})`
                : 'The email-domain check returned an invalid response.'),
          );
          return;
        }
        if (preflight.kind === 'confirm') {
          const { id, classification } = preflight;
          setDomainConfirmation({ id, classification, snapshot });
          return;
        }
      }
      const res = await fetch('/api/v1/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          companyId,
          companyRole,
          dealId,
          dealRole,
          phase,
          confirmationId,
          ...(recipientMode && !isBankTarget ? {recipientAffiliation:affiliation,representedCompanyId:representedCompanyId||null} : {}),
        }),
      });
      const body = await parseBody(res);
      if (res.status === 201) {
        const invite = body.invite as Created | undefined;
        setCreated(invite ?? { id: '', email: email.trim(), deliveryStatus: 'sent' });
        onCreated();
        return;
      }
      if (res.status === 200 && typeof body.existingUser === 'object' && body.existingUser) {
        const existing = body.existingUser as { id?: string; email?: string; accessGranted?: boolean };
        setCreated({
          id: existing.id ?? '',
          email: existing.email ?? email.trim(),
          deliveryStatus: 'existing',
          existingAccount: true,
          accessGranted: existing.accessGranted === true,
        });
        onCreated();
        return;
      }
      if (res.status === 409) {
        if (body.code === 'company_requires_director') {setError('This company needs its first director. Complete company setup before adding this recipient.');return;}
        if (typeof body.inviteId === 'string') {
          setDuplicateInviteId(body.inviteId);
        }
        setError('An invitation for this email is already pending.');
        return;
      }
      setError(
        typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
      );
    } catch {
      setError('The invitation failed to send.');
    } finally {
      setSubmitting(false);
    }
  }, [
    email,
    // Without `phase` here the callback closes over a stale value and sends a
    // disclosure level other than the one confirmed on screen.
    phase,
    companyId,
    dealId,
    isBankTarget,
    internalRole,
    externalCompanyRole,
    selectedOption,
    viewerLocked,
    onCreated,
    domainConfirmation,
    roleBlocked,
    recipientMode,affiliation,representedCompanyId,
  ]);

  const scopeKey = scope ?? 'any';
  const formId = React.useId();
  // The fixed Company select names its reason: the dialog's own sentence
  // ("Colleagues at your firm join this deal.") and, for an outside inviter,
  // the line that says invitees join their firm.
  const scopeReasonId = React.useId();
  const lockedReasonId = React.useId();
  const scopeDescription = SCOPE_DESCRIPTION[scopeKey];
  const companyReasonIds = companyFixed
    ? [scopeDescription ? scopeReasonId : null, viewerLocked ? lockedReasonId : null]
        .filter(Boolean)
        .join(' ') || undefined
    : undefined;
  // The phases offered, from the start of the deal. A recommendation outside
  // the named phases still shows as itself rather than as a different choice.
  const phaseOptions = accessPhaseOptions(0);
  if (!phaseOptions.some((o) => o.value === phase)) {
    phaseOptions.push({ value: phase, label: accessPhaseName(phase) });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={SCOPE_TITLE[scopeKey]}
      description={scopeDescription ? <span id={scopeReasonId}>{scopeDescription}</span> : undefined}
      // Typed input: a stray click outside must not discard it.
      dismissOnScrim={false}
      footer={
        created ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              disabled={submitting || roleBlocked}
              className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {submitting
                ? 'Checking'
                : domainConfirmation
                  ? 'Confirm and send'
                  : 'Check and send invite'}
            </button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-[var(--space-3)]">
          <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
            {created.existingAccount
              ? created.accessGranted
                ? `${created.email} already has an account and was added to this deal.`
                : `${created.email} already has access to this deal.`
              : `Invite pending for ${created.email}.`}
          </p>
          {created.deliveryStatus === 'unsent' ? (
            <div className="flex items-center gap-[var(--space-3)]">
              <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative,red)]">
                Email failed. Resend.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!created.id) return;
                  void onResend(created.id).then((result) => {
                    if (result.ok && result.deliveryStatus === 'sent') {
                      setCreated((current) => current ? {
                        ...current, deliveryStatus: 'sent', resendError: undefined,
                      } : current);
                    } else {
                      setCreated((current) => current ? {
                        ...current,
                        resendError: result.error ?? RESEND_UNDELIVERED,
                      } : current);
                    }
                  });
                }}
                className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                Resend
              </button>
              {created.resendError ? (
                <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative,red)]">
                  {created.resendError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <form
          id={formId}
          className="flex flex-col gap-[var(--space-4)]"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setDomainConfirmation(null);
              }}
              required
              className="rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[9px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </label>

          <SmartLookupCard
            email={email}
            dealId={dealId}
            // Exactly the value the form holds, so the result is bound to the
            // selection the inviter can see (A13). Unset reads as null, which
            // asks lookup which candidate company owns the domain; once a
            // company is selected the question narrows to whether the address
            // belongs to THAT company, and a mismatch warns (A5(b)).
            companyId={companyId || null}
            surface="team"
            onResult={(result, status) => {
              const nextPolicy = result?.companyRolePolicy ?? null;
              if (nextPolicy) {
                setCompanyRolePolicy(nextPolicy);
                const forcedRole =
                  !nextPolicy.memberAllowed && nextPolicy.directorAllowed
                    ? COMPANY_ROLE.DIRECTOR
                    : nextPolicy.memberAllowed && !nextPolicy.directorAllowed
                      ? COMPANY_ROLE.MEMBER
                      : null;
                if (forcedRole !== null && !(recipientMode && forcedRole === COMPANY_ROLE.DIRECTOR)) {
                  setExternalCompanyRole(forcedRole);
                  // Only a role that actually CHANGES voids the confirmation.
                  // companyRole is part of the snapshot the confirmation was
                  // issued against, so a re-delivery reporting the same policy
                  // leaves that snapshot intact. Clearing there loses a
                  // confirmation the inviter just obtained: a lookup still in
                  // flight when preflight returns would send them back to
                  // "Check and send invite" with nothing new to read.
                  if (forcedRole !== externalCompanyRole) setDomainConfirmation(null);
                }
              }
              // A9: recommendations pre-fill, they do not decide. A14: when a
              // result stops being current the values it applied are taken
              // back, because a recommendation that is no longer on screen
              // must not still be sitting in the form about to be sent.
              //
              // Only values THIS card applied are withdrawn, and only if the
              // inviter has not since changed them. Their own choices are
              // theirs; reverting those would be its own kind of lie.
              if (!result?.recommendation) {
                const applied = appliedRef.current;
                if (!applied) return;
                // A lookup merely in flight is not a lost result. Reverting
                // here would also fight the card: company is a bound input,
                // so the revert would re-key the request that cleared it and
                // the two would chase each other.
                // A14 is about every bound input, not only the address. The
                // recommendation was computed for one exact set of them; any
                // change makes it a statement about something else.
                const currentKey = `${email.trim().toLowerCase()}|${companyId}|${dealId}`;
                const lost = status === 'unavailable' || currentKey !== applied.key;
                if (!lost) return;
                appliedRef.current = null;
                // A phase the inviter typed is theirs, even where it happens
                // to equal what was recommended.
                if (!phaseTouched) setPhase((current) => (current === applied.phase ? 0 : current));
                if (!roleTouched && applied.role !== null) {
                  setInternalRole((current) =>
                    current === applied.role ? applied.previousRole : current,
                  );
                }
                setCompanyId((current) =>
                  current === applied.companyId ? applied.previousCompanyId : current,
                );
                return;
              }
              const nextPhase = result.recommendation.phase;
              const matched = result.companyMatch?.companyId ?? null;
              const takesCompany =
                !companyTouched &&
                matched !== null &&
                options.some((option) => option.companyId === matched);
              if (!phaseTouched && !recipientMode) setPhase(nextPhase);
              if (takesCompany) setCompanyId(matched);
              const nextRole = result.recommendation.dealRole;
              const matchedCompany = options.find((option) => option.companyId === matched);
              const internalRecommendation = matchedCompany?.isBank
                ? resolvePreferredDealRole(nextRole)
                : null;
              const takesRole =
                !roleTouched &&
                internalRecommendation !== null &&
                internalRecommendation !== internalRole;
              if (takesRole && !recipientMode) setInternalRole(internalRecommendation);
              // A repeat delivery for the same address must not re-capture
              // "what was there before" — by then what is there before is the
              // recommendation itself, and withdrawing would restore it.
              const prior = appliedRef.current;
              const sameAddress = prior?.email === email.trim().toLowerCase();
              appliedRef.current = {
                key: `${email.trim().toLowerCase()}|${takesCompany ? matched : companyId}|${dealId}`,
                email: email.trim().toLowerCase(),
                phase: nextPhase,
                companyId: takesCompany ? matched : null,
                previousCompanyId: sameAddress
                  ? (prior?.previousCompanyId ?? '')
                  : takesCompany
                    ? companyId
                    : '',
                role: takesRole
                  ? internalRecommendation
                  : sameAddress
                    ? (prior?.role ?? null)
                    : null,
                previousRole: sameAddress
                  ? (prior?.previousRole ?? INTERNAL_DEAL_ROLES[0].value)
                  : internalRole,
              };
            }}
          />

          <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
            Company
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setCompanyTouched(true);
                setCompanyRolePolicy(null);
                setExternalCompanyRole(COMPANY_ROLE.MEMBER);
                setDomainConfirmation(null);
              }}
              disabled={companyFixed}
              aria-describedby={companyReasonIds}
              className="rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[9px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-70"
            >
              {!companyFixed && <option value="">Select a company</option>}
              {options.map((o) => (
                <option key={o.companyId} value={o.companyId}>
                  {o.companyName}
                </option>
              ))}
            </select>
          </label>

          {recipientMode && selectedOption && !isBankTarget ? <RecipientAffiliationFields value={affiliation} representedCompanyId={representedCompanyId} companyId={companyId} parties={roster.parties} onChange={(value,represented)=>{setAffiliation(value);setRepresentedCompanyId(represented);}}/> : null}
          {recipientMode ? <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Start with the lowest access. If the advisor’s firm is not listed, ask the deal lead to add that firm as a party on this deal. Adding a counterparty will still require confirmation on future emails.</p> : null}
          {viewerLocked ? (
            <p id={lockedReasonId} className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              Invitees join your firm as members on this deal.
            </p>
          ) : isBankTarget ? (
            <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
              Role
              <select
                value={internalRole}
                onChange={(e) => {
                  setInternalRole(e.target.value);
                  setRoleTouched(true);
                  setDomainConfirmation(null);
                }}
                className="rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[9px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {INTERNAL_DEAL_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          ) : roleBlocked ? (
            <p
              role="alert"
              className="rounded-[var(--radius-card)] border border-[var(--hold-fill)] bg-[var(--hold-tint)] p-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink)]"
            >
              This company has no active director. A firm admin must send its first
              Company Director invitation.
            </p>
          ) : (
            <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
              Role
              <select
                value={externalCompanyRole}
                onChange={(e) => {
                  setExternalCompanyRole(e.target.value);
                  setDomainConfirmation(null);
                }}
                className="rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[9px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {activeCompanyRolePolicy?.memberAllowed !== false ? (
                  <option value={COMPANY_ROLE.MEMBER}>Member</option>
                ) : null}
                {activeCompanyRolePolicy?.directorAllowed !== false ? (
                  <option value={COMPANY_ROLE.DIRECTOR}>Director</option>
                ) : null}
              </select>
            </label>
          )}

          {!viewerLocked && activeCompanyRolePolicy?.requiresDirector && !roleBlocked ? (
            <p className="text-[length:var(--text-xs)] text-[var(--hold-deep)]">
              This company has no active director. Its first user must join as
              Company Director.
            </p>
          ) : null}

          {!viewerLocked && selectedOption && !selectedOption.isBank ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              People at this firm take the {selectedOption.externalDealRole} seat on
              this deal.
            </p>
          ) : null}

          {/* Phase gates external seats only, so an internal invitation shows
              no control: the server pins those to phase 0 regardless. With no
              company selected yet there is no seat to phase, so the control
              appears once the invitation has a company. The value sent is
              still the phase number; people pick it by phase name. */}
          {(viewerLocked || selectedOption) && !isBankTarget ? (
            <label className="flex flex-col gap-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
              Access up to
              <select
                value={phase}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  // Marks the value as the inviter's own, so a later
                  // recommendation neither overwrites it nor withdraws it.
                  setPhaseTouched(true);
                  setPhase(Number.isNaN(next) || next < 0 ? 0 : next);
                  setDomainConfirmation(null);
                }}
                className="rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[9px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {phaseOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {/* Asks only once there is an address to ask about: Team's invite
              starts with its firm already set, so an empty form would
              otherwise ask with no email and show the refusal. */}
          {!roleBlocked && LOOKS_LIKE_EMAIL.test(email.trim().toLowerCase()) ? (
            <PerimeterPreview
              mode="proposal"
              email={email}
              companyId={companyId || null}
              companyRole={
                viewerLocked || isBankTarget ? COMPANY_ROLE.MEMBER : externalCompanyRole
              }
              dealId={dealId}
              dealRole={
                isBankTarget ? internalRole : (selectedOption?.externalDealRole ?? 'seller')
              }
              phase={phase}
            />
          ) : null}

          {domainConfirmation ? (
            <div
              role="alert"
              className="rounded-[var(--radius-card)] border border-[var(--hold-fill)] bg-[var(--hold-tint)] p-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink)]"
            >
              {domainConfirmation.classification === 'mismatch'
                ? 'This email domain does not match the company record.'
                : domainConfirmation.classification === 'personal'
                  ? 'This is a personal email address, not a company address.'
                  : 'This company has no verified email domain.'}{' '}
              Confirm the recipient and company before sending.
            </div>
          ) : null}

          {error ? (
            <div className="flex items-center gap-[var(--space-3)]">
              <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative,red)]">
                {error}
              </p>
              {duplicateInviteId ? (
                <button
                  type="button"
                  onClick={() => {
                    void onResend(duplicateInviteId).then((result) => {
                      if (result.ok && result.deliveryStatus === 'sent') {
                        setCreated({
                          id: duplicateInviteId,
                          email: email.trim(),
                          deliveryStatus: 'sent',
                        });
                      } else {
                        setError(result.error ?? RESEND_UNDELIVERED);
                      }
                    });
                  }}
                  className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  Resend
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

export default InviteModal;
