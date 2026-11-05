"use client";

import * as React from "react";

import {
  pendingDealForCode,
  resolveActiveDeal,
  useDealListSource,
  useDeals,
} from "@/lib/deals/useDeals";
import { useFlag } from "@/lib/flags/FlagsContext";
import {
  bumpGeneration,
  generationOfError,
  isCurrentGeneration,
  readGeneration,
  sharedRead,
  SharedReadError,
  subscribeGeneration,
  type ReadKey,
} from "@/lib/api/inflightRead";
import { STEP_STATUS, type StepStatus } from "@/lib/constants/dealSteps";
import { RAIL_LOAD_DEADLINE_MS } from "@/lib/rail/railLoadStage";
import {
  DEAL_RAIL,
  MVP_DEAL_RAIL,
  orderedSteps,
  phaseForStep,
  stepIndexById,
  type RailStep,
} from "@/lib/rail/dealRail";
import { type DealStepRecord, withServerSkips } from "@/lib/rail/dealStepRecord";
import { useDealStepRecords } from "@/lib/rail/serverStep";
import { submitLoggedSkip, submitSkip } from "@/lib/rail/submitSkip";
import {
  hasExactKeys,
  isRecord,
  parseSkillStepDefinitionV1,
} from "@/lib/skillPublication/parse";
import type {
  SkillBinding,
  SkillStepDefinitionV1,
} from "@/lib/skillPublication/types";

export type ManualStepDefinition = { title: string; description: string };

export type ProjectRailStep = {
  id: string;
  stepId: string;
  origin: "catalog" | "custom";
  phaseIndex: number;
  displayOrder: number;
  seq: number | null;
  status: StepStatus;
  definition: ManualStepDefinition | SkillStepDefinitionV1 | null;
  anchorStepId: string | null;
  removedAt: string | null;
  removedBy: { id: string; name: string } | null;
  skip: {
    at: string;
    by: string;
    approver: string;
    reason: string;
    /** False when the approver is text recorded before the database verified it. */
    approverVerified?: boolean;
  } | null;
  catalog?: RailStep;
};

function isManualDefinition(
  value: Record<string, unknown>,
): value is ManualStepDefinition {
  return (
    hasExactKeys(value, ["title", "description"]) &&
    typeof value.title === "string" &&
    typeof value.description === "string"
  );
}

function parseStepDefinition(raw: unknown): ProjectRailStep["definition"] {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (isRecord(raw) && isManualDefinition(raw)) {
    return raw;
  }
  const parsed = parseSkillStepDefinitionV1(raw);
  return "error" in parsed ? null : parsed;
}

export function skillBindingForStep(
  step: ProjectRailStep,
): SkillBinding | null {
  if (step.definition === null) {
    return null;
  }
  const parsed = parseSkillStepDefinitionV1(step.definition);
  return "error" in parsed ? null : parsed.skillBinding;
}

export type StepSkipRecord = NonNullable<ProjectRailStep["skip"]>;

export type ProjectRail = {
  currentStepId: string | null;
  canEditStructure: boolean;
  canSaveTemplate: boolean;
  phases: { index: number; name: string; dealStatus: string }[];
  steps: ProjectRailStep[];
};

export function stepTitle(step: ProjectRailStep): string {
  return step.definition?.title ?? step.catalog?.title ?? step.stepId;
}

export function stepDescription(step: ProjectRailStep): string {
  return step.definition?.description ?? step.catalog?.description ?? "";
}

export function activeSteps(rail: ProjectRail): ProjectRailStep[] {
  return rail.steps
    .filter((step) => step.removedAt === null)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

export function nextOpenStepIndex(
  steps: readonly ProjectRailStep[],
  index: number,
): number {
  return steps.findIndex(
    (step, i) =>
      i > index &&
      (step.status === STEP_STATUS.PENDING || step.status === STEP_STATUS.CURRENT),
  );
}

export function removedSteps(rail: ProjectRail): ProjectRailStep[] {
  return rail.steps.filter((step) => step.removedAt !== null);
}

export function railIsStructured(rail: ProjectRail): boolean {
  const rows: ReadonlyArray<{
    phaseIndex: number | null;
    displayOrder: number | null;
  }> = rail.steps;
  return rows.every(
    (step) => step.phaseIndex != null && step.displayOrder != null,
  );
}

export function catalogFor(stepId: string): RailStep | undefined {
  return (
    orderedSteps(MVP_DEAL_RAIL).find((step) => step.id === stepId) ??
    orderedSteps(DEAL_RAIL).find((step) => step.id === stepId)
  );
}

function phaseIndexForStep(stepId: string): number {
  return phaseForStep(stepId, MVP_DEAL_RAIL)?.index ?? 0;
}

/**
 * The flag-off rail, derived from the deal cursor and its entry step.
 * Steps before the entry are `skipped_entry`, as `create_deal_gate0_core`
 * seeds them on the server, so both producers render "Before entry" alike.
 * An entry seq that names no step on the rail (the default 1) means the
 * deal opened at the start: nothing precedes it, and the rail reads as it
 * always has. That also keeps the synthetic notify step (seq 0) out of it.
 */
export function railFromCatalog(cursorStepId: string, entryStepSeq = 1): ProjectRail {
  const catalog = orderedSteps(MVP_DEAL_RAIL);
  const cursor = Math.max(0, stepIndexById(cursorStepId, MVP_DEAL_RAIL));
  const entryOnRail = catalog.some((step) => step.seq === entryStepSeq);

  return {
    currentStepId: catalog[cursor]?.id ?? null,
    canEditStructure: false,
    canSaveTemplate: false,
    phases: MVP_DEAL_RAIL.map((phase) => ({
      index: phase.index,
      name: phase.name,
      dealStatus: phase.dealStatus,
    })),
    steps: catalog.map((step, index) => ({
      id: step.id,
      stepId: step.id,
      origin: "catalog" as const,
      phaseIndex: phaseIndexForStep(step.id),
      displayOrder: index + 1,
      seq: step.seq,
      // The cursor is always actionable, even if it sits before the entry.
      status:
        index === cursor
          ? STEP_STATUS.CURRENT
          : entryOnRail && step.seq < entryStepSeq
            ? STEP_STATUS.SKIPPED_ENTRY
            : index < cursor
              ? STEP_STATUS.COMPLETE
              : STEP_STATUS.PENDING,
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: null,
      catalog: step,
    })),
  };
}

export type SkipStepInput = {
  approverId: string;
  approverName: string;
  reason: string;
};

export type SkipStepOutcome = {
  statusOverrides?: Record<string, StepStatus>;
  advanceTo?: ProjectRailStep;
  skipRecord?: { id: string; skip: StepSkipRecord };
};

export type SkipStepAction = (
  steps: readonly ProjectRailStep[],
  step: ProjectRailStep,
  input: SkipStepInput,
) => Promise<SkipStepOutcome>;

export type ProjectRailState = {
  rail: ProjectRail | null;
  status: "loading" | "ready" | "error";
  /** With status "error": the server refused this caller (403), so a retry cannot help. */
  forbidden?: boolean;
  /** With status "error": the server answered 404, the deal is not one this caller is on. */
  notOnDeal?: boolean;
  refresh: () => void;
  skipStep: SkipStepAction;
  stepRecords: readonly DealStepRecord[];
  /** Re-read only the step records (owners, completers), keeping the rail on
   *  screen: the rail's focus and 30-second refresh uses this, never `refresh`. */
  refreshStepRecords: () => void;
  /** The step-records read failed with no good read: owners are unknown. */
  stepRecordsFailed?: boolean;
};

type ServerRailStep = Omit<ProjectRailStep, "definition" | "catalog"> & {
  definition: unknown;
  censusVersion?: unknown;
  assignedTo?: unknown;
};
type ServerRailPhase = ProjectRail["phases"][number] & {
  roles?: unknown;
  tools?: unknown;
};
type ServerRail = {
  currentStepId: string | null;
  canEditStructure: boolean;
  canSaveTemplate: boolean;
  phases: ServerRailPhase[];
  steps: ServerRailStep[];
};

export function projectServerRail(body: ServerRail): ProjectRail {
  return {
    currentStepId: body.currentStepId,
    canEditStructure: body.canEditStructure,
    canSaveTemplate: body.canSaveTemplate,
    phases: body.phases.map((phase) => ({
      index: phase.index,
      name: phase.name,
      dealStatus: phase.dealStatus,
    })),
    steps: body.steps.map((step) => ({
      id: step.id,
      stepId: step.stepId,
      origin: step.origin,
      phaseIndex: step.phaseIndex,
      displayOrder: step.displayOrder,
      seq: step.seq,
      status: step.status,
      definition: parseStepDefinition(step.definition),
      anchorStepId: step.anchorStepId,
      removedAt: step.removedAt,
      removedBy: step.removedBy,
      skip: step.skip,
      catalog: catalogFor(step.stepId),
    })),
  };
}

/** A rail read the server answered with a non-2xx status. */
class RailReadError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.name = "RailReadError";
    this.status = status;
  }
}

function isForbiddenRead(error: unknown): boolean {
  const reason = error instanceof SharedReadError ? error.reason : error;
  return reason instanceof RailReadError && reason.status === 403;
}

/** The rail route answers 404 for a deal the caller is not on (and for one that does not exist). */
function isNotFoundRead(error: unknown): boolean {
  const reason = error instanceof SharedReadError ? error.reason : error;
  return reason instanceof RailReadError && reason.status === 404;
}

async function fetchProjectRail(
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectRail> {
  const res = await fetch(`/api/v1/deals/${encodeURIComponent(projectId)}/rail`, {
    credentials: "include",
    // User-scoped and never cacheable: no-store keeps identical concurrent reads out of Chromium's HTTP cache lock (#162).
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new RailReadError(res.status);
  const body = (await res.json()) as ServerRail;
  return projectServerRail(body);
}

export function useProjectRail(
  projectId: string,
  options: { withStepRecords?: boolean } = {},
): ProjectRailState {
  const serverModel = useFlag("project_rail_model");
  const apiCreateEnabled = useFlag("gate0_api_create");
  const { deals } = useDeals();
  const source = useDealListSource();
  const deal = resolveActiveDeal(projectId, deals, source) ?? pendingDealForCode(projectId);
  const isRealDeal = apiCreateEnabled && deals.some((d) => d.id === projectId);
  const {
    records: stepRecords,
    refresh: refreshStepRecords,
    failed: stepRecordsFailed,
  } = useDealStepRecords(
    projectId,
    isRealDeal && options.withStepRecords === true,
  );
  const railKey: ReadKey = `rail:${projectId}`;
  const generation = React.useSyncExternalStore(
    subscribeGeneration,
    () => readGeneration(railKey),
    () => readGeneration(railKey),
  );
  const [fetched, setFetched] = React.useState<{
    projectId: string;
    generation: number;
    rail: ProjectRail | null;
    status: "loading" | "ready" | "error";
    forbidden?: boolean;
    notOnDeal?: boolean;
  }>({ projectId, generation: -1, rail: null, status: "loading" });

  // Every mounted instance for this project (DealRail, DealContextBar) goes
  // stale together and re-joins one fresh read: skip, restore and publish
  // refresh the whole page with a single request.
  const refresh = React.useCallback(
    () => bumpGeneration(`rail:${projectId}`),
    [projectId],
  );

  const skipStep = React.useCallback<SkipStepAction>(
    async (steps, step, input) => {
      if (serverModel) {
        await submitSkip(projectId, step.id, {
          approverId: input.approverId,
          reason: input.reason,
        });
        refresh();
        return {};
      }

      if (isRealDeal) {
        await submitLoggedSkip(projectId, step.stepId, {
          approverId: input.approverId,
          reason: input.reason,
        });
        refreshStepRecords();
      }

      const index = steps.findIndex(
        (s) => s.id === step.id && s.status === STEP_STATUS.CURRENT,
      );
      if (index < 0) return {};
      const next = steps[index + 1];
      return {
        statusOverrides: {
          [steps[index].id]: STEP_STATUS.SKIPPED,
          ...(next ? { [next.id]: STEP_STATUS.CURRENT } : {}),
        },
        advanceTo: next,
        skipRecord: {
          id: steps[index].id,
          skip: {
            at: new Date().toISOString(),
            by: input.approverId,
            approver: input.approverName,
            reason: input.reason,
          },
        },
      };
    },
    [serverModel, isRealDeal, projectId, refresh, refreshStepRecords],
  );

  React.useEffect(() => {
    if (!serverModel) return;
    let active = true;
    const key: ReadKey = `rail:${projectId}`;

    // One in-flight GET …/rail per project and generation (#162); a result or
    // rejection from an older generation is dropped.
    // Bounded: past RAIL_LOAD_DEADLINE_MS the read rejects as a timeout and
    // the rail shows its error with Try again.
    sharedRead(key, (signal) => fetchProjectRail(projectId, signal), {
      deadlineMs: RAIL_LOAD_DEADLINE_MS,
    }).then(
      ({ generation: readAt, value }) => {
        if (!active || !isCurrentGeneration(key, readAt)) return;
        setFetched({ projectId, generation: readAt, rail: value, status: "ready" });
      },
      (error: unknown) => {
        const readAt = generationOfError(error);
        if (!active || readAt === null || !isCurrentGeneration(key, readAt)) return;
        setFetched({
          projectId,
          generation: readAt,
          rail: null,
          status: "error",
          forbidden: isForbiddenRead(error),
          notOnDeal: isNotFoundRead(error),
        });
      },
    );

    return () => {
      active = false;
    };
  }, [serverModel, projectId, generation]);

  if (!serverModel) {
    const rail = railFromCatalog(deal.cursorStepId, deal.entryStepSeq);
    return {
      rail: { ...rail, steps: withServerSkips(rail.steps, stepRecords) },
      status: "ready",
      refresh,
      skipStep,
      stepRecords,
      refreshStepRecords,
      stepRecordsFailed,
    };
  }

  if (fetched.projectId !== projectId || fetched.generation !== generation) {
    return { rail: null, status: "loading", refresh, skipStep, stepRecords, refreshStepRecords, stepRecordsFailed };
  }
  return {
    rail: fetched.rail,
    status: fetched.status,
    ...(fetched.forbidden ? { forbidden: true } : {}),
    ...(fetched.notOnDeal ? { notOnDeal: true } : {}),
    refresh,
    skipStep,
    stepRecords,
    refreshStepRecords,
    stepRecordsFailed,
  };
}
