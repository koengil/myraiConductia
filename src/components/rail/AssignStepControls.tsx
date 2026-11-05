'use client';

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { logAudit } from '@/lib/audit/store';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { StepOwnerControl } from './StepOwnerControl';

export interface AssignStepControlsProps {
  dealId: string;
  stepId: string;
  /** The step's name, for the Assign dialog. */
  stepTitle: string;
  disabled?: boolean;
  /** After an assignment: the board's own owner read refreshes from here. */
  onAssigned?: () => void;
}

/**
 * AssignStepControls: who owns a step whose detail has no manual checklist
 * (Relationship Pathing, skill and custom steps). The MD assigns through the
 * Assign… dialog, which says who gets notified before the existing PATCH.
 */
export function AssignStepControls({ dealId, stepId, stepTitle, disabled, onAssigned }: AssignStepControlsProps) {
  const deal = useActiveDeal(dealId);
  const apiEnabled = useFlag('gate0_api_create');
  const [assigneeName, setAssigneeName] = React.useState<string | null>(null);
  const [canAssign, setCanAssign] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [reads, setReads] = React.useState(0);

  React.useEffect(() => {
    if (!apiEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/steps/${stepId}`, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          step: { assignedToName: string | null };
          permissions: { canAssign: boolean };
        };
        if (cancelled) return;
        setAssigneeName(body.step.assignedToName);
        setCanAssign(body.permissions?.canAssign ?? false);
        setFailed(false);
      } catch {
        // A failed read never reads as "Unassigned": the line says the owner
        // could not be loaded, with a retry.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiEnabled, dealId, stepId, reads]);

  if (!apiEnabled) return null;
  return (
    <StepOwnerControl
      dealId={dealId}
      stepId={stepId}
      title={stepTitle}
      assignedToName={assigneeName}
      canAssign={canAssign}
      disabled={disabled}
      loadFailed={failed}
      onRetry={() => setReads((count) => count + 1)}
      onAssigned={() => {
        logAudit('step', 'Assigned step', stepId, { deal: deal.codename });
        setReads((count) => count + 1);
        onAssigned?.();
      }}
    />
  );
}
