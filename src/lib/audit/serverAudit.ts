'use client';

/**
 * Server audit projection — the append-only audit_log made screen-ready.
 *
 * GET /api/v1/deals/{idOrCode}/audit returns the deal's platform audit rows
 * (create, attest, grant/revoke, notify, advance, document views, holds).
 * This module fetches them and maps each row onto the AuditEvent display
 * shape the Audit Trail already renders, so platform events and the local
 * demo log merge into one register.
 *
 * A fixture deal (project-summit) is not in Postgres, so the endpoint 404s:
 * the caller gets an empty trail and the view stays local-only. Any other
 * failure resolves null, which the view states as a failure.
 */

import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';
import { formatDate } from '@/lib/format/date';
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps, stepBySeq } from '@/lib/rail/dealRail';
import type { AuditEvent, AuditKind } from './store';

type ServerActor = {
  id: string;
  full_name: string | null;
  display_name: string | null;
};

export type ServerAuditRow = {
  id: string;
  ts: string;
  action: string;
  document_id: string | null;
  detail: Record<string, unknown> | null;
  actor: ServerActor | ServerActor[] | null;
};

export type ServerAuditResponse = {
  deal: { id: string; code: string; codename: string };
  events: ServerAuditRow[];
};

function actorName(actor: ServerAuditRow['actor']): string | null {
  const a = Array.isArray(actor) ? actor[0] : actor;
  if (!a) return null;
  return a.display_name || a.full_name || null;
}

function str(detail: Record<string, unknown> | null, key: string): string {
  const v = detail?.[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

// The accept request's target: counts only (messageCount, sourceCount), never the deal key or a name.
function requestTarget(detail: Record<string, unknown> | null): string {
  const emails = str(detail, 'messageCount');
  if (!emails) return 'Model proposal';
  const sources = str(detail, 'sourceCount');
  const base = `${emails} ${emails === '1' ? 'email' : 'emails'}`;
  return sources ? `${base} from ${sources} ${sources === '1' ? 'source' : 'sources'}` : base;
}

const CATALOG_STEP_TITLES = new Map(
  [...orderedSteps(DEAL_RAIL), ...orderedSteps(MVP_DEAL_RAIL)].map((step) => [step.id, step.title]),
);

const RAIL_ACTION_LABEL: Record<string, string> = {
  remove: 'Removed a step',
  restore: 'Restored a step',
  skip: 'Skipped a step',
};

const RAIL_TEMPLATE_ACTION_LABEL: Record<string, string> = {
  'rail.template_created': 'Saved the rail as a template',
  'rail.template_replaced': 'Replaced a saved rail template',
  'rail.template_applied': 'Created the deal from a rail template',
};

function railStepName(
  detail: Record<string, unknown> | null,
  keyField: string,
  titleField: string,
): string {
  return str(detail, titleField) || CATALOG_STEP_TITLES.get(str(detail, keyField)) || '';
}

/**
 * One end of an advance, by step name: the recorded title, else the
 * catalogue title of its step key. A legacy row (the progress route) records
 * canonical seqs only, so its seq is named from the census; a row that
 * records step keys is never named by seq, because a deal's own rail can
 * number its steps differently. The number is the fallback, never the label.
 */
function railPosition(detail: Record<string, unknown> | null, side: 'from' | 'to'): string {
  const named = railStepName(detail, `${side}StepKey`, `${side}Title`);
  if (named) return named;
  const seq = str(detail, side);
  if (seq && !Object.hasOwn(detail ?? {}, `${side}StepKey`)) {
    const census = stepBySeq(Number(seq), DEAL_RAIL)?.title;
    if (census) return census;
  }
  return seq ? `Step ${seq}` : 'No active step';
}

function advanceTarget(detail: Record<string, unknown> | null): string {
  const from = railPosition(detail, 'from');
  const to = railPosition(detail, 'to');
  // Two bare numbers keep the short form ("Step 11 → 12").
  const bare = /^Step (\S+)$/;
  const [f, t] = [bare.exec(from), bare.exec(to)];
  if (f && t) return `Step ${f[1]} → ${t[1]}`;
  return `${from} → ${to}`;
}

/** A stored calendar day ("2027-03-26") as a US date, read in UTC so it never shifts a day. */
function usDay(value: string): string {
  return formatDate(value, { timeZone: 'UTC' }) || value;
}

/** A seat's deal role in words ("md" → "Managing Director"); an unknown role is printed as written. */
function seatLabel(detail: Record<string, unknown> | null): string {
  const raw = str(detail, 'deal_role');
  if (!raw) return 'Deal seat';
  return `Seat · ${Object.hasOwn(DEAL_ROLE_LABELS, raw) ? DEAL_ROLE_LABELS[raw as DealRole] : raw}`;
}

const BOOK_FIELD_LABEL: Record<string, string> = {
  target_close_date: 'Target close date',
  fee_usd: 'Fee',
  schedule_status: 'Schedule status',
  lifecycle_category: 'Lifecycle category',
};

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function bookValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (field === 'fee_usd') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? USD.format(n) : String(value);
  }
  const text = String(value);
  if (field === 'target_close_date') return usDay(text);
  if (field === 'schedule_status' || field === 'lifecycle_category') {
    const words = text.replaceAll('_', ' ');
    return words[0].toUpperCase() + words.slice(1);
  }
  return text;
}

/** A hold cause in words. An unrecognized cause is printed as written,
 *  never upgraded to a named category. */
function holdCauseLabel(cause: string): string {
  if (cause === 'mnpi') return 'MNPI';
  if (cause === 'reputational') return 'reputational risk';
  return cause.replaceAll('_', ' ');
}

/** The screen row of a flagged message the sender sent anyway (the glossary
 *  wording); the send row reads "Sent despite a compliance flag". */
function flaggedSentAnyway(cause: string): string {
  return `Flagged at screening${cause ? ` (${holdCauseLabel(cause)})` : ''}, sent anyway`;
}

/**
 * A mail screen row's verdict in words. Routing truth (#158 decision 2): only
 * an MNPI hold enters the supervisory queue; a reputational soft hold returns
 * to the sender, unless the override marker shows the sender sent it as
 * written. A blocked message also returns to the sender; whether a rewrite
 * rode along is not in the record, so it is never asserted. An unrecognized
 * verdict is printed as written.
 */
function screenVerdictLabel(verdict: string, cause: string, sentAsIs: boolean, returned: boolean): string {
  if (verdict === 'hold') {
    if (sentAsIs) return flaggedSentAnyway(cause);
    const held = `Held${cause ? ` (${holdCauseLabel(cause)})` : ''}`;
    if (cause === 'reputational' || returned) return `${held}, returned to sender`;
    return `${held}, sent to supervisory review`;
  }
  if (verdict === 'blocked') return sentAsIs ? flaggedSentAnyway('') : 'Blocked, returned to sender';
  if (verdict === 'compliant') return 'Compliant';
  return verdict;
}

/**
 * A discovery correction's stored action name (`detail.action`, or `correction` on older rows) in words. The stored
 * names stay as the SQL writes them; an unknown one is printed as written, underscores as spaces.
 */
const CORRECTION_LABEL: Record<string, string> = {
  rename: 'Renamed the deal',
  reject: 'Rejected the proposed deal',
  set_station: 'Set the step',
  override_station: 'Overrode the step',
  merge: 'Merged into another proposed deal',
  split: 'Split off emails',
  reassign: 'Moved an email',
  dismiss_suggestion: 'Dismissed the suggestion',
  accept_proposal: 'Accepted the model proposal',
};

function correctionLabel(action: string): string {
  return CORRECTION_LABEL[action] ?? action.replaceAll('_', ' ');
}

/** Where a stage assessment's events came from, as discovery_record_assessment records it (20261023130100). */
function stageBasisLabel(basis: string): string {
  switch (basis) {
    case 'model':
      return 'from the model';
    case 'rules':
      return 'from rules';
    case 'mixed':
      return 'from model and rules';
    default:
      return '';
  }
}

/**
 * action → { kind, human action label, target builder }. Exported for the firm-level team inbox audit trail
 * (src/lib/audit/firmAudit.ts, #173 G-03), which takes the action label from here so both trails say the same thing.
 */
export function describeAuditRow(row: ServerAuditRow): {
  kind: AuditKind;
  action: string;
  target: string;
} {
  const d = row.detail ?? null;
  switch (row.action) {
    case 'create':
      if (str(d, 'kind') === 'skill_run') {
        const outcome = str(d, 'outcome');
        return {
          kind: 'platform',
          action: outcome ? 'Ran a skill on a step' : 'Started a skill on a step',
          target: [railStepName(d, 'stepKey', 'title') || 'This step', outcome]
            .filter(Boolean)
            .join(' · '),
        };
      }
      if (str(d, 'kind') === 'skill_run_revision') {
        const outcome = str(d, 'outcome');
        return {
          kind: 'platform',
          action: !outcome
            ? 'Started revising a skill output'
            : str(d, 'revisionKind') === 'restore'
              ? 'Restored a version of a skill output'
              : 'Revised a skill output',
          target: [railStepName(d, 'stepKey', 'title') || 'This step', outcome]
            .filter(Boolean)
            .join(' · '),
        };
      }
      if (str(d, 'kind') === 'agent_run') {
        const depth = str(d, 'depth');
        return {
          kind: 'platform',
          action: 'Ran an Ignatious skill',
          target: [str(d, 'agent'), depth, str(d, 'executionId')].filter(Boolean).join(' · '),
        };
      }
      return {
        kind: 'platform',
        action: 'Created the mandate',
        target: str(d, 'codename') || 'Mandate',
      };
    case 'attest':
      return {
        kind: 'platform',
        action: 'Recorded conflicts approval',
        target: `Approved by ${str(d, 'approved_by') || 'senior partner'} on ${str(d, 'approved_on') ? usDay(str(d, 'approved_on')) : 'record'}`,
      };
    case 'grant':
      return {
        kind: 'platform',
        action: 'Granted deal access',
        target: seatLabel(d),
      };
    case 'revoke':
      return {
        kind: 'platform',
        action: 'Revoked deal access',
        target: seatLabel(d),
      };
    case 'notify': {
      // Humanize the event enum for visible copy ('deal_created' → 'Deal created').
      const event = str(d, 'event').replaceAll('_', ' ');
      return {
        kind: 'platform',
        action: 'Notified compliance',
        target: event ? event[0].toUpperCase() + event.slice(1) : 'Compliance notice',
      };
    }
    case 'advance':
      if (str(d, 'kind') === 'skip') {
        // A logged skip (Finding 5): the approver and reason are the record.
        // The logged skip stores the raw deal role (#312); older rows hold free text.
        const rawRole = str(d, 'approverRole');
        const role = Object.hasOwn(DEAL_ROLE_LABELS, rawRole)
          ? DEAL_ROLE_LABELS[rawRole as DealRole]
          : rawRole;
        return {
          kind: 'platform',
          action: 'Skipped a step',
          target: [
            str(d, 'stepTitle') || str(d, 'stepId') || 'Step',
            `approved by ${str(d, 'approver') || 'approver'}${role ? ` (${role})` : ''}`,
            str(d, 'reason'),
          ]
            .filter(Boolean)
            .join(' · '),
        };
      }
      return {
        // 'platform', not 'step': the local rail log already carries the rich
        // user action (Marked complete / Skipped + approver + reason) under
        // the Steps filter. This row is the platform state change; keeping
        // the kinds distinct stops one advance counting twice in one filter.
        kind: 'platform',
        action: 'Advanced the rail',
        target: advanceTarget(d),
      };
    case 'view':
      return {
        kind: 'dataroom',
        action: 'Viewed a document',
        target: str(d, 'name') || row.document_id || 'Document',
      };
    case 'download':
    case 'upload':
    case 'export':
      return {
        kind: 'file',
        action: `${row.action[0].toUpperCase()}${row.action.slice(1)}ed a document`,
        target: str(d, 'name') || row.document_id || 'Document',
      };
    // Step actions from the steps route. The assignee is an id in the detail
    // and is never printed; the step is named by its title.
    case 'assign_step':
      return { kind: 'platform', action: 'Assigned a step', target: railStepName(d, 'stepId', 'stepTitle') || 'Step' };
    case 'complete_step':
      return { kind: 'platform', action: 'Completed a step', target: railStepName(d, 'stepId', 'stepTitle') || 'Step' };
    case 'step_work':
      return { kind: 'platform', action: 'Saved work on a step', target: railStepName(d, 'stepId', 'stepTitle') || 'Step' };
    // Invitation safeguards. The override row carries the invitee's
    // email; the challenge rows carry ids only.
    case AUDIT_ACTION.INVITE_DOMAIN_OVERRIDE:
      return {
        kind: 'platform',
        action: 'Confirmed an unverified email domain for an invitation',
        target: str(d, 'email') || 'Invitation',
      };
    case AUDIT_ACTION.INVITE_CHALLENGE_ISSUED:
      return { kind: 'platform', action: 'Issued an invitation challenge', target: str(d, 'email') || 'Invitation' };
    case AUDIT_ACTION.INVITE_CHALLENGE_ROTATED:
      return { kind: 'platform', action: 'Rotated an invitation challenge', target: str(d, 'email') || 'Invitation' };
    case 'hold_placed':
      return { kind: 'platform', action: 'Placed legal hold', target: 'Deal record frozen' };
    case 'hold_lifted':
      return { kind: 'platform', action: 'Lifted legal hold', target: 'Deal record released' };
    // The compliant mail channel (#126/#158): screen = the pre-send gate's
    // verdict; send = the message left; release/reject = supervisory review.
    // The ephemeral heat score is never in these rows by design.
    case 'screen': {
      // The model's second compliance check on a sent message: state only the
      // outcome it recorded, never a verdict it did not write.
      if (str(d, 'mode') === 'second_opinion') {
        const outcome = str(d, 'outcome').replaceAll('_', ' ');
        return {
          kind: 'platform',
          action: 'Second compliance check recorded',
          target: outcome ? outcome[0].toUpperCase() + outcome.slice(1) : '',
        };
      }
      const verdict = str(d, 'verdict');
      // Only mail-shaped rows speak the mail vocabulary. The positive
      // discriminator is the mail writers' `mode` field — a verdict key alone
      // is not enough (the legacy spine's COMPLIANCE_VERDICT detail also
      // carries one), and dressing a spine row up would fabricate a screen
      // that never ran.
      if (!verdict || !str(d, 'mode')) break;
      const signOffs = Array.isArray(d?.preApproved) ? d.preApproved.length : 0;
      const sentAsIs = d?.sentAsIs === true || Boolean(str(d, 'override'));
      const label = screenVerdictLabel(verdict, str(d, 'holdCause'), sentAsIs, d?.returned === true);
      const aiCheck =
        d?.llmChecked === true
          ? 'AI-checked'
          : verdict === 'blocked'
            ? 'rules-decided'
            : 'not AI-checked';
      // A replayed row (#192 slice 2b) ran no screen of its own: it applies
      // the first screen's read, so the AI claim belongs to THAT screen.
      const aiPart = d?.replayed === true ? `first screen applied (${aiCheck})` : aiCheck;
      const parts = [
        label,
        aiPart,
        ...(signOffs ? [`${signOffs} flagged term${signOffs > 1 ? 's' : ''} signed off`] : []),
      ];
      return { kind: 'platform', action: 'Screened an outbound message', target: parts.join(' · ') };
    }
    case 'send': {
      const recipients = str(d, 'recipients');
      // The sender's own override is the row's headline: the record shows a
      // person chose to send past a flag (D80 keeps the decision, never the
      // heat score). Legacy rows carry the cause in `override`.
      const sentAsIs = d?.sentAsIs === true || Boolean(str(d, 'sentAsIs')) || Boolean(str(d, 'override'));
      const flaggedFor = str(d, 'holdCause') || str(d, 'override');
      const parts = [
        recipients ? `${recipients} recipient${recipients === '1' ? '' : 's'}` : 'Message',
        ...(str(d, 'provider') ? [`via ${str(d, 'provider')}`] : []),
        ...(d?.released === true ? ['released by reviewer'] : []),
        ...(sentAsIs && flaggedFor ? [`flagged for ${holdCauseLabel(flaggedFor)}`] : []),
        ...(d?.sentAsIsRequested === true || str(d, 'overrideRequested')
          ? ['sender asked to send anyway, recheck found no flag']
          : []),
        // D85: the sender approved recipients marked Needs approval.
        ...(d?.recipientOverride === true ? ['sender approved recipients marked Needs approval'] : []),
        ...(d?.simulated === true ? ['simulated'] : []),
      ];
      return {
        kind: 'platform',
        action: sentAsIs ? 'Sent despite a compliance flag' : 'Sent an outbound message',
        target: parts.join(' · '),
      };
    }
    case 'release':
      return {
        kind: 'platform',
        action: 'Released from supervisory review',
        target: str(d, 'note') || 'Held message approved and sent by the reviewer',
      };
    case 'reject':
      return {
        kind: 'platform',
        action: 'Rejected in supervisory review',
        target: str(d, 'note') || 'Returned to the sender',
      };
    case 'update': {
      const railAction = RAIL_ACTION_LABEL[str(d, 'rail')];
      if (railAction) {
        return { kind: 'platform', action: railAction, target: railStepName(d, 'stepKey', 'title') };
      }
      const field = str(d, 'field');
      if (!field) break;
      const label = BOOK_FIELD_LABEL[field] ?? field.replaceAll('_', ' ');
      const from = bookValue(field, d?.from ?? null);
      const to = bookValue(field, d?.to ?? null);
      return {
        kind: 'platform',
        action: 'Updated the Book record',
        target: from === to ? `${label} · ${to} (unchanged)` : `${label} · ${from} → ${to}`,
      };
    }
    // Saved rail templates (#231). Written by SQL on the source deal or the
    // deal created from the template; the detail carries ids and counts only.
    case 'rail.template_created':
    case 'rail.template_replaced':
    case 'rail.template_applied':
      return {
        kind: 'platform',
        action: RAIL_TEMPLATE_ACTION_LABEL[row.action],
        target: str(d, 'stepCount') ? `${str(d, 'stepCount')} steps` : 'Rail template',
      };
    // Deal discovery (Q13). A model row names the model as the actor; the
    // target names what was decided, never item text.
    case 'discovery.candidate_proposed':
      return {
        kind: 'platform',
        action: 'Proposed a deal candidate',
        target: str(d, 'name') || str(d, 'candidateId') || 'Deal candidate',
      };
    case 'discovery.candidate_promoted':
      return {
        kind: 'platform',
        action: 'Promoted a candidate to this deal',
        target:
          railStepName(d, 'chosenStepId', 'chosenStepTitle') || str(d, 'candidateId') || 'Deal candidate',
      };
    // The SQL writes `detail.action` (rename, reject, set_station, merge, split, reassign, dismiss_suggestion) and no
    // reason; `correction` and `reason` are read too for rows written before that was settled (G-02 TH3-6).
    case 'discovery.correction':
      return {
        kind: 'platform',
        action: 'Corrected a discovery result',
        target:
          [correctionLabel(str(d, 'action') || str(d, 'correction')), str(d, 'reason')]
            .filter(Boolean)
            .join(' · ') || 'Correction',
      };
    case 'discovery.milestone_extracted':
      return {
        kind: 'platform',
        action: 'Model extracted a milestone',
        target: str(d, 'milestone').replaceAll('_', ' ') || 'Milestone',
      };
    case 'discovery.stage_assessed':
      return {
        kind: 'platform',
        // The engine assesses over model and rule events alike (#173 G-07 slice 5, T-4), so the label names the row's
        // basis (20261023130100): model, rules or mixed. A row without one, from before 130100, names none. Copy:
        // design to confirm.
        action: ['Assessed the step', stageBasisLabel(str(d, 'basis'))].filter(Boolean).join(' '),
        target: railStepName(d, 'stepId', 'stepTitle') || 'Step',
      };
    case 'discovery.mailbox_consented':
      return { kind: 'platform', action: 'Connected a mailbox for deal discovery', target: str(d, 'address') || 'Mailbox' };
    case 'discovery.mailbox_consent_withdrawn':
      return { kind: 'platform', action: 'Stopped deal discovery reading a mailbox', target: str(d, 'address') || 'Mailbox' };
    // #461: the detail carries ids, the reason and counts, never an address.
    case 'discovery.mailbox_purged':
      return {
        kind: 'platform',
        action: 'Deleted the mail stored from a mailbox',
        target: str(d, 'items') ? `${str(d, 'items')} messages` : 'Mailbox',
      };
    // #461: content_on_disconnect keep; the detail carries ids, the reason and the policy, never an address.
    case 'discovery.mailbox_retained':
      return { kind: 'platform', action: 'Kept the mail stored from a mailbox', target: 'Mailbox' };
    // #581: a team inbox is named by ids and fixed codes in the detail, never by address, so the label cannot name it.
    case 'discovery.team_mailbox_connected':
      return { kind: 'platform', action: 'Connected a team inbox for deal discovery', target: 'Team inbox' };
    case 'discovery.team_mailbox_checked': {
      const status = str(d, 'status');
      return {
        kind: 'platform',
        action: 'Checked a team inbox address',
        target: [status, str(d, 'reason')].filter(Boolean).map((part) => part.replaceAll('_', ' ')).join(' · ') || 'Team inbox',
      };
    }
    case 'discovery.team_mailbox_member_added':
      return { kind: 'platform', action: 'Gave a person access to a team inbox', target: 'Team inbox' };
    case 'discovery.team_mailbox_member_removed':
      return { kind: 'platform', action: 'Removed a person\'s access to a team inbox', target: 'Team inbox' };
    case 'discovery.team_mailbox_disconnected':
      return {
        kind: 'platform',
        action: 'Removed a team inbox from deal discovery',
        target: str(d, 'reason').replaceAll('_', ' ') || 'Team inbox',
      };
    // G-01 (#173): an owner's per-tenant capability switched on or off by a reviewed migration. The detail carries the
    // capability code, the firm company id, whether it is now on and the decision reference, never mail.
    case 'discovery.tenant_approval_changed':
      return {
        kind: 'platform',
        action: d?.on === false ? 'Revoked a firm capability' : 'Approved a firm capability',
        target: str(d, 'capability').replaceAll('_', ' ') || 'Capability',
      };
    // G-01 (#173): an AI pass over a team inbox. The detail carries ids, the path, the outcome and integer counts, never
    // an address or a deal name, so the label cannot name the inbox. Copy: design to confirm.
    case 'discovery.team_mailbox_proposal_started':
      return { kind: 'platform', action: 'Started an AI pass over a team inbox', target: 'Team inbox' };
    case 'discovery.team_mailbox_proposal_finished':
      return {
        kind: 'platform',
        action: 'Finished an AI pass over a team inbox',
        target: str(d, 'outcome').replaceAll('_', ' ') || 'Team inbox',
      };
    // G-02a (#173): the detail carries ids and counts only, never the deal key or a name, so the target is a count.
    case 'discovery.model_proposal_dismissed':
      return {
        kind: 'platform',
        action: 'Dismissed a model proposal',
        target: str(d, 'rowCount') ? `${str(d, 'rowCount')} proposals` : 'Model proposal',
      };
    case 'discovery.model_proposal_dismissal_restored': {
      const restored = Array.isArray(d?.dismissalIds) ? d.dismissalIds.length : 0;
      return {
        kind: 'platform',
        action: 'Restored a dismissed model proposal',
        target: restored ? `${restored} dismissals` : 'Model proposal',
      };
    }
    // #173 G-07 slice 3b: the deterministic rule detector, never a model. The detail carries ids, a count and the
    // rules version, never text. Copy: design to confirm.
    case 'discovery.milestone_detected':
      return {
        kind: 'platform',
        action: 'Rules found milestones in an email',
        target: str(d, 'eventCount') ? `${str(d, 'eventCount')} milestones` : 'Milestones',
      };
    case 'discovery.team_mailbox_milestones_detected':
      return { kind: 'platform', action: 'Rules read a team inbox for milestones', target: 'Team inbox' };
    // G-02b (#173): the detail carries ids, a step id and counts only, never the deal key or a name, so the targets are counts.
    case 'discovery.model_proposal_accept_requested':
      return {
        kind: 'platform',
        action: 'Requested an accept of a model proposal',
        target: requestTarget(d),
      };
    case 'discovery.model_proposal_accept_finished':
      return {
        kind: 'platform',
        action: 'Finished reading the emails of an accepted model proposal',
        target:
          str(d, 'found') && str(d, 'requested')
            ? `${str(d, 'found')} of ${str(d, 'requested')} emails`
            : 'Model proposal',
      };
    case 'discovery.content_collected':
      return {
        kind: 'platform',
        action: 'Deleted stored mail no mailbox holds',
        target: str(d, 'items') ? `${str(d, 'items')} messages` : 'Stored mail',
      };
    case 'discovery.group_removal_held':
      return {
        kind: 'platform',
        action: 'Held group-removal withdrawals for an operator check',
        target: str(d, 'due') ? `${str(d, 'due')} consents` : 'Mailbox consents',
      };
    case 'discovery.tenant_purged':
      return {
        kind: 'platform',
        action: "Deleted the firm's stored mail",
        target: str(d, 'items') ? `${str(d, 'items')} messages` : 'Stored mail',
      };
    case 'discovery.retention_policy_set': {
      const next = d?.new && typeof d.new === 'object' ? (d.new as Record<string, unknown>) : null;
      return { kind: 'platform', action: 'Set the retention policy', target: str(next, 'lifecycle') || 'Retention policy' };
    }
    case 'discovery.mailbox_access_changed': {
      // A firm admin's pause, resume or restart of a mailbox source (#259 phase 4), or its ingestion window (#353).
      // Connecting is the member's opt-in, audited as discovery.mailbox_consented.
      const change = str(d, 'change');
      const action =
        change === 'paused'
          ? 'Paused deal discovery reading a mailbox'
          : change === 'resumed'
            ? 'Resumed deal discovery reading a mailbox'
            : change === 'restarted'
              ? 'Restarted deal discovery reading a mailbox'
              : change === 'window_set'
                ? 'Set how far back deal discovery reads a mailbox'
                : 'Changed how deal discovery reads a mailbox';
      return { kind: 'platform', action, target: str(d, 'address') || 'Mailbox' };
    }
    case 'discovery.mailbox_refused':
      return {
        kind: 'platform',
        action: 'Refused a mailbox read',
        target: [str(d, 'address'), str(d, 'reason').replaceAll('_', ' ')].filter(Boolean).join(' · ') || 'Mailbox',
      };
    case 'discovery.mailbox_source_archived':
      return { kind: 'platform', action: 'Archived an earlier holder\'s mailbox history', target: str(d, 'address') || 'Mailbox' };
    case 'discovery.mailbox_sources_unified':
      return { kind: 'platform', action: 'Merged archived mailbox history into the current mailbox', target: str(d, 'address') || 'Mailbox' };
    case 'discovery.allowlist_drift':
      return {
        kind: 'platform',
        action: 'Mailbox allowlist differs from the provider group',
        target: str(d, 'status').replaceAll('_', ' ') || 'Allowlist',
      };
    // The site actions are declared with the mailbox ones (one CHECK
    // rebuild); registered_sites_audit and site_guard_check write them.
    case 'discovery.site_registered':
      return { kind: 'platform', action: 'Registered a SharePoint site for deal discovery', target: str(d, 'address') || 'Site' };
    case 'discovery.site_unregistered':
      return { kind: 'platform', action: 'Stopped deal discovery reading a SharePoint site', target: str(d, 'address') || 'Site' };
    case 'discovery.exclusion_policy_changed':
      return {
        kind: 'platform',
        action: 'Changed the mailbox exclusion policy',
        target: str(d, 'version') ? `Version ${str(d, 'version')}` : 'Exclusion policy',
      };
    // One discovery reader attempt (#370). Tenant-wide service rows: they never reach a deal trail.
    case 'discovery.reader_pass_started':
      return { kind: 'platform', action: 'Started a mailbox read', target: 'Reader pass' };
    case 'discovery.reader_pass_finished':
      return { kind: 'platform', action: 'Finished a mailbox read', target: str(d, 'status').replaceAll('_', ' ') || 'Reader pass' };
    case 'discovery.site_refused':
      return {
        kind: 'platform',
        action: 'Refused a SharePoint site read',
        target: [str(d, 'address'), str(d, 'reason').replaceAll('_', ' ')].filter(Boolean).join(' · ') || 'Site',
      };
    // Skill builder rows: named in words, never by their stored action key.
    case 'skill_authoring.draft_created':
      return { kind: 'platform', action: 'Started a skill draft', target: 'Skill builder' };
    case 'skill_authoring.draft_archived':
      return { kind: 'platform', action: 'Closed a skill draft', target: 'Skill builder' };
    case 'skill_authoring.message_admitted':
      return { kind: 'platform', action: 'Sent a message in the skill builder', target: 'Skill builder' };
    case 'skill_authoring.attempt_transitioned':
      return { kind: 'platform', action: 'Updated a skill draft', target: 'Skill builder' };
    case 'skill_authoring.candidate_selected':
      return { kind: 'platform', action: 'Chose a candidate skill', target: 'Skill builder' };
    case 'skill_authoring.access_denied':
      return { kind: 'platform', action: 'Was refused skill builder access', target: 'Skill builder' };
    default:
      break;
  }
  // The shared raw fallback: unmapped actions and non-mail 'screen' rows.
  return { kind: 'platform', action: row.action, target: str(d, 'code') || '' };
}

/** Who a server row names in the Person column. A user row names its user;
 *  a row with no user was written by Conductia itself (service and model rows
 *  carry no actor_id, and the AI stays unnamed, D49). */
const SYSTEM_PERSON = 'Conductia';

function personFor(actor: ServerAuditRow['actor']): { person: string; personId?: string } {
  const a = Array.isArray(actor) ? actor[0] : actor;
  if (!a) return { person: SYSTEM_PERSON };
  // A user with no name on file is still a person, never Conductia.
  return { person: actorName(a) ?? 'Someone', personId: a.id };
}

/** Map one audit_log row to the display shape. Ids are prefixed so they can
 *  never collide with local (session-monotonic) event ids. */
export function toAuditEvent(row: ServerAuditRow, dealCodename: string): AuditEvent {
  const { kind, action, target } = describeAuditRow(row);
  return {
    id: `srv-${row.id}`,
    ts: Date.parse(row.ts),
    kind,
    action,
    actionKey: row.action,
    target,
    deal: dealCodename,
    ...personFor(row.actor),
    // The raw payload rides along for the export; never displayed.
    serverDetail: row.detail ?? null,
  };
}

/**
 * What the register receives from the platform trail read: the mapped
 * events; 'not-on-deal' when the route refused the deal; or null when the
 * read failed, which the register must state, never show as empty.
 */
export type ServerAuditResult = AuditEvent[] | null | 'not-on-deal';

/**
 * Fetch the deal's platform audit trail.
 *
 * The route answers a caller with no seat (and no oversight) with the same
 * 404 as a code that does not exist (dealNotVisible, decision-log D65), so a
 * 404 is 'not-on-deal': a refusal, never an empty trail. The register decides
 * how to show it (a fixture deal in the viewer's own list has no server
 * record and keeps its local log). Its only 403 is an account gate such as
 * MFA (requireApiUser), which is a failed read like any other: null.
 */
export async function fetchServerAudit(idOrCode: string): Promise<ServerAuditResult> {
  try {
    const res = await fetch(`/api/v1/deals/${encodeURIComponent(idOrCode)}/audit`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return 'not-on-deal';
    if (!res.ok) return null;
    const body = (await res.json()) as ServerAuditResponse;
    return (body.events ?? []).map((row) => toAuditEvent(row, body.deal.codename));
  } catch {
    return null;
  }
}
