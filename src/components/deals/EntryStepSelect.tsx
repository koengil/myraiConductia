'use client';

import * as React from 'react';

import { FIELD_CLASS } from '@/components/discovery/CorrectionDialog';
import { MVP_DEAL_RAIL, stepDisplayNumber, type RailStep } from '@/lib/rail/dealRail';

/** "04 · Relationship Pathing": the step number on the MVP rail, then the title. */
export function entryStepLabel(step: Pick<RailStep, 'id' | 'title'>): string {
  return `${String(stepDisplayNumber(step.id, MVP_DEAL_RAIL)).padStart(2, '0')} · ${step.title}`;
}

export interface EntryStepSelectProps {
  /** The steps on offer. The caller decides the range. */
  steps: readonly RailStep[];
  /** The selected step's seq, or null when none is picked (only with a placeholder). */
  value: number | null;
  onChange: (seq: number) => void;
  disabled?: boolean;
  /** Defaults to "Starting step". */
  label?: string;
  /**
   * Shown as the unpicked choice while `value` is null (for example "Choose a step"). Without it the select always
   * has a step picked, as the wizard needs.
   */
  placeholder?: string;
}

/**
 * Where a deal enters the rail: a native select of steps, shared by the
 * promotion dialog and the New deal wizard (kit §06 filled field). The option
 * value is the canonical seq, which is what `entryStepSeq` carries to the server.
 */
export function EntryStepSelect({
  steps,
  value,
  onChange,
  disabled = false,
  label = 'Starting step',
  placeholder,
}: EntryStepSelectProps) {
  return (
    <label className="block">
      <span className="bank-label">{label}</span>
      <select
        aria-label={label}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value !== '') onChange(Number(e.target.value));
        }}
        className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {placeholder !== undefined && value === null ? <option value="">{placeholder}</option> : null}
        {steps.map((step) => (
          <option key={step.id} value={step.seq}>
            {entryStepLabel(step)}
          </option>
        ))}
      </select>
    </label>
  );
}

export default EntryStepSelect;
