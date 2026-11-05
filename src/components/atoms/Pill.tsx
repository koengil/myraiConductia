'use client';

import * as React from 'react';

import type { Tone } from './Badge';

type Surface = 'light' | 'dark';

export type PillProps = {
  tone?: Tone;
  className?: string;
  children?: React.ReactNode;
  surface?: Surface;
};

/*
 * Workbench category tags (kit §03): white pill, hairline --stroke border,
 * 6px status dot before the label, quiet ink-secondary label. The tone
 * lives in the dot, never the label — colour never stands alone.
 */
const chrome: Record<Surface, string> = {
  light: 'bg-[var(--surface)] border-[var(--stroke)] text-[var(--ink-secondary)]',
  dark: 'bg-transparent border-[rgb(245_242_235_/_0.20)] text-[var(--ink-on-dark-secondary)]',
};

// Dot colour by tone. Accent stays ink (violet --ai is Casey-only, never in
// generic atoms); neutral goes quiet.
const dots: Record<Surface, Record<Tone, string>> = {
  light: {
    neutral: 'bg-[var(--ink-quiet)]',
    positive: 'bg-[var(--positive)]',
    negative: 'bg-[var(--negative)]',
    accent: 'bg-[var(--accent)]',
    hold: 'bg-[var(--hold)]',
  },
  dark: {
    neutral: 'bg-[var(--ink-on-dark-tertiary)]',
    positive: 'bg-[var(--positive)]',
    negative: 'bg-[var(--negative)]',
    accent: 'bg-[var(--ink-on-dark)]',
    hold: 'bg-[var(--hold)]',
  },
};

const base =
  'inline-flex items-center gap-[var(--space-2)] font-sans font-medium ' +
  'text-[length:var(--text-xs)] leading-none tracking-[0.01em] ' +
  'px-[var(--space-3)] py-[var(--space-1)] ' +
  'border rounded-full';

const dotBase = 'inline-block h-[6px] w-[6px] shrink-0 rounded-full';

export function Pill({
  tone = 'neutral',
  surface = 'light',
  className,
  children,
}: PillProps) {
  return (
    <span
      className={[base, chrome[surface], className]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden="true" className={[dotBase, dots[surface][tone]].join(' ')} />
      {children}
    </span>
  );
}

export default Pill;
