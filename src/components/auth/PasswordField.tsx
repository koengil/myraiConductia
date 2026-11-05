'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

const INPUT_CLASS =
  'w-full rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] py-[var(--space-2)] pl-[var(--space-3)] pr-[var(--space-10)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]';

const TOGGLE_CLASS =
  'absolute inset-y-0 right-0 flex items-center px-[var(--space-3)] text-[var(--ink-tertiary)] transition-colors hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:rounded-[var(--radius-input)]';

export type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder?: string;
  minLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  describedById?: string;
  invalid?: boolean;
  children?: React.ReactNode;
};

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
  required,
  autoFocus,
  describedById,
  invalid,
  children,
}: PasswordFieldProps) {
  const inputId = useId();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
      <label htmlFor={inputId}>{label}</label>
      <div className="relative">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={INPUT_CLASS}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          autoFocus={autoFocus}
          aria-describedby={describedById}
          aria-invalid={invalid || undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          aria-controls={inputId}
          title={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className={TOGGLE_CLASS}
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  );
}
