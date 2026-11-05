import {
  COMPANY_ROLE,
  COMPANY_ROLE_LABELS,
  FIRM_ROLE,
  FIRM_ROLE_LABELS,
} from '@/lib/constants/roles';

/** Gate 0 mandate intake — the first three steps on the deal rail (code name,
 *  conflicts, notify). The modal wizard still includes team assignment during
 *  create; the full mandate activation checklist runs at Phase 2 Seq 26. */
export const GATE0_MODAL_ENTRY_ENABLED = true;

export const GATE0_NOTIFY_STEP_ID = 'g0-notify';

/** Mandate intake step ids in wizard order (code name → conflicts → notify).
 *  Team assignment and full mandate activation run at Phase 2 Seq 26. */
export const GATE0_STEP_IDS = [
  'p1-s7',
  'p1-s6',
  GATE0_NOTIFY_STEP_ID,
] as const;

export type Gate0StepId = (typeof GATE0_STEP_IDS)[number];

export const GATE0_STEP_ID_SET = new Set<string>(GATE0_STEP_IDS);

/** Masked Gate 0 notice copy — must match POST /api/v1/deals screening input. */
export function gate0NoticeText(codename: string): string {
  return `Gate 0 notice: mandate intake opened under code name ${codename.trim()}.`;
}

export type Gate0NotifyRecipient = {
  id?: string;
  name: string;
  role?: string;
};

/** Seed / flag-off preview — the tenant CCO in scripts/seed-data.ts. */
export const FIXTURE_GATE0_NOTIFY_RECIPIENTS: readonly Gate0NotifyRecipient[] = [
  { name: 'Pat Rivera', role: FIRM_ROLE_LABELS[FIRM_ROLE.CCO] },
];

export const MISSING_CCO_LABEL =
  'No one is assigned to receive new-mandate notices';

export const NOTIFY_APPROVED_WHAT = 'Compliance was notified that a new mandate opened';

export const MISSING_CCO_NOTICE =
  'No one was assigned to receive new-mandate notices when this mandate opened. Nobody received the Gate 0 notice.';

export function gate0NotifyRoleLabel(recipient: {
  firm_role?: string | null;
  company_role?: string | null;
}): string {
  if (recipient.firm_role === FIRM_ROLE.CCO) return FIRM_ROLE_LABELS[FIRM_ROLE.CCO];
  if (recipient.firm_role === FIRM_ROLE.ADMIN) {
    return FIRM_ROLE_LABELS[FIRM_ROLE.ADMIN];
  }
  if (recipient.company_role === COMPANY_ROLE.DIRECTOR) {
    return COMPANY_ROLE_LABELS[COMPANY_ROLE.DIRECTOR];
  }
  return 'Compliance';
}

export function notifyRecipientsLabel(
  recipients: readonly Gate0NotifyRecipient[],
): string {
  if (recipients.length === 0) return MISSING_CCO_LABEL;
  return recipients.map((recipient) => recipient.name).join(', ');
}

export function notifyApprovedWhat(
  recipients: readonly Gate0NotifyRecipient[],
): string {
  return recipients.length === 0 ? MISSING_CCO_NOTICE : NOTIFY_APPROVED_WHAT;
}

/** Tenant CCOs on the bank roster — the same people create_deal_gate0 notifies. */
export function complianceOfficersFromRoster(
  members: readonly {
    id?: string;
    firm_role?: string | null;
    display_name?: string | null;
    full_name?: string | null;
    email?: string;
  }[],
): Gate0NotifyRecipient[] {
  return members
    .filter((member) => member.firm_role === FIRM_ROLE.CCO)
    .map((member) => ({
      id: member.id,
      name:
        member.display_name?.trim() ||
        member.full_name?.trim() ||
        member.email?.trim() ||
        'Compliance officer',
      role: FIRM_ROLE_LABELS[FIRM_ROLE.CCO],
    }));
}
