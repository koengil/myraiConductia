"use client";

import * as React from "react";

import type { ProjectRail } from "@/lib/rail/projectRail";
import { SkillBuilderDialog, type InitialPlacement } from "./SkillBuilderDialog";

export type SkillBuilderEnhancementBasis = {
  basisStepId: string;
  seedRunId?: string;
  teach?: boolean;
};

export type SkillBuilderLauncherState = {
  rail: ProjectRail | null;
  basis: SkillBuilderEnhancementBasis | null;
  /** Where a new step goes when the builder opens (none for an enhancement). */
  placement: InitialPlacement | null;
  open: boolean;
  changeCount: number;
  launch: (
    rail: ProjectRail,
    basis?: SkillBuilderEnhancementBasis,
    placement?: InitialPlacement | null,
  ) => void;
  close: () => void;
  markSent: () => void;
};

export function useSkillBuilderLauncher(): SkillBuilderLauncherState {
  const [rail, setRail] = React.useState<ProjectRail | null>(null);
  const [basis, setBasis] = React.useState<SkillBuilderEnhancementBasis | null>(
    null,
  );
  const [placement, setPlacement] = React.useState<InitialPlacement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [changeCount, setChangeCount] = React.useState(0);
  const launch = React.useCallback(
    (
      nextRail: ProjectRail,
      nextBasis?: SkillBuilderEnhancementBasis,
      nextPlacement?: InitialPlacement | null,
    ) => {
      setRail(nextRail);
      setBasis(nextBasis ?? null);
      setPlacement(nextBasis ? null : (nextPlacement ?? null));
      setOpen(true);
    },
    [],
  );
  const close = React.useCallback(() => {
    setOpen(false);
    setChangeCount((count) => count + 1);
  }, []);
  const markSent = React.useCallback(() => {
    setChangeCount((count) => count + 1);
  }, []);
  return { rail, basis, placement, open, changeCount, launch, close, markSent };
}

export function SkillBuilderLauncherDialog({
  projectId,
  launcher,
  liveRail,
  onPublished,
  onFocusStep,
  onRestoreStep,
}: {
  projectId: string;
  launcher: SkillBuilderLauncherState;
  liveRail?: ProjectRail | null;
  onPublished?: (stepId: string) => void;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
}) {
  if (!launcher.rail) return null;
  return (
    <SkillBuilderDialog
      open={launcher.open}
      dealId={projectId}
      rail={liveRail ?? launcher.rail}
      onClose={launcher.close}
      onPublished={onPublished}
      onFocusStep={onFocusStep}
      onRestoreStep={onRestoreStep}
      basisStepId={launcher.basis?.basisStepId}
      seedRunId={launcher.basis?.seedRunId}
      teach={launcher.basis?.teach}
      onSent={launcher.markSent}
      initialPlacement={launcher.placement}
    />
  );
}

export default SkillBuilderLauncherDialog;
