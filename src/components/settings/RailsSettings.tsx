'use client';

import * as React from 'react';

import { getLocalPref, setLocalPref } from '@/lib/prefs/localPrefs';

/**
 * Settings › Rails: the switch behind the rail's "Don't ask again". Stored in
 * this browser only (localPrefs `railEditPrompt`), so the copy says so.
 */
export function RailsSettings() {
  // Read after mount: localStorage does not exist during the server render.
  const [ask, setAsk] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setAsk(getLocalPref('railEditPrompt') === 'ask'));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const [notStored, setNotStored] = React.useState(false);
  const onChange = (next: boolean) => {
    setAsk(next);
    setNotStored(!setLocalPref('railEditPrompt', next ? 'ask' : 'never'));
  };

  return (
    <div className="flex max-w-xl flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]">
      <label className="flex items-start gap-[var(--space-3)]">
        <input
          type="checkbox"
          checked={ask ?? true}
          disabled={ask === null}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby="rails-ask-before-change-help"
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
        />
        <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          Ask before changing the rail
        </span>
      </label>
      <p
        id="rails-ask-before-change-help"
        className="pl-[calc(1rem+var(--space-3))] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
      >
        When you add or remove a step, Conductia asks first, because the change applies to everyone
        on the deal. This choice is kept in this browser only.
      </p>
      <p className="pl-[calc(1rem+var(--space-3))] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Moving a step is a Preview kept in this browser.
      </p>
      {notStored ? (
        <p role="alert" className="pl-[calc(1rem+var(--space-3))] text-[length:var(--text-sm)] text-[var(--negative)]">
          This browser is not keeping settings, so the choice was not saved.
        </p>
      ) : null}
    </div>
  );
}
