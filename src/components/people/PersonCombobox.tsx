'use client';

import * as React from 'react';

import {
  formatPersonSuggestionLabel,
  personSuggestionSourceLabel,
} from '@/lib/people/personSuggestionLabels';
import { usePeopleSuggestions } from '@/lib/people/usePeopleSuggestions';
import type { PersonSearchScope, PersonSuggestion } from '@/lib/people/types';

const INPUT_CLASS =
  'rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

export type PersonComboboxProps = {
  id?: string;
  value: string;
  onChange: (value: string, selected?: boolean) => void;
  /** person — fill display name; email — prefer address when present. */
  mode?: 'person' | 'email';
  dealId?: string | null;
  companyId?: string | null;
  scope?: PersonSearchScope;
  /** When true, callers should only persist after a list selection (selected === true). */
  requireSelection?: boolean;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
};

/**
 * PersonCombobox — debounced people search with optional free-text fallback.
 * Pattern follows Gate 0 conflict approver (onMouseDown before blur).
 */
export function PersonCombobox({
  id,
  value,
  onChange,
  mode = 'person',
  dealId,
  companyId,
  scope,
  requireSelection = false,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  className,
}: PersonComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const { suggestions, loading } = usePeopleSuggestions({
    query: value,
    dealId,
    companyId,
    scope,
    enabled: open && !disabled,
  });

  const showList = open && suggestions.length > 0;

  function selectSuggestion(suggestion: PersonSuggestion) {
    onChange(formatPersonSuggestionLabel(suggestion, mode), true);
    setOpen(false);
  }

  return (
    <div className="relative">
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
          onChange(e.target.value, requireSelection ? false : undefined);
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
          {suggestions.map((suggestion) => {
            const primary =
              mode === 'email' && suggestion.email
                ? suggestion.email
                : suggestion.name;
            const secondary =
              mode === 'email' && suggestion.email
                ? suggestion.name
                : suggestion.email;
            return (
              <li key={suggestion.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === primary}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSuggestion(suggestion);
                  }}
                  className="block w-full rounded-[var(--radius-input)] px-[var(--space-2)] py-[var(--space-1)] text-left hover:bg-[var(--surface-subtle)]"
                >
                  <span className="block text-[length:var(--text-sm)] text-[var(--ink)]">{primary}</span>
                  <span className="block text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {[secondary, suggestion.company, personSuggestionSourceLabel(suggestion.source)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
