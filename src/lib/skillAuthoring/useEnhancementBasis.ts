"use client";

import * as React from "react";

import { stepTitle as railStepTitle, type ProjectRail } from "@/lib/rail/projectRail";
import type { CapabilityContract } from "@/lib/skillPublication/types";
import type { SkillReference, SkillRunSummary } from "@/lib/skillRun/types";
import type { StepVersions, VersionOption } from "@/lib/skillRun/versions";
import type { TurnCandidatePreview } from "./ignatiousAuthoring";
import { formatDateTime } from '@/lib/format/date';

export type BasisVersionSummary = {
  label: string;
  authorName: string | null;
  createdAt: string | null;
};

export type BasisRunSummary = {
  id: string;
  label: string;
};

export type EnhancementBasis = {
  stepTitle: string;
  version: BasisVersionSummary | null;
  versionError: boolean;
  seedRunAttached: boolean;
  seedRun: BasisRunSummary | null;
  runsError: boolean;
  ancestor: TurnCandidatePreview | null;
};

export function matchesReference(
  option: VersionOption,
  reference: SkillReference,
): boolean {
  if (option.reference.kind !== reference.kind) return false;
  if (option.reference.kind === "publication" && reference.kind === "publication") {
    return option.reference.versionId === reference.versionId;
  }
  if (option.reference.kind === "mount" && reference.kind === "mount") {
    return (
      option.reference.name === reference.name &&
      option.reference.version === reference.version
    );
  }
  return false;
}

export function runOutcomeLabel(outcome: SkillRunSummary["outcome"]): string {
  return outcome === "succeeded" ? "succeeded" : "failed";
}

export function toRunSummary(run: SkillRunSummary): BasisRunSummary {
  return {
    id: run.id,
    label: `${run.actorName} · ${formatDateTime(run.createdAt)} · ${runOutcomeLabel(run.outcome)}`,
  };
}

export function ancestorFromContract(
  contract: CapabilityContract | null | undefined,
): TurnCandidatePreview | null {
  if (!contract) return null;
  return {
    name: "",
    purpose: contract.purpose,
    expectedInput: contract.expectedInput,
    expectedOutput: contract.expectedOutput,
    inputs: [],
  };
}

export function stepVersionsPath(dealId: string, basisStepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(basisStepId)}/skill-versions`;
}

export function stepRunsPath(dealId: string, basisStepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(basisStepId)}/skill-runs`;
}

function resolvedVersionOption(
  data: StepVersions,
  stored: SkillReference | null,
): BasisVersionSummary | null {
  const reference = stored ?? data.current;
  if (!reference) return null;
  const option = [...data.project, ...data.catalog].find((candidate) =>
    matchesReference(candidate, reference),
  );
  if (!option) return null;
  return {
    label: option.label,
    authorName: option.authorName,
    createdAt: option.createdAt,
  };
}

export function useEnhancementBasis(
  dealId: string,
  rail: ProjectRail,
  basisStepId: string | undefined,
  seedRunId: string | undefined,
  storedBasis: SkillReference | null = null,
): EnhancementBasis {
  const [version, setVersion] = React.useState<BasisVersionSummary | null>(
    null,
  );
  const [versionError, setVersionError] = React.useState(false);
  const [ancestor, setAncestor] = React.useState<TurnCandidatePreview | null>(
    null,
  );
  const [runs, setRuns] = React.useState<SkillRunSummary[]>([]);
  const [runsError, setRunsError] = React.useState(false);

  React.useEffect(() => {
    if (!basisStepId) return undefined;
    let alive = true;

    void fetch(stepVersionsPath(dealId, basisStepId), {
      credentials: "include",
    })
      .then((response) => {
        if (!response.ok) throw new Error("skill-versions request failed");
        return response.json() as Promise<StepVersions>;
      })
      .then((data) => {
        if (!alive) return;
        setVersion(resolvedVersionOption(data, storedBasis));
        setAncestor(ancestorFromContract(data.ancestorContract));
        setVersionError(false);
      })
      .catch(() => {
        if (!alive) return;
        setVersionError(true);
      });

    void fetch(stepRunsPath(dealId, basisStepId), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("skill-runs request failed");
        return response.json() as Promise<{ runs?: SkillRunSummary[] }>;
      })
      .then((data) => {
        if (!alive) return;
        setRuns(data.runs ?? []);
        setRunsError(false);
      })
      .catch(() => {
        if (!alive) return;
        setRunsError(true);
      });

    return () => {
      alive = false;
    };
  }, [dealId, basisStepId, storedBasis]);

  const step = basisStepId
    ? rail.steps.find((candidate) => candidate.stepId === basisStepId)
    : undefined;
  const title = step ? railStepTitle(step) : (basisStepId ?? "");
  const seedRun = seedRunId
    ? (runs.map(toRunSummary).find((run) => run.id === seedRunId) ?? null)
    : null;

  return {
    stepTitle: title,
    version,
    versionError,
    seedRunAttached: Boolean(seedRunId),
    seedRun,
    runsError,
    ancestor,
  };
}
