'use client';

/**
 * Composer — the deal input card. "Banking in the front, AI in the back"
 * (Storm, 2026-07-09): the banker never chooses a model, an effort level, or a
 * source route — the platform just does the right thing and names the model on
 * the answer + in the audit trail. So this is a clean input + attach + submit,
 * with NO model-tier picker and NO source tray (removed 2026-07-09).
 *
 * Workbench register (kit §04, Harvey pattern): gray card on the warm canvas,
 * hairline only, scope chip naming the perimeter, quiet ghost toolbar, and a
 * VIOLET round send — asking here IS the Casey moment (kit §02: violet marks
 * the AI actor, the one violet in the system).
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  ⌂ {codename}                                 │
 *   │  Ask about {codename}…                        │
 *   │  📎                                    ↑       │
 *   └─────────────────────────────────────────────┘
 */

import { ArrowUp, FolderLock, Paperclip } from 'lucide-react';
import * as React from 'react';

export function Composer({
  codename,
  placeholder,
  onSubmit,
}: {
  codename: string;
  placeholder?: string;
  onSubmit?: (text: string) => void;
}) {
  const [value, setValue] = React.useState('');

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSubmit?.(text);
    setValue('');
  }

  return (
    <div className="relative w-full max-w-[760px]">
      <div className="rounded-[var(--radius-composer)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-5 pt-4 pb-3 shadow-[var(--shadow-ambient)]">
        {/* Scope chip — names the perimeter the question runs inside (kit §03). */}
        <span className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--stroke)] bg-[var(--surface)] px-2.5 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
          <FolderLock size={12} strokeWidth={1.75} aria-hidden="true" />
          {codename}
        </span>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? `Ask about ${codename}…`}
          className="mt-2 w-full resize-none bg-transparent text-[length:var(--text-md)] leading-6 text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus:outline-none"
          aria-label={`Ask about ${codename}`}
        />

        <div className="mt-2 flex items-center justify-between">
          {/* Left: attach only — quiet ghost toolbar, no model or source choices. */}
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>

          {/* Right: submit — violet round send, the Casey moment (kit §02). */}
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="grid h-9 w-9 place-items-center rounded-[var(--radius-pill)] relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] bg-[var(--ai)] text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--ai-deep)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2"
            aria-label="Send"
          >
            <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
