"use client";

import * as React from "react";

import type { PublicationRead } from "@/lib/skillPublication/types";
import {
  CONFIRM_DUPLICATE_PROMPT,
  CONFIRM_SAVE_ANYWAY_LABEL,
  DECLINE_MATCH_LABEL,
  FOCUS_EXISTING_STEP_LABEL,
  PUBLISHED_SUMMARY_LABEL,
  RESTORE_EXISTING_STEP_LABEL,
  RESTORE_FAILED_DETAIL,
  duplicateReasonMessage,
  publicationErrorMessage,
} from "./publicationCopy";
import { ACTION_CLASS, PANEL_CLASS } from "./SkillBuilderPublicationPlacement";

function MatchList({ publication }: { publication: PublicationRead }) {
  return (
    <ul className="mt-[var(--space-2)] list-disc pl-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
      {publication.matches.map((match, index) => (
        <li key={`${match.dealStepId ?? "unmatched"}-${index}`}>
          {match.name} · {duplicateReasonMessage(match.reasonCode)}
        </li>
      ))}
    </ul>
  );
}

export function ConfirmationRequiredControls({
  publication,
  commandInFlight,
  onConfirm,
  onDecline,
}: {
  publication: PublicationRead;
  commandInFlight: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  if (publication.assessmentDigest === null) return null;
  return (
    <div className={PANEL_CLASS}>
      <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
        {CONFIRM_DUPLICATE_PROMPT}
      </p>
      <MatchList publication={publication} />
      <div className="mt-[var(--space-2)] flex gap-[var(--space-3)]">
        <button
          type="button"
          disabled={commandInFlight}
          onClick={onConfirm}
          className={`${ACTION_CLASS} disabled:opacity-50`}
        >
          {CONFIRM_SAVE_ANYWAY_LABEL}
        </button>
        <button
          type="button"
          disabled={commandInFlight}
          onClick={onDecline}
          className={`${ACTION_CLASS} disabled:opacity-50`}
        >
          {DECLINE_MATCH_LABEL}
        </button>
      </div>
    </div>
  );
}

function FocusExistingStepAction({
  dealStepId,
  onFocusStep,
}: {
  dealStepId: string;
  onFocusStep: (dealStepId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFocusStep(dealStepId)}
      className={`mt-[var(--space-2)] ${ACTION_CLASS}`}
    >
      {FOCUS_EXISTING_STEP_LABEL}
    </button>
  );
}

function useRestoreClickGuard(
  dealStepId: string,
  onRestoreStep: (dealStepId: string) => Promise<boolean>,
) {
  const pendingRef = React.useRef(false);
  const [failed, setFailed] = React.useState(false);
  const handleClick = React.useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setFailed(false);
    try {
      const ok = await onRestoreStep(dealStepId);
      if (!ok) setFailed(true);
    } finally {
      pendingRef.current = false;
    }
  }, [dealStepId, onRestoreStep]);
  return { failed, handleClick };
}

function RestoreFailedNotice({ failed }: { failed: boolean }) {
  if (!failed) return null;
  return (
    <p
      role="alert"
      className="mt-1 text-[length:var(--text-xs)] text-[var(--negative-deep)]"
    >
      {RESTORE_FAILED_DETAIL}
    </p>
  );
}

function RestoreExistingStepAction({
  dealStepId,
  onRestoreStep,
}: {
  dealStepId: string;
  onRestoreStep: (dealStepId: string) => Promise<boolean>;
}) {
  const { failed, handleClick } = useRestoreClickGuard(
    dealStepId,
    onRestoreStep,
  );
  return (
    <div>
      <button
        type="button"
        onClick={() => void handleClick()}
        className={`mt-[var(--space-2)] ${ACTION_CLASS}`}
      >
        {RESTORE_EXISTING_STEP_LABEL}
      </button>
      <RestoreFailedNotice failed={failed} />
    </div>
  );
}

type FailedPanelProps = {
  publication: PublicationRead;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
};

function DuplicateActions({
  publication,
  onFocusStep,
  onRestoreStep,
}: FailedPanelProps) {
  const dealStepId = publication.error?.dealStepId;
  const code = publication.error?.code;
  if (!dealStepId) return null;
  if (code === "duplicate_active" && onFocusStep)
    return (
      <FocusExistingStepAction
        dealStepId={dealStepId}
        onFocusStep={onFocusStep}
      />
    );
  if (code === "duplicate_removed" && onRestoreStep)
    return (
      <RestoreExistingStepAction
        dealStepId={dealStepId}
        onRestoreStep={onRestoreStep}
      />
    );
  return null;
}

export function FailedPanel(props: FailedPanelProps) {
  const error = props.publication.error;
  if (!error) return null;
  return (
    <div className={PANEL_CLASS}>
      <p
        role="alert"
        className="text-[length:var(--text-sm)] text-[var(--negative-deep)]"
      >
        {publicationErrorMessage(error.code)}
      </p>
      <DuplicateActions {...props} />
    </div>
  );
}

export function PublishedSummary() {
  return (
    <div className={PANEL_CLASS}>
      <p className="text-[length:var(--text-sm)] font-medium text-[var(--positive-deep)]">
        {PUBLISHED_SUMMARY_LABEL}
      </p>
    </div>
  );
}
