'use client';

import * as React from 'react';

import {
  formatPersonSuggestionLabel,
  personSuggestionSourceLabel,
} from '@/lib/people/personSuggestionLabels';
import { usePeopleSuggestions } from '@/lib/people/usePeopleSuggestions';
import type { PersonSuggestion } from '@/lib/people/types';

const INPUT_CLASS =
  'w-full rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

function splitRecipientTokens(value: string): { prefix: string; active: string } {
  const parts = value.split(',');
  if (parts.length <= 1) return { prefix: '', active: value };
  const active = parts.pop() ?? '';
  const prefix = parts.map((part) => part.trim()).filter(Boolean).join(', ');
  return { prefix, active };
}

function joinRecipientTokens(prefix: string, token: string): string {
  const trimmed = token.trim();
  if (!prefix.trim()) return trimmed;
  if (!trimmed) return prefix;
  return `${prefix}, ${trimmed}`;
}

export type EmailListInputProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  dealId?: string | null;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
};

/**
 * EmailListInput — comma-separated recipient field with people autocomplete
 * on the token currently being typed.
 */
export function EmailListInput({
  id,
  value,
  onChange,
  dealId,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  className,
}: EmailListInputProps) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const { prefix, active } = splitRecipientTokens(value);
  const { suggestions, loading } = usePeopleSuggestions({
    query: active,
    dealId,
    enabled: open && !disabled,
  });

  const showList = open && suggestions.length > 0;

  function selectSuggestion(suggestion: PersonSuggestion) {
    const token = formatPersonSuggestionLabel(suggestion, 'email');
    onChange(joinRecipientTokens(prefix, token));
    setOpen(false);
  }

  return (
    <div className="relative flex-1">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        aria-busy={loading || undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={className ?? INPUT_CLASS}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[220px] list-none overflow-y-auto rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] p-1 shadow-[var(--elev-2)]"
        >
          {suggestions.map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSuggestion(suggestion);
                }}
                className="block w-full rounded-[var(--radius-input)] px-[var(--space-2)] py-[var(--space-1)] text-left hover:bg-[var(--surface-subtle)]"
              >
                <span className="block text-[length:var(--text-sm)] text-[var(--ink)]">
                  {suggestion.email ?? suggestion.name}
                </span>
                <span className="block text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  {[suggestion.email ? suggestion.name : null, suggestion.company, personSuggestionSourceLabel(suggestion.source)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
