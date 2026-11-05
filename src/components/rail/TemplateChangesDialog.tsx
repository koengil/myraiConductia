"use client";

import * as React from "react";

import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { stepTitle, type ProjectRail } from "@/lib/rail/projectRail";
import type {
  TemplateChange,
  TemplateChangeDecision,
  TemplateChangeSet,
} from "@/lib/railTemplates/changeReview";
import { Dialog } from "@/components/overlay";

import { formatRevisionDate } from "./TemplateChangeBanner";

const FOOTER_TEXT =
  "Nothing changes on your rail until you decide. Discarded changes are not offered again unless you undo them.";
const READ_ONLY_TEXT = "Only the deal team can change this rail.";

const ACTION_LABEL: Record<TemplateChange["kind"], { accept: string; discard: string }> = {
  added: { accept: "Add", discard: "Discard" },
  removed: { accept: "Remove", discard: "Keep" },
};

const DECIDED: Record<
  TemplateChange["kind"],
  Record<TemplateChangeDecision, { label: string; tone: "positive" | "neutral" }>
> = {
  added: {
    accepted: { label: "Added", tone: "positive" },
    discarded: { label: "Discarded", tone: "neutral" },
  },
  removed: {
    accepted: { label: "Removed", tone: "positive" },
    discarded: { label: "Kept", tone: "neutral" },
  },
};

function phaseName(rail: ProjectRail, index: number): string {
  return rail.phases.find((phase) => phase.index === index)?.name ?? `Phase ${index}`;
}

function changeMeta(rail: ProjectRail, change: TemplateChange): string {
  const phase = phaseName(rail, change.phaseIndex);
  if (change.kind === "removed") {
    return change.decision === "accepted"
      ? `${phase} · Off your rail`
      : `${phase} · On your rail today`;
  }
  if (change.anchor === null) return `${phase} · Start of phase`;
  const { position, stepId } = change.anchor;
  const anchor = rail.steps.find(
    (step) => step.removedAt === null && step.stepId === stepId,
  );
  if (!anchor) return phase;
  return `${phase} · ${position === "after" ? "After" : "Before"} ${stepTitle(anchor)}`;
}

/**
 * One reviewable change with Accept / Discard (or its decided badge and, for
 * a discard, Undo). The deal lead's proposal tray reuses this layout.
 */
export function ReviewDecisionRow({
  title,
  meta,
  summary,
  decided,
  discarded,
  acceptLabel,
  discardLabel,
  canDecide,
  onAccept,
  onDiscard,
  onUndo,
}: {
  title: string;
  meta: string;
  /** Shown while the change is undecided. */
  summary?: string | null;
  /** The decided badge; null while undecided. */
  decided: { label: string; tone: "positive" | "neutral" } | null;
  /** A discarded change offers Undo. */
  discarded: boolean;
  acceptLabel: string;
  discardLabel: string;
  canDecide: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}) {
  return (
    <li className="rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
      <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
            {title}
          </p>
          <p className="mt-0.5 font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
            {meta}
          </p>
          {summary && decided === null ? (
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              {summary}
            </p>
          ) : null}
        </div>
        {decided ? (
          <div className="flex shrink-0 items-center gap-[var(--space-2)]">
            <Badge tone={decided.tone}>{decided.label}</Badge>
            {discarded ? (
              <button
                type="button"
                disabled={!canDecide}
                onClick={onUndo}
                aria-label={`Undo ${title}`}
                className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-2 hover:text-[var(--ink)] disabled:opacity-60"
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-[var(--space-2)]">
            <Button
              variant="primary"
              size="sm"
              disabled={!canDecide}
              onClick={onAccept}
              aria-label={`${acceptLabel} ${title}`}
            >
              {acceptLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDecide}
              onClick={onDiscard}
              aria-label={`${discardLabel} ${title}`}
            >
              {discardLabel}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function ChangeRow({
  change,
  meta,
  canDecide,
  onDecide,
  onReopen,
}: {
  change: TemplateChange;
  meta: string;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onReopen: (changeId: string) => void;
}) {
  const actions = ACTION_LABEL[change.kind];
  const { decision } = change;
  return (
    <ReviewDecisionRow
      title={change.title}
      meta={meta}
      summary={change.kind === "added" ? change.summary : null}
      decided={decision ? DECIDED[change.kind][decision] : null}
      discarded={decision === "discarded"}
      acceptLabel={actions.accept}
      discardLabel={actions.discard}
      canDecide={canDecide}
      onAccept={() => onDecide(change.id, "accepted")}
      onDiscard={() => onDecide(change.id, "discarded")}
      onUndo={() => onReopen(change.id)}
    />
  );
}

function ChangeSection({
  id,
  title,
  changes,
  rail,
  canDecide,
  onDecide,
  onReopen,
}: {
  id: string;
  title: string;
  changes: TemplateChange[];
  rail: ProjectRail;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onReopen: (changeId: string) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <section aria-labelledby={id} className="mt-[var(--space-4)]">
      <h3
        id={id}
        className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.04em] text-[var(--ink-tertiary)]"
      >
        {title}
      </h3>
      <ul className="mt-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
        {changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            meta={changeMeta(rail, change)}
            canDecide={canDecide}
            onDecide={onDecide}
            onReopen={onReopen}
          />
        ))}
      </ul>
    </section>
  );
}

export function TemplateChangesDialog({
  changeSet,
  rail,
  canDecide,
  busy,
  error,
  onDecide,
  onReopen,
  onClose,
}: {
  changeSet: TemplateChangeSet;
  rail: ProjectRail;
  canDecide: boolean;
  busy: boolean;
  error: string | null;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onReopen: (changeId: string) => void;
  onClose: () => void;
}) {
  const { template, baseRevision, currentRevision } = changeSet;
  const sectionProps = { rail, canDecide: canDecide && !busy, onDecide, onReopen };

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Company rail"
      title={`${template.name} · ${baseRevision.label} → ${currentRevision.label}`}
      description={`Saved ${formatRevisionDate(currentRevision.savedAt)} by ${currentRevision.savedBy.name}`}
      size="lg"
    >
      {canDecide ? null : (
        <p className="mt-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {READ_ONLY_TEXT}
        </p>
      )}
      {error ? (
        <p
          role="alert"
          className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)]"
        >
          {error}
        </p>
      ) : null}
      <ChangeSection
        id="template-changes-added"
        title="Added to the template"
        changes={changeSet.changes.filter((change) => change.kind === "added")}
        {...sectionProps}
      />
      <ChangeSection
        id="template-changes-removed"
        title="Removed from the template"
        changes={changeSet.changes.filter((change) => change.kind === "removed")}
        {...sectionProps}
      />
      <p className="mt-[var(--space-4)] border-t border-[var(--stroke)] pt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {FOOTER_TEXT}
      </p>
    </Dialog>
  );
}
