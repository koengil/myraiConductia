'use client';

/**
 * The bank home with the View control (Console | Book).
 *
 * Decision (Aug 18, issue #191): a VISIBLE switcher, not a bare flag — the
 * point is comparing the two layouts live, same data, one click. The
 * book_view flag gates the switcher's EXISTENCE (read from the layout's
 * FlagsProvider — no extra fetch) so production users never stumble into a
 * preview; with it off this component IS the Command Center, byte-for-byte.
 * The choice persists per user (localStorage, guarded like mail drafts).
 * "Book" is banker vocabulary from the deck itself ("the whole book in
 * view"), "Console" is the shipped Command Center.
 */

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { getLocalPref, setLocalPref, type HomeView } from '@/lib/prefs/localPrefs';
import { CommandCenter } from '@/components/workspace/CommandCenter';
import { BookHome } from './BookHome';

const VIEW_OPTIONS = [
  { key: 'console', label: 'Console' },
  { key: 'book', label: 'Book' },
] as const;

// The view choice as an external store over the stored pref, read
// synchronously so a stored Book choice never mounts the Console first.
// `chosen` holds this session's pick only when storage refused it
// (setLocalPref returns false), so a choice still applies in a private window.
let chosen: HomeView | null = null;
const viewListeners = new Set<() => void>();

function subscribeView(listener: () => void): () => void {
  viewListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    viewListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readView(): HomeView {
  return chosen ?? getLocalPref('homeView');
}

/** Before hydration the choice is unknown: render no view rather than guess. */
function readServerView(): HomeView | null {
  return null;
}

function chooseView(next: HomeView) {
  chosen = setLocalPref('homeView', next) ? null : next;
  for (const listener of viewListeners) listener();
}

export function BankHome() {
  const bookEnabled = useFlag('book_view');
  const view = React.useSyncExternalStore(subscribeView, readView, readServerView);

  if (!bookEnabled) return <CommandCenter />;

  const choose = chooseView;

  // ARIA radio pattern: arrows move the choice and focus, wrapping; Home/End jump.
  const onGroupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = VIEW_OPTIONS.findIndex((o) => o.key === view);
    let to = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % VIEW_OPTIONS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + VIEW_OPTIONS.length) % VIEW_OPTIONS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = VIEW_OPTIONS.length - 1;
    if (to < 0) return;
    e.preventDefault();
    choose(VIEW_OPTIONS[to].key);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  return (
    <div className="relative min-h-full w-full">
      {/* Top-RIGHT so the control never covers either view's content. */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-center justify-end gap-2 pr-4">
        <span id="home-view-label" className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          View
        </span>
        {/* Workbench segmented pill grammar (kit §02): hairline over shadow;
            the ACTIVE item carries a field-gray pill, never an ink fill. */}
        <div
          role="radiogroup"
          aria-labelledby="home-view-label"
          onKeyDown={onGroupKeyDown}
          className="pointer-events-auto flex rounded-full border border-[var(--stroke)] bg-[var(--surface)] p-0.5"
        >
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={view === option.key}
              tabIndex={view === option.key ? 0 : -1}
              onClick={() => choose(option.key)}
              className={`rounded-full px-3.5 py-1.5 text-[length:var(--text-sm)] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] ${
                view === option.key
                  ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
                  : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {view === null ? null : view === 'book' ? <BookHome /> : <CommandCenter />}
    </div>
  );
}
