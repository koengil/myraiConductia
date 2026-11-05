"use client";

import * as React from "react";

import {
  coerceFieldValue,
  type SkillInputField,
  type SkillInputValue,
  type SkillInputValues,
} from "@/lib/skillRun/inputs";

const CONTROL =
  "w-full rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] text-[length:var(--text-sm)]";

function withValue(
  values: SkillInputValues,
  name: string,
  value: SkillInputValue | undefined,
): SkillInputValues {
  const next = { ...values };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

function shown(field: SkillInputField, values: SkillInputValues): string {
  const value = values[field.name] ?? field.default;
  return value === null || value === undefined || typeof value === "boolean" ? "" : String(value);
}

export function SkillInputFields({
  fields,
  values,
  problems,
  missing,
  disabled,
  onChange,
  onCommit,
}: {
  fields: SkillInputField[];
  values: SkillInputValues;
  problems: Record<string, string>;
  missing: string | null;
  disabled: boolean;
  onChange: (next: SkillInputValues) => void;
  onCommit: (next: SkillInputValues) => void;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="space-y-[var(--space-3)]">
      {fields.map((field) => {
        const id = `skill-input-${field.name}`;
        const helpId = `${id}-help`;
        const errorId = `${id}-error`;
        const problem =
          problems[field.name] ?? (missing === field.name ? `${field.label} is required.` : null);
        const describedBy = [field.description ? helpId : null, problem ? errorId : null]
          .filter(Boolean)
          .join(" ");
        const common = {
          id,
          disabled,
          "aria-required": field.required || undefined,
          "aria-invalid": problem ? true : undefined,
          "aria-describedby": describedBy || undefined,
        };
        const update = (raw: string | boolean) => {
          const next = withValue(values, field.name, coerceFieldValue(field, raw));
          onChange(next);
          return next;
        };

        return (
          <div key={field.name} className="space-y-[var(--space-1)]">
            <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {field.label}
              {field.required ? <span className="text-[var(--ink-tertiary)]"> required</span> : null}
            </label>
            {field.type === "textarea" ? (
              <textarea
                {...common}
                rows={4}
                value={shown(field, values)}
                className={CONTROL}
                onChange={(e) => update(e.target.value)}
                onBlur={() => onCommit(values)}
              />
            ) : field.type === "enum" ? (
              <select
                {...common}
                value={shown(field, values)}
                className={CONTROL}
                onChange={(e) => onCommit(update(e.target.value))}
              >
                <option value="">Not specified</option>
                {field.values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : field.type === "boolean" ? (
              <input
                {...common}
                type="checkbox"
                checked={values[field.name] === true}
                onChange={(e) => onCommit(update(e.target.checked))}
              />
            ) : (
              <input
                {...common}
                value={shown(field, values)}
                className={CONTROL}
                type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                onChange={(e) => update(e.target.value)}
                onBlur={() => onCommit(values)}
              />
            )}
            {field.description ? (
              <p id={helpId} className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {field.description}
              </p>
            ) : null}
            {problem ? (
              <p id={errorId} className="text-[length:var(--text-xs)] text-[var(--negative-deep)]">
                {problem}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
