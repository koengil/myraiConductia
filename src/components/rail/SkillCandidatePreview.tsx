"use client";

import * as React from "react";

import type { CandidatePreview } from "@/lib/skillAuthoring/types";
import type { TurnCandidatePreview } from "@/lib/skillAuthoring/ignatiousAuthoring";
import type { SkillInputField, SkillInputType } from "@/lib/skillRun/inputs";

const PANE_CLASS =
  "flex max-h-[30vh] min-h-14 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] md:max-h-none md:min-h-0";
const PANE_HEADER_CLASS =
  "eyebrow shrink-0 border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)]";
const PANE_BODY_CLASS =
  "min-h-0 flex-1 overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]";

function AncestorValue({ value }: { value: string | undefined }) {
  if (!value) return null;
  return (
    <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
      Was: {value}
    </p>
  );
}

const KIND_LABEL: Record<SkillInputType, string> = {
  string: "Short text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  enum: "Choice",
  boolean: "Yes or no",
};

function CandidateInputRow({ field }: { field: SkillInputField }) {
  return (
    <li className="text-[length:var(--text-sm)] text-[var(--ink)]">
      <span>{field.label}</span>
      <span>, </span>
      <span>{KIND_LABEL[field.type]}</span>
      {field.required ? (
        <>
          <span>, </span>
          <span>Required</span>
        </>
      ) : null}
      {field.type === "enum" ? (
        <>
          <span>, </span>
          <span>{field.values.join(", ")}</span>
        </>
      ) : null}
    </li>
  );
}

function CandidateInputs({ inputs }: { inputs: SkillInputField[] | undefined }) {
  const fields = inputs ?? [];
  return (
    <div>
      <dt className="bank-label">Inputs</dt>
      <dd className="text-[length:var(--text-sm)] text-[var(--ink)]">
        {fields.length === 0 ? (
          "No inputs. Runs on deal context and instructions."
        ) : (
          <ul className="space-y-[var(--space-1)]">
            {fields.map((field) => (
              <CandidateInputRow key={field.name} field={field} />
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function CandidateFields({
  candidate,
  ancestor,
}: {
  candidate: CandidatePreview;
  ancestor: TurnCandidatePreview | null;
}) {
  return (
    <dl className="mt-[var(--space-3)] space-y-[var(--space-3)]">
      <div>
        <dt className="bank-label">Purpose</dt>
        <AncestorValue value={ancestor?.purpose} />
        <dd className="text-[length:var(--text-sm)] text-[var(--ink)]">
          {candidate.purpose}
        </dd>
      </div>
      <div>
        <dt className="bank-label">Expected input</dt>
        <AncestorValue value={ancestor?.expectedInput} />
        <dd className="text-[length:var(--text-sm)] text-[var(--ink)]">
          {candidate.expectedInput}
        </dd>
      </div>
      <div>
        <dt className="bank-label">Expected output</dt>
        <AncestorValue value={ancestor?.expectedOutput} />
        <dd className="text-[length:var(--text-sm)] text-[var(--ink)]">
          {candidate.expectedOutput}
        </dd>
      </div>
      <CandidateInputs inputs={candidate.inputs} />
    </dl>
  );
}

function CandidateBody({
  candidate,
  ancestor,
  enhancing,
}: {
  candidate: CandidatePreview;
  ancestor: TurnCandidatePreview | null;
  enhancing: boolean;
}) {
  return (
    <div>
      <h3 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
        {candidate.name}
      </h3>
      <AncestorValue value={ancestor?.name} />
      <CandidateFields candidate={candidate} ancestor={ancestor} />
      <p className="mt-[var(--space-4)] rounded-[var(--radius-input)] border border-[color-mix(in_srgb,var(--positive-deep)_24%,transparent)] bg-[color-mix(in_srgb,var(--positive-fill)_40%,var(--surface))] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--positive-deep)]">
        {enhancing ? "Ready to publish" : "Ready to save"}
      </p>
    </div>
  );
}

function PreviewEmptyState() {
  return (
    <div className="py-[var(--space-6)] text-center">
      <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
        No candidate skill yet.
      </p>
    </div>
  );
}

export function SkillCandidatePreview({
  candidate,
  ancestor = null,
  enhancing = false,
}: {
  candidate: CandidatePreview | null;
  ancestor?: TurnCandidatePreview | null;
  enhancing?: boolean;
}) {
  return (
    <section className={PANE_CLASS}>
      <p className={PANE_HEADER_CLASS}>Skill preview</p>
      <div className={PANE_BODY_CLASS}>
        {candidate ? (
          <CandidateBody
            candidate={candidate}
            ancestor={ancestor}
            enhancing={enhancing}
          />
        ) : (
          <PreviewEmptyState />
        )}
      </div>
    </section>
  );
}
