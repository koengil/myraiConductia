"use client";

import * as React from "react";

import { Button } from "@/components/atoms/Button";
import type { TemplateChangeSet } from "@/lib/railTemplates/changeReview";
import { formatDate } from "@/lib/format/date";

export function formatRevisionDate(iso: string): string {
  return formatDate(iso, { timeZone: "UTC" });
}

export function TemplateChangeBanner({
  changeSet,
  pendingCount,
  onReview,
}: {
  changeSet: TemplateChangeSet;
  pendingCount: number;
  onReview: () => void;
}) {
  const { template, currentRevision } = changeSet;
  if (pendingCount === 0) {
    const hasDiscarded = changeSet.changes.some(
      (change) => change.decision === "discarded",
    );
    if (!hasDiscarded) return null;
    return (
      <BannerShell
        label="Template decisions"
        body={`${template.name} · ${currentRevision.label}. No changes waiting.`}
        action="Review decisions"
        onReview={onReview}
      />
    );
  }
  const waiting =
    pendingCount === 1 ? "1 change waits" : `${pendingCount} changes wait`;
  const body = `${template.name} moved to ${currentRevision.label} on ${formatRevisionDate(currentRevision.savedAt)} (${currentRevision.savedBy.name}). ${waiting} for your decision. Your rail stays as it is until you choose.`;

  return (
    <BannerShell
      label="Template updated"
      body={body}
      action="Review changes"
      onReview={onReview}
    />
  );
}

function BannerShell({
  label,
  body,
  action,
  onReview,
}: {
  label: string;
  body: string;
  action: string;
  onReview: () => void;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-mono text-[length:var(--text-xs)] uppercase tracking-[0.04em] text-[var(--ink-tertiary)]">
          {label}
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">{body}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onReview}>
        {action}
      </Button>
    </div>
  );
}
