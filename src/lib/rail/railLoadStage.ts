"use client";

import * as React from "react";

import { bumpGeneration } from "@/lib/api/inflightRead";

/**
 * The deal rail's bounded, staged wait (#162).
 *
 * Both numbers come from the local cold-load baseline in the task's
 * measurement record (05-measurements-rail-load.md, Thresholds):
 * - RAIL_LOAD_SLOW_MS is the slowest healthy gate-open seen across 160
 *   product-as-shipped loads (6959 ms), rounded up to the next whole second.
 *   A healthy load never shows the still-waiting copy.
 * - RAIL_LOAD_DEADLINE_MS is three times that. It bounds each shared read
 *   (GET /api/v1/deals, GET …/rail): past it the read is aborted and the
 *   rail names the dependency that failed, with Try again.
 */
export const RAIL_LOAD_SLOW_MS = 7000;
export const RAIL_LOAD_DEADLINE_MS = 3 * RAIL_LOAD_SLOW_MS;

/** The dependency the closed rail gate is waiting on. */
export type RailLoadPending = "deals" | "rail";

export type RailLoadStage = { pending: RailLoadPending; slow: boolean };

/** The one status line for a stage: a statement, sentence case, no em dash. */
export function railLoadCopy(stage: RailLoadStage): string {
  if (stage.pending === "deals") {
    return stage.slow
      ? "Still loading your deal list. This is taking longer than usual."
      : "Loading your deal list…";
  }
  return stage.slow
    ? "Still loading the deal rail. This is taking longer than usual."
    : "Loading the deal rail…";
}

/**
 * The stage of one wait. The slow clock starts when the caller mounts (the
 * rail's loading view mounts when the gate closes and unmounts when it opens
 * or fails), so one wait flips to "still loading" at most once, whichever
 * dependency is still pending by then.
 */
export function useRailLoadStage(pending: RailLoadPending): RailLoadStage {
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), RAIL_LOAD_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return { pending, slow };
}

/**
 * Try again, wherever it is pressed: the rail's own error or the shell's
 * (Sidebar, deal switcher, deal context bar). One refresh, so the two cannot
 * drift: the deal list (identity, the shell, step-records gating) always, and
 * on a project route that project's rail (every mounted instance) and its
 * step records, all moved to a new generation in the same tick. Every stale
 * state presents as loading and the error, with its button, unmounts in the
 * same render. Off a project route (`projectId` null) it is the deal list
 * only.
 */
export function retryDealReads(projectId: string | null): void {
  bumpGeneration("deals");
  if (projectId === null) return;
  bumpGeneration(`rail:${projectId}`);
  bumpGeneration(`step-records:${projectId}`);
}
