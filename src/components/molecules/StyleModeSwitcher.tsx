'use client';

import { STYLE_MODES, type StyleModeId } from '@/lib/theme/palette';

export interface StyleModeSwitcherProps {
  value: StyleModeId;
  onChange: (value: StyleModeId) => void;
  className?: string;
}

export function StyleModeSwitcher({
  value,
  onChange,
  className,
}: StyleModeSwitcherProps) {
  return (
    <div
      className={[
        'inline-flex items-center gap-(--space-2)',
        className,
      ].filter(Boolean).join(' ')}
      role="group"
      aria-label="Appearance mode"
    >
      <div className="inline-flex items-center rounded-[var(--radius-pill)] border border-[var(--shell-panel-border)] bg-[var(--shell-panel-bg)] p-[2px]">
        {STYLE_MODES.map((mode) => {
          const selected = mode.id === value;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onChange(mode.id)}
              aria-pressed={selected}
              className={[
                'inline-flex h-7 items-center justify-center rounded-[var(--radius-pill)] px-[var(--space-3)]',
                'text-(--text-xs) font-medium tracking-tight transition-colors duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--shell-topbar-bg)]',
                selected
                  ? 'bg-[var(--shell-active-bg)] text-[var(--shell-ink)]'
                  : 'text-[var(--shell-ink-muted)] hover:bg-[var(--shell-hover-bg)] hover:text-[var(--shell-ink)]',
              ].join(' ')}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default StyleModeSwitcher;
