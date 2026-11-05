'use client';

import * as React from 'react';

import { readAudit } from '@/lib/audit/store';
import { useFlag } from '@/lib/flags/FlagsContext';
import {
  resolveDeal,
  type ConflictsAttestation,
  type FixtureDeal,
} from '@/lib/rail/deals';
import { FIRM_ROLE, FIRM_ROLE_LABELS } from '@/lib/constants/roles';
import { RELATIONSHIP_PATHING_STEP_ID } from '@/lib/rail/dealRail';
import {
  GATE0_NOTIFY_STEP_ID,
  FIXTURE_GATE0_NOTIFY_RECIPIENTS,
  gate0NoticeText,
  notifyApprovedWhat,
  notifyRecipientsLabel,
} from '@/lib/rail/gate0';
import {
  pathingApprovedWhat,
  pathingApproverLabel,
} from '@/lib/rail/pathingCompletion';
import { skipApproverLabel } from '@/lib/rail/skipApproverLabel';

/** Rail step id for the code name (Gate 0 step 1). Satisfied when the deal exists. */
export const CODENAME_STEP_ID = 'p1-s7';

/** Rail step id for the Gate 0 compliance notification (mandatory on create). */
export const NOTIFY_STEP_ID = GATE0_NOTIFY_STEP_ID;

/** Rail step id for the conflicts checklist (Gate 0 step 2). */
export const CONFLICTS_STEP_ID = 'p1-s6';

/** Rail step id for the deal team (Gate 0 step 3). Satisfied when team is seated at intake. */
export const TEAM_STEP_ID = 'p2-s26';

export type NotifiedRecipient = {
  name: string;
  role?: string;
};

export type StepCompletionRecord = {
  source: 'gate0' | 'rail';
  approvedBy: string;
  approvedOn: string;
  /** Plain-language statement of what was approved or completed. */
  approvedWhat: string;
  /** Defaults to "Approved by" when omitted. */
  byLabel?: string;
  /** Defaults to "Approved on" when omitted. */
  onLabel?: string;
  /** Who marked the rail step complete, when that is a separate act. */
  completedBy?: string;
  completedOn?: string;
  /** Gate 0 notify — who received the screened notice. */
  notifiedRecipients?: NotifiedRecipient[];
  /** Gate 0 notify — the masked notice text that was screened and logged. */
  noticeText?: string;
  /** Gate 0 notify — MNPI screen verdict over the notice text. */
  screeningVerdict?: 'compliant' | 'hold' | 'blocked';
};

const CONFLICTS_APPROVED_WHAT =
  'The firm is allowed to run a sell-side mandate for this engagement. The conflicts checklist was completed off-platform and the senior partner approval is on record.';

/** Masked Gate 0 notice copy — must match POST /api/v1/deals screening input. */
export { gate0NoticeText } from '@/lib/rail/gate0';

function localDateFromIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Who opened the deal, only from a field the client already holds
 * (`deal.createdBy`, set on fixture and wizard-created deals). Never the
 * signed-in viewer and never a persona: with no creator on record the credit
 * reads "On record" and names no one (handoff E32, "Who opened the deal: a
 * creator name the rail can show").
 */
function creatorNameForDeal(deal: FixtureDeal): string {
  return deal.createdBy?.trim() || ON_RECORD;
}

/** Build a completion record from a stored Gate 0 conflicts attestation. */
export function conflictsCompletionFromAttestation(
  attestation: ConflictsAttestation,
): StepCompletionRecord {
  return {
    source: 'gate0',
    approvedBy: attestation.approvedBy,
    approvedOn: attestation.approvedOn,
    approvedWhat: CONFLICTS_APPROVED_WHAT,
  };
}

/** Fallback: parse the demo audit log entry the wizard writes on fixture create. */
export function conflictsCompletionFromAudit(dealCodename: string): StepCompletionRecord | null {
  const hit = readAudit().find(
    (e) =>
      e.kind === 'platform' &&
      e.action === 'Recorded conflicts approval' &&
      e.deal === dealCodename &&
      e.detail,
  );
  if (!hit?.detail) return null;
  const match = hit.detail.match(/^Approved by (.+) on (\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  return conflictsCompletionFromAttestation({
    approvedBy: match[1],
    approvedOn: match[2],
  });
}

/** The credit when a record exists but names no person (the intake attestation). */
export const ON_RECORD = 'On record';

export function conflictsCompletionForDeal(deal: FixtureDeal): StepCompletionRecord | null {
  if (deal.conflictsAttestation) {
    return conflictsCompletionFromAttestation(deal.conflictsAttestation);
  }
  if (deal.gate0Complete) {
    const audit = conflictsCompletionFromAudit(deal.codename);
    if (audit) return audit;
    // Mandatory at create — a Gate 0-complete deal always has this attestation on record.
    return {
      source: 'gate0',
      approvedBy: ON_RECORD,
      approvedOn: localDateFromIso(deal.createdAt) || '',
      approvedWhat: CONFLICTS_APPROVED_WHAT,
    };
  }
  return null;
}

export function codenameCompletionForDeal(deal: FixtureDeal): StepCompletionRecord | null {
  if (!deal.gate0Complete || !deal.codename.trim()) return null;
  const createdOn = localDateFromIso(deal.createdAt) || deal.conflictsAttestation?.approvedOn || '';
  return {
    source: 'gate0',
    approvedBy: creatorNameForDeal(deal),
    approvedOn: createdOn,
    approvedWhat: `The deal was opened under the code name ${deal.codename}. The masked identifier is on record for every external artifact.`,
    byLabel: 'Created by',
    onLabel: 'Created on',
  };
}

export function notifyCompletionForDeal(deal: FixtureDeal): StepCompletionRecord | null {
  if (!deal.gate0Complete || !deal.codename.trim()) return null;
  const recipients = [...FIXTURE_GATE0_NOTIFY_RECIPIENTS];
  const sentOn = localDateFromIso(deal.createdAt) || deal.conflictsAttestation?.approvedOn || '';
  return {
    source: 'gate0',
    approvedBy: notifyRecipientsLabel(recipients),
    approvedOn: sentOn,
    approvedWhat: notifyApprovedWhat(recipients),
    byLabel: 'Sent to',
    onLabel: 'Sent on',
    notifiedRecipients: recipients,
    noticeText: gate0NoticeText(deal.codename),
    screeningVerdict: 'compliant',
  };
}

/** Display name for who completed a step, on its card on the rail board. */
export function stepCompletedBy(
  deal: FixtureDeal,
  stepId: string,
  skip?: { approver: string; approverVerified?: boolean },
): string | null {
  if (skip?.approver) return skipApproverLabel(skip);
  if (stepId === CODENAME_STEP_ID) {
    return codenameCompletionForDeal(deal)?.approvedBy ?? null;
  }
  if (stepId === CONFLICTS_STEP_ID) {
    return conflictsCompletionForDeal(deal)?.approvedBy ?? null;
  }
  // Mandate activation completes through its manual checklist, never from
  // Gate 0 intake or the roster, and its card names no one.
  if (stepId === TEAM_STEP_ID) return null;
  if (stepId === NOTIFY_STEP_ID) {
    // Credit the MD who opened the deal when the deal names them, else "On
    // record"; the recipient list (a fixture off the API path) belongs to the
    // step panel.
    if (!notifyCompletionForDeal(deal)) return null;
    return creatorNameForDeal(deal);
  }
  // Execution stations: the platform's step record names the completer, or
  // the approver of a logged skip. Nothing is inferred from the cursor.
  const record = deal.stepRecords?.find((r) => r.stepId === stepId);
  if (record?.skip?.approver) return record.skip.approver;
  return record?.completedByName?.trim() || null;
}

export function stepCompletionForFixture(dealId: string, stepId: string): StepCompletionRecord | null {
  const deal = resolveDeal(dealId);
  if (!deal) return null;
  if (stepId === CODENAME_STEP_ID) return codenameCompletionForDeal(deal);
  if (stepId === CONFLICTS_STEP_ID) return conflictsCompletionForDeal(deal);
  if (stepId === NOTIFY_STEP_ID) return notifyCompletionForDeal(deal);
  return null;
}

/** Gate 0 steps satisfied at intake — drives the board's done markers synchronously. */
export function gate0IntakeCompleteStepIds(deal: FixtureDeal): ReadonlySet<string> {
  const ids = new Set<string>();
  if (codenameCompletionForDeal(deal)) ids.add(CODENAME_STEP_ID);
  if (conflictsCompletionForDeal(deal)) ids.add(CONFLICTS_STEP_ID);
  if (notifyCompletionForDeal(deal)) ids.add(NOTIFY_STEP_ID);
  return ids;
}

async function fetchApiConflicts(dealId: string): Promise<StepCompletionRecord | null> {
  const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    deal?: {
      codename?: string;
      created_at?: string | null;
      conflicts_approved_by?: string | null;
      conflicts_approved_on?: string | null;
    };
  };
  const by = body.deal?.conflicts_approved_by?.trim();
  const on = body.deal?.conflicts_approved_on?.trim();
  if (!by || !on) return null;
  return conflictsCompletionFromAttestation({ approvedBy: by, approvedOn: on });
}

async function fetchApiCodename(dealId: string): Promise<StepCompletionRecord | null> {
  const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    deal?: { codename?: string; created_at?: string | null };
  };
  const codename = body.deal?.codename?.trim();
  if (!codename) return null;
  return codenameCompletionForDeal(
    {
      id: dealId,
      codename,
      code: dealId,
      target: '',
      sector: '',
      status: 'Intake',
      cursorStepId: CODENAME_STEP_ID,
      entryStepSeq: 12,
      gate0Complete: true,
      dealRole: 'Managing Director',
      createdAt: body.deal?.created_at ?? undefined,
    },
  );
}

type ApiGate0Notification = {
  at?: string | null;
  recipientName?: string | null;
  recipientRole?: string | null;
  payload?: {
    actor?: string;
    screening?: { verdict?: string };
  };
};

function recipientRoleLabel(role: string | null | undefined): string | undefined {
  if (!role) return undefined;
  if (role === FIRM_ROLE.CCO) return FIRM_ROLE_LABELS[FIRM_ROLE.CCO];
  return role.replace(/_/g, ' ');
}

async function fetchApiNotify(dealId: string): Promise<StepCompletionRecord | null> {
  const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    deal?: { codename?: string; created_at?: string | null };
    gate0Notifications?: ApiGate0Notification[];
  };
  const codename = body.deal?.codename?.trim();
  if (!codename) return null;

  const rows = body.gate0Notifications ?? [];
  const first = rows[0];
  const sentAt = first?.at ?? body.deal?.created_at ?? undefined;
  const verdict = first?.payload?.screening?.verdict;
  const screeningVerdict =
    verdict === 'hold' || verdict === 'blocked' || verdict === 'compliant'
      ? verdict
      : 'compliant';

  const notifiedRecipients = rows.map((row) => ({
    name: row.recipientName?.trim() || 'Compliance officer',
    role: recipientRoleLabel(row.recipientRole),
  }));

  return {
    source: 'gate0',
    approvedBy: notifyRecipientsLabel(notifiedRecipients),
    approvedOn: localDateFromIso(sentAt) || '',
    approvedWhat: notifyApprovedWhat(notifiedRecipients),
    byLabel: 'Sent to',
    onLabel: 'Sent on',
    notifiedRecipients,
    noticeText: gate0NoticeText(codename),
    screeningVerdict,
  };
}

const GATE0_COMPLETION_STEPS = new Set([
  CODENAME_STEP_ID,
  CONFLICTS_STEP_ID,
  TEAM_STEP_ID,
  NOTIFY_STEP_ID,
]);

type ApiParty = {
  party_role?: string;
  company?: { id?: string } | { id?: string }[] | null;
};

async function fetchApiPathing(dealId: string): Promise<StepCompletionRecord | null> {
  const [stepRes, dealRes] = await Promise.all([
    fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/steps/${RELATIONSHIP_PATHING_STEP_ID}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
    fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
  ]);
  if (!stepRes.ok || !dealRes.ok) return null;

  const stepBody = (await stepRes.json()) as {
    step?: { completedByName?: string | null; completedAt?: string | null };
  };
  const dealBody = (await dealRes.json()) as { parties?: ApiParty[] };
  const target = (dealBody.parties ?? []).find((party) => party.party_role === 'target');
  const rawCompany = target?.company;
  const company = Array.isArray(rawCompany) ? rawCompany[0] : rawCompany;
  const companyId = company?.id?.trim();
  if (!companyId) return null;

  const [stkRes, relRes, pathRes] = await Promise.all([
    fetch(`/api/v1/companies/${companyId}/stakeholders`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
    fetch(`/api/v1/companies/${companyId}/relationships`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
    fetch(`/api/v1/companies/${companyId}/paths`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
  ]);

  const stakeholders = stkRes.ok
    ? (((await stkRes.json()) as { stakeholders?: { id: string; name: string }[] }).stakeholders ??
      [])
    : [];
  const relationships = relRes.ok
    ? (((await relRes.json()) as { relationships?: { id: string; person_name: string }[] })
        .relationships ?? [])
    : [];
  const paths = pathRes.ok
    ? (((await pathRes.json()) as {
        paths?: {
          approved: boolean;
          path_type: string;
          stakeholder_id: string;
          relationship_id: string | null;
          approved_by?: string | null;
          approved_on?: string | null;
        }[];
      }).paths ?? [])
    : [];

  const approved = paths.filter((path) => path.approved);
  if (!approved.length && !stepBody.step?.completedAt) return null;

  const approver = pathingApproverLabel(approved);
  return {
    source: 'rail',
    approvedBy: approver.approvedBy,
    approvedOn: approver.approvedOn,
    approvedWhat: pathingApprovedWhat(approved, stakeholders, relationships),
    byLabel: 'Path approved by',
    onLabel: 'Path approved on',
    completedBy: stepBody.step?.completedByName?.trim() || undefined,
    completedOn: localDateFromIso(stepBody.step?.completedAt ?? undefined) || undefined,
  };
}

export type StepCompletionState = {
  record: StepCompletionRecord | null;
  /** True while the live record is in flight — do not render the empty step body. */
  loading: boolean;
};

/** Resolve what was done for a step — Gate 0 intake first, then fixture fallbacks. */
export function useStepCompletionState(
  dealId: string,
  stepId: string,
): StepCompletionState {
  const apiEnabled = useFlag('gate0_api_create');

  const isGate0Step = GATE0_COMPLETION_STEPS.has(stepId);
  const isPathingStep = stepId === RELATIONSHIP_PATHING_STEP_ID;
  const isTrackedStep = isGate0Step || isPathingStep;
  const syncRecord = React.useMemo(
    () =>
      isGate0Step
        ? stepCompletionForFixture(dealId, stepId)
        : null,
    [isGate0Step, dealId, stepId],
  );

  const [fetched, setFetched] = React.useState<{
    dealId: string;
    stepId: string;
    record: StepCompletionRecord | null;
  } | null>(null);

  React.useEffect(() => {
    if (!isTrackedStep) return;

    let active = true;

    void (async () => {
      let next: StepCompletionRecord | null = null;
      if (apiEnabled) {
        try {
          next =
            stepId === CONFLICTS_STEP_ID
              ? await fetchApiConflicts(dealId)
              : stepId === NOTIFY_STEP_ID
                ? await fetchApiNotify(dealId)
                : stepId === CODENAME_STEP_ID
                  ? await fetchApiCodename(dealId)
                  : stepId === RELATIONSHIP_PATHING_STEP_ID
                    ? await fetchApiPathing(dealId)
                    : null;
        } catch {
          // Fall through to fixture projection.
        }
      }
      if (!next && isGate0Step) {
        // Never the viewer: with no creator on the deal the credit is "On record".
        next = stepCompletionForFixture(dealId, stepId);
      }
      if (active) setFetched({ dealId, stepId, record: next });
    })();

    return () => {
      active = false;
    };
  }, [apiEnabled, dealId, stepId, isGate0Step, isTrackedStep]);

  if (!isTrackedStep) return { record: null, loading: false };

  const resolved = fetched?.dealId === dealId && fetched?.stepId === stepId;
  return {
    record: resolved ? fetched.record : syncRecord,
    loading: Boolean(apiEnabled && !resolved),
  };
}

export function useStepCompletion(
  dealId: string,
  stepId: string,
): StepCompletionRecord | null {
  return useStepCompletionState(dealId, stepId).record;
}
