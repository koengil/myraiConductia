'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog } from '@/components/overlay';
import { COMPANY_ROLE } from '@/lib/constants/roles';

export type InvitePendingConfirm = {
  confirmationId: string;
  classification: string;
  email: string;
};

export interface InviteMemberDialogProps {
  open: boolean;
  onClose: () => void;
  email: string;
  role: string;
  onEmailChange: (email: string) => void;
  onRoleChange: (role: string) => void;
  canManage: boolean;
  /** The inviter is an outside party (any role): their invites are member seats, called employees. */
  isExternal: boolean;
  busy: boolean;
  pendingConfirm: InvitePendingConfirm | null;
  onSubmit: (event: React.FormEvent) => void;
  onConfirmSend: () => void;
  onCancelConfirm: () => void;
}

const INVITE_ROLE_COPY = {
  /** Bank side: the two firm roles are never invite roles (no API sets them). */
  firmRoles:
    'Chief Compliance Officer and Administrator are set by Conductia when your firm is set up, not by invitation. To change one, contact Conductia.',
  /** Outside party: the server makes every invite from an outside party a member seat. */
  outsideParty: 'People you invite join as employees. To add another director, ask the bank running your deal.',
} as const;

/**
 * The roles an invite may carry, exactly as POST /api/v1/invites grants them:
 * Director only for a firm administrator or this company's director, and
 * never for an outside party (the server makes their invites members).
 */
function inviteRoleOptions(
  canManage: boolean,
  isExternal: boolean,
): { value: string; label: string }[] {
  if (isExternal) return [{ value: COMPANY_ROLE.MEMBER, label: 'Employee' }];
  const member = { value: COMPANY_ROLE.MEMBER, label: 'Member' };
  return canManage ? [member, { value: COMPANY_ROLE.DIRECTOR, label: 'Director' }] : [member];
}

const fieldClass =
  'w-full rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-3)] py-[6px] text-[length:var(--text-sm)] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const labelClass = 'text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]';

/**
 * Invite someone to this organization (Settings › Organization, "+").
 * Offers only the roles the server grants, and says how the firm roles that
 * are not invite roles get assigned.
 */
export function InviteMemberDialog({
  open,
  onClose,
  email,
  role,
  onEmailChange,
  onRoleChange,
  canManage,
  isExternal,
  busy,
  pendingConfirm,
  onSubmit,
  onConfirmSend,
  onCancelConfirm,
}: InviteMemberDialogProps) {
  const formId = React.useId();
  const title = isExternal ? 'Invite an employee' : 'Invite a member';
  const options = inviteRoleOptions(canManage, isExternal);
  const shownRole = options.find((option) => option.value === role) ?? options[0];

  // Never leave a role selected that this viewer cannot send.
  React.useEffect(() => {
    if (open && shownRole.value !== role) onRoleChange(shownRole.value);
  }, [onRoleChange, open, role, shownRole.value]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="Send an invitation to add someone to this organization."
      dismissOnScrim={false}
      footer={
        pendingConfirm ? null : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={busy}>
              Send invite
            </Button>
          </>
        )
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-[var(--space-3)]">
        <label className="flex flex-col gap-[var(--space-1)]">
          <span className={labelClass}>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="name@company.com"
            aria-label="Email address"
            className={fieldClass}
          />
        </label>
        {options.length > 1 ? (
          <label className="flex flex-col gap-[var(--space-1)]">
            <span className={labelClass}>Role</span>
            <select
              value={shownRole.value}
              onChange={(event) => onRoleChange(event.target.value)}
              aria-label="Company role"
              className={fieldClass}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
            <span className={labelClass}>Role </span>
            {shownRole.label}
          </p>
        )}
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {isExternal ? INVITE_ROLE_COPY.outsideParty : INVITE_ROLE_COPY.firmRoles}
        </p>
      </form>
      {pendingConfirm ? (
        <div className="mt-[var(--space-3)] rounded-[var(--radius-card)] border border-dashed border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)]">
          <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
            {pendingConfirm.email} does not match this company&apos;s verified domains (
            {pendingConfirm.classification}). Confirm the address before it is sent.
          </p>
          <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-2)]">
            <Button size="sm" variant="secondary" disabled={busy} onClick={onCancelConfirm}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={onConfirmSend}>
              Confirm and send
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export default InviteMemberDialog;
