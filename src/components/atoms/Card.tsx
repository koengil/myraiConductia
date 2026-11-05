'use client';

import * as React from 'react';

type Surface = 'light' | 'dark';
type Elevation = 'resting' | 'raised';
type Density = 'comfortable' | 'compact';

export type CardProps = {
  className?: string;
  children?: React.ReactNode;
  surface?: Surface;
  elevation?: Elevation;
  density?: Density;
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'className' | 'children'
>;

const base =
  'rounded-[var(--radius-card)] ' +
  'transition-[box-shadow,background-color] duration-200 ease-out';

const densities: Record<Density, string> = {
  comfortable: 'p-[var(--space-5)]',
  compact: 'p-[var(--space-4)]',
};

/*
 * Workbench cards (kit §01/§05): white surface, 12px radius
 * (--radius-card), hairline ring instead of elevation. The ONE ambient
 * shadow (--shadow-ambient) is reserved for explicitly floating surfaces —
 * the `raised` elevation.
 */
const surfaces: Record<Surface, Record<Elevation, string>> = {
  light: {
    resting:
      'bg-[var(--surface)] text-[var(--ink)] ' +
      'ring-1 ring-inset ring-[var(--stroke)]',
    raised:
      'bg-[var(--surface)] text-[var(--ink)] ' +
      'ring-1 ring-inset ring-[var(--stroke)] shadow-[var(--shadow-ambient)]',
  },
  dark: {
    resting:
      'bg-(--on-dark-fill-04) text-[var(--ink-on-dark)] ' +
      'ring-1 ring-inset ring-(--on-dark-stroke-12)',
    raised:
      'bg-(--on-dark-fill-05) text-[var(--ink-on-dark)] ' +
      'ring-1 ring-inset ring-(--on-dark-stroke-14)',
  },
};

export function Card({
  className,
  children,
  surface = 'light',
  elevation = 'resting',
  density = 'comfortable',
  ...props
}: CardProps) {
  return (
    <div
      className={[
        base,
        densities[density],
        surfaces[surface][elevation],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}

export default Card;
