"use client";

import * as React from "react";

import type { Placement } from "@/lib/skillAuthoring/types";
import {
  activeSteps,
  stepTitle,
  type ProjectRail,
} from "@/lib/rail/projectRail";

export const FIELD_INPUT =
  "mt-1 block h-[34px] w-full rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] transition-colors placeholder:text-[var(--ink-quiet)] hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-subtle)] disabled:opacity-60";

export const FIELD_LABEL = "bank-label block";

const HELP_TONE_CLASS = {
  muted: "mt-1 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]",
  negative: "mt-1 text-[length:var(--text-xs)] text-[var(--negative-deep)]",
} as const;

export function FieldHelp({
  id,
  text,
  tone = "muted",
}: {
  id: string;
  text: string | null;
  tone?: keyof typeof HELP_TONE_CLASS;
}) {
  if (!text) return null;
  return (
    <p
      id={id}
      role={tone === "negative" ? "alert" : undefined}
      className={HELP_TONE_CLASS[tone]}
    >
      {text}
    </p>
  );
}

export const PLACEMENT_CHOOSE_LABEL = "Choose position";
export const PLACEMENT_START_LABEL = "Start of phase";
export const PLACEMENT_END_LABEL = "End of phase";
export const PLACEMENT_NO_STEPS_LABEL =
  "This phase has no active steps, so only phase start and end are available.";

export function placementAfterLabel(stepName: string): string {
  return `After: ${stepName}`;
}

export function placementBeforeLabel(stepName: string): string {
  return `Before: ${stepName}`;
}

export const PLACEMENT_CHANGE_LABEL = "Change";

/**
 * The default spot for a new step: after the step the MD chose to add from,
 * else after the deal's current step, else the start of the first phase.
 */
export function defaultPlacement(
  rail: ProjectRail,
  afterStepId: string | null = rail.currentStepId,
): Placement | null {
  const anchor = activeSteps(rail).find((step) => step.id === afterStepId);
  if (anchor) {
    return { kind: "after", phaseIndex: anchor.phaseIndex, afterStepId: anchor.id };
  }
  const first = rail.phases[0];
  return first ? { kind: "phase_start", phaseIndex: first.index } : null;
}

/** "Before X" in the API's own terms: after the step before X, or the phase start. */
export function placementBefore(
  rail: ProjectRail,
  phaseIndex: number,
  beforeStepId: string,
): Placement {
  const steps = positionOptions(rail, phaseIndex);
  const at = steps.findIndex((step) => step.id === beforeStepId);
  if (at <= 0) return { kind: "phase_start", phaseIndex };
  return { kind: "after", phaseIndex, afterStepId: steps[at - 1].id };
}

function phaseNameOf(rail: ProjectRail, phaseIndex: number): string {
  return rail.phases.find((phase) => phase.index === phaseIndex)?.name ?? "this phase";
}

/** One line that says where the step goes: "Adds after: Buyer NDA". */
export function placementSummary(
  rail: ProjectRail,
  placement: Placement,
  beforeStepId: string | null = null,
): string {
  const titleOf = (id: string) => {
    const step = activeSteps(rail).find((candidate) => candidate.id === id);
    return step ? stepTitle(step) : id;
  };
  if (beforeStepId) return `Adds before: ${titleOf(beforeStepId)}`;
  if (placement.kind === "after") return `Adds after: ${titleOf(placement.afterStepId)}`;
  const phase = phaseNameOf(rail, placement.phaseIndex);
  return placement.kind === "phase_start"
    ? `Adds at the start of ${phase}`
    : `Adds at the end of ${phase}`;
}

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  return placementValue(a) === placementValue(b) && a?.phaseIndex === b?.phaseIndex;
}

export function defaultPhaseIndex(rail: ProjectRail): number {
  const current = rail.steps.find((step) => step.id === rail.currentStepId);
  return current?.phaseIndex ?? rail.phases[0]?.index ?? 0;
}

export function anchorMissing(
  rail: ProjectRail,
  placement: Placement | null,
): boolean {
  if (!placement || placement.kind !== "after") return false;
  return !activeSteps(rail).some((step) => step.id === placement.afterStepId);
}

export function positionOptions(rail: ProjectRail, phaseIndex: number) {
  return activeSteps(rail).filter((step) => step.phaseIndex === phaseIndex);
}

export function placementValue(placement: Placement | null): string {
  if (!placement) return "";
  if (placement.kind === "after") return `after:${placement.afterStepId}`;
  return placement.kind;
}

export function placementFromValue(
  value: string,
  phaseIndex: number,
  rail?: ProjectRail,
): Placement | null {
  if (value === "") return null;
  if (value.startsWith("before:")) {
    const id = value.slice("before:".length);
    return rail ? placementBefore(rail, phaseIndex, id) : null;
  }
  if (value === "phase_start" || value === "phase_end")
    return { kind: value, phaseIndex };
  return {
    kind: "after",
    phaseIndex,
    afterStepId: value.slice("after:".length),
  };
}

const POSITION_HELP_ID = "skill-authoring-position-help";

function PositionOptions({
  rail,
  phaseIndex,
}: {
  rail: ProjectRail;
  phaseIndex: number;
}) {
  return (
    <>
      {positionOptions(rail, phaseIndex).map((step) => (
        <React.Fragment key={step.id}>
          <option value={`before:${step.id}`}>
            {placementBeforeLabel(stepTitle(step))}
          </option>
          <option value={`after:${step.id}`}>
            {placementAfterLabel(stepTitle(step))}
          </option>
        </React.Fragment>
      ))}
    </>
  );
}

type PhaseFieldProps = {
  rail: ProjectRail;
  phaseIndex: number;
  onPlacementChange: (value: Placement | null) => void;
  disabled: boolean;
};

function PhaseField({
  rail,
  phaseIndex,
  onPlacementChange,
  disabled,
}: PhaseFieldProps) {
  const onChange = (event: React.ChangeEvent<HTMLSelectElement>) =>
    onPlacementChange(
      placementFromValue("phase_start", Number(event.target.value)),
    );
  return (
    <label className="block">
      <span className={FIELD_LABEL}>Phase</span>
      <select
        value={phaseIndex}
        disabled={disabled}
        onChange={onChange}
        className={FIELD_INPUT}
      >
        {rail.phases.map((phase) => (
          <option key={phase.index} value={phase.index}>
            {phase.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type PositionSelectProps = {
  rail: ProjectRail;
  phaseIndex: number;
  value: string;
  needsPlaceholder: boolean;
  describedBy: string | undefined;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled: boolean;
};

function PositionSelect({
  rail,
  phaseIndex,
  value,
  needsPlaceholder,
  describedBy,
  onChange,
  disabled,
}: PositionSelectProps) {
  return (
    <label className="block">
      <span className={FIELD_LABEL}>Position</span>
      <select
        value={value}
        disabled={disabled}
        onChange={onChange}
        aria-describedby={describedBy}
        className={FIELD_INPUT}
      >
        {needsPlaceholder ? (
          <option value="">{PLACEMENT_CHOOSE_LABEL}</option>
        ) : null}
        <option value="phase_start">{PLACEMENT_START_LABEL}</option>
        <option value="phase_end">{PLACEMENT_END_LABEL}</option>
        <PositionOptions rail={rail} phaseIndex={phaseIndex} />
      </select>
    </label>
  );
}

type PositionFieldProps = {
  rail: ProjectRail;
  phaseIndex: number;
  placement: Placement | null;
  missing: boolean;
  beforeStepId: string | null;
  onBeforeChange: (stepId: string | null) => void;
  onPlacementChange: (value: Placement | null) => void;
  disabled: boolean;
};

function PositionField({
  rail,
  phaseIndex,
  placement,
  missing,
  beforeStepId,
  onBeforeChange,
  onPlacementChange,
  disabled,
}: PositionFieldProps) {
  const onChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    onBeforeChange(value.startsWith("before:") ? value.slice("before:".length) : null);
    onPlacementChange(placementFromValue(value, phaseIndex, rail));
  };
  const needsPlaceholder = missing || placement === null;
  const hasAnchors = positionOptions(rail, phaseIndex).length > 0;
  return (
    <div>
      <PositionSelect
        rail={rail}
        phaseIndex={phaseIndex}
        value={
          needsPlaceholder
            ? ""
            : beforeStepId
              ? `before:${beforeStepId}`
              : placementValue(placement)
        }
        needsPlaceholder={needsPlaceholder}
        describedBy={hasAnchors ? undefined : POSITION_HELP_ID}
        onChange={onChange}
        disabled={disabled}
      />
      <FieldHelp
        id={POSITION_HELP_ID}
        text={hasAnchors ? null : PLACEMENT_NO_STEPS_LABEL}
      />
    </div>
  );
}

export type PlacementFieldsProps = {
  rail: ProjectRail;
  placement: Placement | null;
  onPlacementChange: (value: Placement | null) => void;
  disabled: boolean;
};

export function PlacementFields({
  rail,
  placement,
  onPlacementChange,
  disabled,
}: PlacementFieldsProps) {
  const [changing, setChanging] = React.useState(false);
  // "Before X" is saved as the equivalent "after the step before X" (or the
  // phase start); the choice is remembered so the line still reads "before".
  const [before, setBefore] = React.useState<{ stepId: string; placement: Placement } | null>(
    null,
  );
  const phaseIndex = placement?.phaseIndex ?? defaultPhaseIndex(rail);
  const missing = anchorMissing(rail, placement);
  const beforeStepId =
    before && samePlacement(before.placement, placement) ? before.stepId : null;
  const onBeforeChange = (stepId: string | null) =>
    setBefore(stepId ? { stepId, placement: placementBefore(rail, phaseIndex, stepId) } : null);
  if (placement && !missing && !changing) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        <span data-testid="placement-summary">{placementSummary(rail, placement, beforeStepId)}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setChanging(true)}
          aria-label="Change where this step goes"
          className="font-medium text-[var(--ink)] underline underline-offset-4 hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
        >
          {PLACEMENT_CHANGE_LABEL}
        </button>
      </p>
    );
  }
  // Once the choices are open they stay open while the MD works them.
  const choose = (value: Placement | null) => {
    setChanging(true);
    onPlacementChange(value);
  };
  return (
    <div className="grid gap-[var(--space-3)] md:grid-cols-2">
      <PhaseField
        rail={rail}
        phaseIndex={phaseIndex}
        onPlacementChange={(value) => {
          setBefore(null);
          choose(value);
        }}
        disabled={disabled}
      />
      <PositionField
        rail={rail}
        phaseIndex={phaseIndex}
        placement={placement}
        missing={missing}
        beforeStepId={beforeStepId}
        onBeforeChange={onBeforeChange}
        onPlacementChange={choose}
        disabled={disabled}
      />
    </div>
  );
}
