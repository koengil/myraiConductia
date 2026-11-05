'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog, useRetainedWhileClosing } from '@/components/overlay';
import { DEAL_ROLE, DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';

type Member = { id: string; name: string; dealRole: string };

/** The step row the assign PATCH returned: its owner and its new row version. */
export type AssignedStep = {
  assignedTo: string | null;
  assignedToName: string | null;
  updatedAt?: string;
};

/** A step from the board (a rail step) or from step detail (its id and name). */
export type AssignTarget = ProjectRailStep | { stepId: string; title: string };

function targetTitle(target: AssignTarget): string {
  return 'title' in target ? target.title : stepTitle(target);
}

type Loaded = {
  stepId: string;
  members: Member[];
  assignedTo: string | null;
  canAssign: boolean;
};

const UNASSIGNED = '';

/** An Observer seat cannot own a step (handoff E29: the server accepts it today). */
export const READ_ONLY_OWNER_COPY = 'Read only. Cannot own steps.';
export const NOTHING_SENT_COPY = 'Nothing was sent.';
/** Why the confirm button is not available at the current owner. */
export function alreadyAssignedCopy(name: string): string {
  return `Already assigned to ${name}.`;
}
export const ALREADY_UNASSIGNED_COPY = 'Already unassigned.';

function cannotOwn(member: Member): boolean {
  return member.dealRole === DEAL_ROLE.READ_ONLY;
}

function roleLabel(role: string): string {
  return DEAL_ROLE_LABELS[role as DealRole] ?? role;
}

/**
 * The deliberate way an MD hands a step to someone on the deal: choose a
 * person, read what happens, confirm. Assigning someone else sends them a
 * real notification (the existing steps PATCH), so it is never a one-tap
 * select on a card. The team and the MD's right to assign are read for this
 * one step when the dialog opens; the board itself makes no read per card.
 */
export function AssignStepDialog({
  dealId,
  step,
  currentUserId,
  onClose,
  onAssigned,
}: {
  dealId: string;
  /** The step being assigned; null closes the dialog. */
  step: AssignTarget | null;
  currentUserId: string | null;
  onClose: () => void;
  /**
   * After the server saved the assignment, with the step row the PATCH
   * returned (when it returned one), so a panel holding the row version can
   * take the new one instead of saving against a stale version.
   */
  onAssigned: (step?: AssignedStep) => void;
}) {
  const shown = useRetainedWhileClosing(step);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [readFailed, setReadFailed] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState<{ stepId: string; id: string } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const consequenceId = React.useId();

  const stepId = step?.stepId ?? null;
  React.useEffect(() => {
    if (!stepId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(stepId)}`,
          { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } },
        );
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          step: { assignedTo: string | null };
          members?: Member[];
          permissions?: { canAssign?: boolean };
        };
        if (cancelled) return;
        setLoaded({
          stepId,
          members: (body.members ?? []).filter((m) => m.id),
          assignedTo: body.step.assignedTo,
          canAssign: body.permissions?.canAssign === true,
        });
      } catch {
        if (!cancelled) setReadFailed(stepId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, stepId]);

  const ready = loaded && loaded.stepId === shown?.stepId ? loaded : null;
  const failed = readFailed !== null && readFailed === shown?.stepId;
  const current = ready?.assignedTo ?? UNASSIGNED;
  const chosen = choice && choice.stepId === shown?.stepId ? choice.id : current;
  const chosenMember = ready?.members.find((m) => m.id === chosen) ?? null;
  const changed = ready !== null && chosen !== current && !(chosenMember && cannotOwn(chosenMember));
  // Who gets notified depends on who you are: until that is known, an owner
  // choice says nothing it cannot stand behind and cannot be confirmed.
  const knowsMe = currentUserId !== null;
  const blockedOnMe = changed && chosen !== UNASSIGNED && !knowsMe;

  const close = () => {
    setChoice(null);
    setError(null);
    setReadFailed(null);
    setLoaded(null);
    onClose();
  };

  async function confirm() {
    if (!shown || !changed || blockedOnMe) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(shown.stepId)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assignTo: chosen === UNASSIGNED ? null : chosen }),
        },
      );
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Only the deal's managing director can assign this step."
            : res.status === 409
              ? 'This step changed since it was read. Close this and try again.'
              : 'The assignment was not saved. Try again.',
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as { step?: AssignedStep } | null;
      const saved = body?.step && typeof body.step === 'object' ? body.step : undefined;
      // The PATCH returns the owner's id but no name (its serializer gets no
      // assignee), so the name comes from the deal team this dialog read,
      // matched on the id the server saved; an unknown id names no one.
      const owner = saved?.assignedTo
        ? (ready?.members.find((m) => m.id === saved.assignedTo) ?? null)
        : null;
      onAssigned(
        saved
          ? { ...saved, assignedToName: saved.assignedToName ?? owner?.name ?? null }
          : undefined,
      );
      close();
    } catch {
      setError('The assignment was not saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  // What confirming does, in plain words, before it happens; at the current
  // owner, why there is nothing to confirm.
  let consequence = '';
  const atCurrent = ready !== null && ready.canAssign && chosen === current;
  if (atCurrent) {
    // An owner the team read does not list (they left the deal) gets no claim.
    consequence =
      chosen === UNASSIGNED
        ? ALREADY_UNASSIGNED_COPY
        : chosenMember
          ? alreadyAssignedCopy(chosenMember.name)
          : '';
  } else if (changed) {
    if (chosen === UNASSIGNED) {
      consequence = 'The step goes back to Unassigned. No one is notified.';
    } else if (!knowsMe) {
      consequence = 'Reading who you are.';
    } else if (chosen === currentUserId) {
      consequence = 'You become the owner. No one is notified.';
    } else if (chosenMember) {
      consequence = `${chosenMember.name} gets a notification that this step is theirs.`;
    }
  }
  const confirmLabel =
    chosen === UNASSIGNED ? 'Remove owner' : chosenMember ? `Assign to ${chosenMember.name}` : 'Assign';

  return (
    <Dialog
      open={step !== null}
      onClose={close}
      eyebrow="Assign step"
      title={shown ? targetTitle(shown) : 'Assign step'}
      description="Choose who owns this step on the deal."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!changed || saving || blockedOnMe || !ready?.canAssign}
            aria-describedby={atCurrent && !error && consequence ? consequenceId : undefined}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          The deal team could not be read. Close this and try again.
        </p>
      ) : !ready ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          Reading the deal team.
        </p>
      ) : !ready.canAssign ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Only the deal&apos;s managing director can assign this step.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-[var(--space-1)] border-0 p-0">
          <legend className="bank-label mb-[var(--space-2)]">Owner</legend>
          {[{ id: UNASSIGNED, name: 'Unassigned', dealRole: '' }, ...ready.members].map((member) => {
            const blocked = cannotOwn(member);
            const noteId = `assign-owner-note-${member.id}`;
            return (
            <label
              key={member.id || 'unassigned'}
              className={`flex min-h-10 items-center gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-2)] text-[length:var(--text-sm)] ${
                blocked ? 'text-[var(--ink-tertiary)]' : 'text-[var(--ink)] hover:bg-[var(--surface-raised)]'
              }`}
            >
              <input
                type="radio"
                name="assign-step-owner"
                value={member.id}
                checked={chosen === member.id}
                disabled={blocked}
                aria-describedby={blocked ? noteId : undefined}
                onChange={() => {
                  if (blocked) return;
                  setError(null);
                  setChoice({ stepId: ready.stepId, id: member.id });
                }}
                className="h-4 w-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {member.name}
                  {member.id === currentUserId ? ' (you)' : ''}
                </span>
                {blocked ? (
                  <span id={noteId} className="block text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {READ_ONLY_OWNER_COPY}
                  </span>
                ) : null}
              </span>
              {member.dealRole ? (
                <span className="shrink-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  {roleLabel(member.dealRole)}
                </span>
              ) : null}
            </label>
            );
          })}
        </fieldset>
      )}
      <p
        id={consequenceId}
        aria-live="polite"
        className="mt-[var(--space-3)] min-h-5 text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        {/* A refused save notified no one, so the promise gives way to the fact. */}
        {error ? NOTHING_SENT_COPY : consequence}
      </p>
      {error ? (
        <p role="alert" className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export default AssignStepDialog;
