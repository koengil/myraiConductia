"use client";

import * as React from "react";

import { GATE0_STEP_ID_SET } from "@/lib/rail/gate0";
import { stepTitle, type ProjectRailStep } from "@/lib/rail/projectRail";

/**
 * The step a deal opened at, as "Opened at step NN · {title}". Step
 * numbers are positions on the rendered rail, the same scale the step
 * cards read. A deal that came into Conductia partway down the rail has
 * steps before its entry; this line says where it came in.
 */
export function entryLineText(
  steps: readonly ProjectRailStep[],
  entryStepSeq: number | null | undefined,
): string | null {
  if (typeof entryStepSeq !== "number") return null;
  // Gate 0 intake always runs first, so it never counts as an earlier step.
  const openedPartway = steps.some(
    (step) =>
      step.seq !== null &&
      step.seq < entryStepSeq &&
      !GATE0_STEP_ID_SET.has(step.stepId),
  );
  if (!openedPartway) return null;
  const index = steps.findIndex((step) => step.seq === entryStepSeq);
  if (index < 0) return null;
  const number = String(index + 1).padStart(2, "0");
  return `Opened at step ${number} · ${stepTitle(steps[index])}`;
}

export function EntryLine({
  steps,
  entryStepSeq,
}: {
  steps: readonly ProjectRailStep[];
  entryStepSeq: number | null | undefined;
}) {
  const text = entryLineText(steps, entryStepSeq);
  if (!text) return null;
  return (
    <p
      data-testid="rail-entry-line"
      className="mt-1 font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
    >
      {text}
    </p>
  );
}

export default EntryLine;
