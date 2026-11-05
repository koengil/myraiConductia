"use client";

import * as React from "react";

import type { Placement } from "@/lib/skillAuthoring/types";
import { stepTitle, type ProjectRail } from "@/lib/rail/projectRail";
import {
  FieldHelp,
  PLACEMENT_CHOOSE_LABEL,
  PLACEMENT_END_LABEL,
  PLACEMENT_NO_STEPS_LABEL,
  PLACEMENT_START_LABEL,
  placementAfterLabel,
  placementFromValue,
  placementValue,
  positionOptions,
} from "./SkillBuilderPlacementFields";

export const PANEL_CLASS =
  "mt-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] p-[var(--space-3)]";
export const ACTION_CLASS =
  "text-[length:var(--text-sm)] font-medium text-[var(--accent)]";
const SELECT_CLASS =
  "mt-1 block h-[34px] w-full rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] transition-colors hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]";

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type NewPhaseSelectProps = {
  rail: ProjectRail;
  phaseIndex: number | null;
  onChange: (phaseIndex: number | null) => void;
};

function phaseSelectionFromValue(value: string): number | null {
  return value === "" ? null : Number(value);
}

function NewPhaseSelect({ rail, phaseIndex, onChange }: NewPhaseSelectProps) {
  return (
    <label className="block">
      <span className="bank-label">New phase</span>
      <select
        aria-label="New phase"
        value={phaseIndex ?? ""}
        onChange={(event) =>
          onChange(phaseSelectionFromValue(event.target.value))
        }
        className={SELECT_CLASS}
      >
        <option value="">Choose phase</option>
        {rail.phases.map((phase) => (
          <option key={phase.index} value={phase.index}>
            {phase.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type AnchorOptionsProps = {
  rail: ProjectRail;
  phaseIndex: number;
  excludeStepId: string | null;
};

const NEW_POSITION_HELP_ID = "skill-publication-new-position-help";

function anchorOptionsFor(
  rail: ProjectRail,
  phaseIndex: number,
  excludeStepId: string | null,
) {
  return positionOptions(rail, phaseIndex).filter(
    (step) => step.id !== excludeStepId,
  );
}

function AnchorOptions({
  rail,
  phaseIndex,
  excludeStepId,
}: AnchorOptionsProps) {
  return (
    <>
      {anchorOptionsFor(rail, phaseIndex, excludeStepId).map((step) => (
        <option key={step.id} value={`after:${step.id}`}>
          {placementAfterLabel(stepTitle(step))}
        </option>
      ))}
    </>
  );
}

type NewPositionSelectProps = AnchorOptionsProps & {
  placement: Placement | null;
  onChange: (placement: Placement | null) => void;
};

function NewPositionSelectField({
  rail,
  phaseIndex,
  placement,
  excludeStepId,
  onChange,
  hasAnchors,
}: NewPositionSelectProps & { hasAnchors: boolean }) {
  return (
    <select
      aria-label="New position"
      aria-describedby={hasAnchors ? undefined : NEW_POSITION_HELP_ID}
      value={placement ? placementValue(placement) : ""}
      onChange={(event) =>
        onChange(placementFromValue(event.target.value, phaseIndex))
      }
      className={SELECT_CLASS}
    >
      <option value="">{PLACEMENT_CHOOSE_LABEL}</option>
      <option value="phase_start">{PLACEMENT_START_LABEL}</option>
      <option value="phase_end">{PLACEMENT_END_LABEL}</option>
      <AnchorOptions
        rail={rail}
        phaseIndex={phaseIndex}
        excludeStepId={excludeStepId}
      />
    </select>
  );
}

function NewPositionSelect(props: NewPositionSelectProps) {
  const hasAnchors =
    anchorOptionsFor(props.rail, props.phaseIndex, props.excludeStepId).length >
    0;
  return (
    <div>
      <label className="block">
        <span className="bank-label">New position</span>
        <NewPositionSelectField {...props} hasAnchors={hasAnchors} />
      </label>
      <FieldHelp
        id={NEW_POSITION_HELP_ID}
        text={hasAnchors ? null : PLACEMENT_NO_STEPS_LABEL}
      />
    </div>
  );
}

type ConfirmPositionButtonProps = {
  disabled: boolean;
  placement: Placement | null;
  onConfirm: (placement: Placement) => void;
};

function ConfirmPositionButton({
  disabled,
  placement,
  onConfirm,
}: ConfirmPositionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => placement && !disabled && onConfirm(placement)}
      className={`mt-[var(--space-2)] ${ACTION_CLASS} disabled:opacity-50`}
    >
      Confirm position
    </button>
  );
}

type PositionStepProps = {
  rail: ProjectRail;
  phaseIndex: number | null;
  placement: Placement | null;
  removedAnchorId: string | null;
  onChange: (placement: Placement | null) => void;
};

function PositionStep({
  rail,
  phaseIndex,
  placement,
  removedAnchorId,
  onChange,
}: PositionStepProps) {
  if (phaseIndex === null) return null;
  return (
    <NewPositionSelect
      rail={rail}
      phaseIndex={phaseIndex}
      placement={placement}
      excludeStepId={removedAnchorId}
      onChange={onChange}
    />
  );
}

type NeedsPlacementControlsProps = {
  rail: ProjectRail;
  failedPlacement: Placement | null;
  removedAnchorId: string | null;
  commandInFlight: boolean;
  onConfirm: (placement: Placement) => void;
};

function useNeedsPlacementState(failedPlacement: Placement | null) {
  const [phaseIndex, setPhaseIndex] = React.useState<number | null>(null);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const canConfirm =
    placement !== null && !samePlacement(placement, failedPlacement);
  const onPhaseChange = (index: number | null) => {
    setPhaseIndex(index);
    setPlacement(null);
  };
  return { phaseIndex, placement, canConfirm, onPhaseChange, setPlacement };
}

export function NeedsPlacementControls({
  rail,
  failedPlacement,
  removedAnchorId,
  commandInFlight,
  onConfirm,
}: NeedsPlacementControlsProps) {
  const state = useNeedsPlacementState(failedPlacement);
  return (
    <div className={PANEL_CLASS}>
      <NewPhaseSelect
        rail={rail}
        phaseIndex={state.phaseIndex}
        onChange={state.onPhaseChange}
      />
      <PositionStep
        rail={rail}
        phaseIndex={state.phaseIndex}
        placement={state.placement}
        removedAnchorId={removedAnchorId}
        onChange={state.setPlacement}
      />
      <ConfirmPositionButton
        disabled={!state.canConfirm || commandInFlight}
        placement={state.placement}
        onConfirm={onConfirm}
      />
    </div>
  );
}
