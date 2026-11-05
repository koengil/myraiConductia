'use client';

import * as React from 'react';

export type Tone = 'neutral' | 'positive' | 'negative' | 'accent' | 'hold';
type Surface = 'light' | 'dark';

export type BadgeProps = {
  tone?: Tone;
  className?: string;
  children?: React.ReactNode;
  surface?: Surface;
};

/*
 * Workbench verdict chips (kit §03): SOLID pastel status fills with deep ink
 * of the same hue — no color-mix ghost fills, no rings. Radius 6, sentence
 * case (no uppercase, no wide tracking). Status colour never stands alone:
 * the child label carries the meaning.
 */
const surfaces: Record<Surface, Record<Tone, string>> = {
  light: {
    neutral: 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]',
    positive: 'bg-[var(--positive-fill)] text-[var(--positive-deep)]',
    negative: 'bg-[var(--negative-fill)] text-[var(--negative-deep)]',
    accent: 'bg-[var(--surface-subtle)] text-[var(--ink)]',
    hold: 'bg-[var(--hold-fill)] text-[var(--hold-deep)]',
  },
  // Solid pastel fills carry their own light ground, so verdict tones keep
  // the exact same fill + deep ink on dark surfaces; only the neutral and
  // accent (ink-on-field) tones invert to a light wash.
  dark: {
    neutral: 'bg-[rgb(245_242_235_/_0.10)] text-[var(--ink-on-dark-secondary)]',
    positive: 'bg-[var(--positive-fill)] text-[var(--positive-deep)]',
    negative: 'bg-[var(--negative-fill)] text-[var(--negative-deep)]',
    accent: 'bg-[rgb(245_242_235_/_0.10)] text-[var(--ink-on-dark)]',
    hold: 'bg-[var(--hold-fill)] text-[var(--hold-deep)]',
  },
};

const base =
  'inline-flex items-center font-sans font-medium ' +
  'text-[length:var(--text-xs)] leading-none tracking-[0.01em] ' +
  'px-[var(--space-2)] py-[var(--space-1)] ' +
  'rounded-[6px]';

export function Badge({
  tone = 'neutral',
  surface = 'light',
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={[base, surfaces[surface][tone], className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

export default Badge;
