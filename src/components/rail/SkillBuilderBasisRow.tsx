"use client";

import * as React from "react";

import type {
  BasisRunSummary,
  BasisVersionSummary,
} from "@/lib/skillAuthoring/useEnhancementBasis";
import { formatDate } from '@/lib/format/date';

export type SkillBuilderBasisRowProps = {
  stepTitle: string;
  version: BasisVersionSummary | null;
  versionError: boolean;
  seedRunAttached: boolean;
  seedRun: BasisRunSummary | null;
  runsError: boolean;
};

const VERSION_UNAVAILABLE_TEXT =
  "Version details are unavailable right now.";
const VERSION_NONE_TEXT = "No version resolved for this step.";
const SEED_RUN_NONE_TEXT = "No seed run attached.";
const SEED_RUN_DETAILS_UNAVAILABLE_TEXT =
  "Seed run attached. Run details are unavailable right now.";

function versionDateLabel(createdAt: string | null): string | null {
  if (!createdAt) return null;
  return formatDate(createdAt) || null;
}

function VersionSummary({
  version,
  versionError,
}: {
  version: BasisVersionSummary | null;
  versionError: boolean;
}) {
  if (versionError)
    return (
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        {VERSION_UNAVAILABLE_TEXT}
      </p>
    );
  if (!version)
    return (
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        {VERSION_NONE_TEXT}
      </p>
    );
  const date = versionDateLabel(version.createdAt);
  const parts = [version.label, version.authorName, date].filter(
    (part): part is string => Boolean(part),
  );
  return (
    <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">
      {parts.join(" · ")}
    </p>
  );
}

function SeedRunSummary({
  seedRunAttached,
  seedRun,
  runsError,
}: {
  seedRunAttached: boolean;
  seedRun: BasisRunSummary | null;
  runsError: boolean;
}) {
  if (!seedRunAttached)
    return (
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        {SEED_RUN_NONE_TEXT}
      </p>
    );
  if (runsError || !seedRun)
    return (
      <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        {SEED_RUN_DETAILS_UNAVAILABLE_TEXT}
      </p>
    );
  return (
    <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">
      {seedRun.label}
    </p>
  );
}

export function SkillBuilderBasisRow({
  stepTitle,
  version,
  versionError,
  seedRunAttached,
  seedRun,
  runsError,
}: SkillBuilderBasisRowProps) {
  return (
    <div className="grid gap-[var(--space-2)] md:grid-cols-3">
      <div>
        <span className="bank-label">Step</span>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink)]">
          {stepTitle}
        </p>
      </div>
      <div>
        <span className="bank-label">Version</span>
        <VersionSummary version={version} versionError={versionError} />
      </div>
      <div>
        <span className="bank-label">Seed run</span>
        <SeedRunSummary
          seedRunAttached={seedRunAttached}
          seedRun={seedRun}
          runsError={runsError}
        />
      </div>
    </div>
  );
}
