'use client';

import {
  PALETTES,
  type PaletteId,
} from '@/lib/theme/palette';

export interface PaletteSwitcherProps {
  value: PaletteId;
  onChange: (value: PaletteId) => void;
  className?: string;
}

export function PaletteSwitcher({
  value,
  onChange,
  className,
}: PaletteSwitcherProps) {
  return (
    <div
      className={[
        'inline-flex items-center gap-[var(--space-2)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as PaletteId)}
        className={[
          'h-8 min-w-[148px] rounded-[var(--radius-input)] border border-[var(--shell-panel-border)]',
          'bg-[var(--shell-panel-bg)] px-[var(--space-3)]',
          'bank-body text-[var(--shell-ink)]',
          'outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--shell-topbar-bg)]',
        ].join(' ')}
        aria-label="Choose color palette"
      >
        {PALETTES.map((palette) => (
          <option key={palette.id} value={palette.id}>
            {palette.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default PaletteSwitcher;
