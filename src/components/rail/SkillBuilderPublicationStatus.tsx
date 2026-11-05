"use client";

import * as React from "react";

import type { PublicationRead } from "@/lib/skillPublication/types";
import type { PublicationCommandError } from "@/lib/skillAuthoring/publicationClient";
import {
  commandErrorMessage,
  publicationStateLabel,
  RECEIPT_CONFLICT_DETAIL,
  RECONCILING_DETAIL,
} from "./publicationCopy";

const VISIBLE_REGION_CLASS =
  "mt-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] p-[var(--space-3)]";
const SR_ONLY_REGION_CLASS = "absolute h-px w-px overflow-clip";

function reconcilingDetail(publication: PublicationRead): string {
  return publication.error?.code === "receipt_conflict"
    ? RECEIPT_CONFLICT_DETAIL
    : RECONCILING_DETAIL;
}

export function PublicationStatusRegion({
  publication,
}: {
  publication: PublicationRead | null;
}) {
  const label = publication ? publicationStateLabel(publication.state) : null;
  const isReconciling = publication?.state === "reconciling";
  const hasContent = Boolean(label) || isReconciling;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Save status"
      className={hasContent ? VISIBLE_REGION_CLASS : SR_ONLY_REGION_CLASS}
    >
      {label ? (
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          {label}
        </p>
      ) : null}
      {isReconciling && publication ? (
        <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {reconcilingDetail(publication)}
        </p>
      ) : null}
    </div>
  );
}

export function CommandErrorAlert({
  error,
  isPlacementContext = false,
}: {
  error: PublicationCommandError | null;
  isPlacementContext?: boolean;
}) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="mt-[var(--space-3)] rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--negative-deep)_28%,transparent)] bg-[color-mix(in_srgb,var(--negative-fill)_40%,var(--surface))] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
    >
      {commandErrorMessage(error.kind, error.code, isPlacementContext)}
    </p>
  );
}
