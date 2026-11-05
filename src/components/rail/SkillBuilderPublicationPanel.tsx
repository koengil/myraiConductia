"use client";

import * as React from "react";

import type { DraftRead, Placement } from "@/lib/skillAuthoring/types";
import { publicationOf } from "@/lib/skillAuthoring/publicationState";
import type { PublicationRead } from "@/lib/skillPublication/types";
import type { ProjectRail } from "@/lib/rail/projectRail";
import type { PublicationCommands } from "@/lib/skillAuthoring/useSkillAuthoringPublication";
import {
  CommandErrorAlert,
  PublicationStatusRegion,
} from "./SkillBuilderPublicationStatus";
import { NeedsPlacementControls } from "./SkillBuilderPublicationPlacement";
import {
  ConfirmationRequiredControls,
  FailedPanel,
  PublishedSummary,
} from "./SkillBuilderPublicationDuplicate";

function frozenAnchorId(failedPlacement: Placement | null): string | null {
  return failedPlacement?.kind === "after" ? failedPlacement.afterStepId : null;
}

type PublicationPanelProps = {
  rail: ProjectRail;
  publication: PublicationRead | null;
  currentPlacement: Placement | null;
  commandInFlight: boolean;
  onReplacePlacement: (placement: Placement) => void;
  onDecideDuplicate: (decision: "confirm" | "decline") => void;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
};

export function PublicationPanel(props: PublicationPanelProps) {
  const {
    rail,
    publication,
    currentPlacement,
    commandInFlight,
    onReplacePlacement,
  } = props;
  if (!publication) return null;
  if (publication.state === "needs_placement")
    return (
      <NeedsPlacementControls
        rail={rail}
        failedPlacement={currentPlacement}
        removedAnchorId={frozenAnchorId(currentPlacement)}
        commandInFlight={commandInFlight}
        onConfirm={onReplacePlacement}
      />
    );
  if (publication.state === "confirmation_required")
    return <ConfirmationDispatch {...props} publication={publication} />;
  if (publication.state === "failed")
    return <FailedDispatch {...props} publication={publication} />;
  if (publication.state === "published") return <PublishedSummary />;
  return null;
}

function ConfirmationDispatch({
  publication,
  commandInFlight,
  onDecideDuplicate,
}: PublicationPanelProps & { publication: PublicationRead }) {
  return (
    <ConfirmationRequiredControls
      publication={publication}
      commandInFlight={commandInFlight}
      onConfirm={() => onDecideDuplicate("confirm")}
      onDecline={() => onDecideDuplicate("decline")}
    />
  );
}

function FailedDispatch({
  publication,
  onFocusStep,
  onRestoreStep,
}: PublicationPanelProps & { publication: PublicationRead }) {
  return (
    <FailedPanel
      publication={publication}
      onFocusStep={onFocusStep}
      onRestoreStep={onRestoreStep}
    />
  );
}

type PublicationSectionProps = {
  rail: ProjectRail;
  draft: DraftRead | null;
  publication: PublicationCommands;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
};

function publicationSectionPanelProps(
  props: PublicationSectionProps,
): PublicationPanelProps {
  const { rail, draft, publication, onFocusStep, onRestoreStep } = props;
  return {
    rail,
    publication: publicationOf(draft),
    currentPlacement: draft?.placement ?? null,
    commandInFlight: publication.commandInFlight,
    onReplacePlacement: (placement) =>
      void publication.replacePlacement(placement),
    onDecideDuplicate: (decision) => void publication.decideDuplicate(decision),
    onFocusStep,
    onRestoreStep,
  };
}

export function PublicationSection(props: PublicationSectionProps) {
  const panelProps = publicationSectionPanelProps(props);
  const isPlacementContext =
    panelProps.publication?.state === "needs_placement";
  return (
    <>
      <PublicationStatusRegion publication={panelProps.publication} />
      <CommandErrorAlert
        error={props.publication.publicationCommandError}
        isPlacementContext={isPlacementContext}
      />
      <PublicationPanel {...panelProps} />
    </>
  );
}
