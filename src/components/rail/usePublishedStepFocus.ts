"use client";

import * as React from "react";

import type { ProjectRailStep } from "@/lib/rail/projectRail";
import { restoreStepRequest } from "./restoreStepRequest";

export type UsePublishedStepFocusOptions = {
  close: () => void;
  refresh: () => void;
  steps: readonly ProjectRailStep[];
  loading: boolean;
  openStepInFocus: (id: string) => void;
};

export type UsePublishedStepFocusResult = {
  handlePublished: (stepId: string) => void;
  focusExisting: (dealStepId: string) => void;
};

type PendingState = { pending: string | null; sawLoading: boolean };
type PendingStateRef = React.RefObject<PendingState>;

function checkPendingFocus(
  stateRef: PendingStateRef,
  loading: boolean,
  steps: readonly ProjectRailStep[],
  openStepInFocus: (id: string) => void,
): void {
  if (loading) {
    stateRef.current.sawLoading = true;
    return;
  }
  const { pending, sawLoading } = stateRef.current;
  if (!pending || !sawLoading) return;
  if (steps.some((step) => step.id === pending)) openStepInFocus(pending);
  stateRef.current = { pending: null, sawLoading: false };
}

function publishHandler(
  stateRef: PendingStateRef,
  close: () => void,
  refresh: () => void,
  setTick: React.Dispatch<React.SetStateAction<number>>,
  stepId: string,
): void {
  close();
  stateRef.current = { pending: stepId, sawLoading: false };
  setTick((value) => value + 1);
  refresh();
}

export function usePublishedStepFocus({
  close,
  refresh,
  steps,
  loading,
  openStepInFocus,
}: UsePublishedStepFocusOptions): UsePublishedStepFocusResult {
  const stateRef = React.useRef<PendingState>({
    pending: null,
    sawLoading: false,
  });
  const [tick, setTick] = React.useState(0);

  const handlePublished = React.useCallback(
    (stepId: string) =>
      publishHandler(stateRef, close, refresh, setTick, stepId),
    [close, refresh],
  );

  React.useEffect(
    () => checkPendingFocus(stateRef, loading, steps, openStepInFocus),
    [loading, steps, openStepInFocus, tick],
  );

  const focusExisting = React.useCallback(
    (dealStepId: string) => {
      close();
      openStepInFocus(dealStepId);
    },
    [close, openStepInFocus],
  );

  return { handlePublished, focusExisting };
}

export function useRestoreExistingStep(
  projectId: string,
  handlePublished: (stepId: string) => void,
): (dealStepId: string) => Promise<boolean> {
  const inFlightRef = React.useRef(false);
  return React.useCallback(
    async (dealStepId: string) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      try {
        const result = await restoreStepRequest(projectId, dealStepId);
        if (!result.ok) return false;
        handlePublished(dealStepId);
        return true;
      } finally {
        inFlightRef.current = false;
      }
    },
    [projectId, handlePublished],
  );
}
