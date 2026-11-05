'use client';

import * as React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';
type Surface = 'light' | 'dark';

export type ButtonProps = {
  variant?: Variant;
  size?: Size;
  /**
   * Additive, optional. Defaults to `'light'` so every existing call site and
   * test is byte-stable. `'dark'` re-skins for dark surfaces (the dark row on
   * /dev-primitives) without changing the prop/behavior API — design spec §3
   * (dark cinematic) / §4 (Buttons).
   */
  surface?: Surface;
  /** React 19 passes `ref` as a prop; `...props` forwards it to the `<button>`. */
  ref?: React.Ref<HTMLButtonElement>;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/*
 * Workbench buttons (kit §02 "Buttons / controls"):
 *   - Primary = ink fill (--accent is ink in the workbench register), white
 *     label. The one commit per decision area.
 *   - Secondary = white surface, hairline --stroke-strong border, ink label.
 *   - Ghost = quiet text button; field-gray wash on hover.
 *   - Hairlines over shadows: no elevation on buttons.
 *   - Real focus ring: ink, 2px, offset; ring + offset colours follow surface.
 */
const base =
  'inline-flex items-center justify-center font-sans font-medium select-none ' +
  'tracking-[0.005em] whitespace-nowrap ' +
  'rounded-[var(--radius-control)] ' +
  'transition-[background-color,color,box-shadow,transform] duration-150 ease-out ' +
  'active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-offset-2 ' +
  'disabled:pointer-events-none disabled:shadow-none';

// Label colors carry a trailing `!` (important) deliberately: a button label
// must never go invisible. Utilities all share specificity, so an accidental
// color-emitting class later in the stylesheet — the classic case being a
// bare size utility over a size var that Tailwind resolves as COLOR —
// silently wins over the variant's text color. The important marker makes
// the atom's label color the contract, not a suggestion.
const surfaces: Record<Surface, Record<Variant, string>> = {
  light: {
    primary:
      'bg-[var(--accent)] text-[var(--accent-contrast)]! ' +
      'hover:bg-[var(--accent-dark)] ' +
      'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-[var(--surface)] ' +
      'disabled:bg-[var(--surface-subtle)] disabled:text-[var(--ink-tertiary)]!',
    secondary:
      'bg-[var(--surface)] text-[var(--ink)]! ' +
      'border border-[var(--stroke-strong)] ' +
      'hover:bg-[var(--surface-raised)] ' +
      'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-[var(--surface-warm)] ' +
      'disabled:border-[var(--stroke)] disabled:text-[var(--ink-tertiary)]!',
    ghost:
      'bg-transparent text-[var(--ink-secondary)]! ' +
      'hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)]! ' +
      'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-[var(--surface-warm)] ' +
      'disabled:text-[var(--ink-tertiary)]!',
  },
  // Dark (ink) surfaces keep the meaning with white/ink inverted: the one
  // commit is a white fill with an ink label; the focus ring goes light.
  dark: {
    primary:
      'bg-[var(--surface)] text-[var(--ink)]! ' +
      'hover:bg-[var(--surface-warm)] ' +
      'focus-visible:ring-[var(--ink-on-dark)] focus-visible:ring-offset-[var(--canvas-bg)] ' +
      'disabled:bg-[var(--on-dark-fill-16)] disabled:text-[var(--ink-on-dark-secondary)]!',
    secondary:
      'bg-transparent text-[var(--ink-on-dark)]! ' +
      'border border-[rgb(245_242_235_/_0.24)] ' +
      'hover:bg-[rgb(245_242_235_/_0.06)] ' +
      'focus-visible:ring-[var(--ink-on-dark)] focus-visible:ring-offset-[var(--canvas-bg)] ' +
      'disabled:border-[var(--on-dark-fill-12)] disabled:text-[var(--ink-on-dark-secondary)]!',
    ghost:
      'bg-transparent text-[var(--ink-on-dark-secondary)]! ' +
      'hover:bg-[rgb(245_242_235_/_0.06)] hover:text-[var(--ink-on-dark)]! ' +
      'focus-visible:ring-[var(--ink-on-dark)] focus-visible:ring-offset-[var(--canvas-bg)] ' +
      'disabled:text-[var(--ink-on-dark-secondary)]!',
  },
};

// The `length:` hint is load-bearing: a bare arbitrary utility over a size
// var is resolved by Tailwind as a COLOR utility, emitting an invalid color
// that falls back to the inherited ink and silently beats the variant's
// text color (dark labels on navy primary buttons; the invisible-text bug
// family from the contrast contract). The spelling below
// is the repo's canonical form; tests/text-utility-ratchet.test.ts keeps the
// bare form from coming back anywhere.
// Workbench control heights (kit §02): 28 / 34 / 36.
const sizes: Record<Size, string> = {
  sm: 'h-7 px-3 text-(length:--text-sm)',
  md: 'h-[34px] px-4 text-(length:--text-base)',
  lg: 'h-9 px-5 text-(length:--text-base)',
};

export function Button({
  variant = 'primary',
  size = 'md',
  surface = 'light',
  className,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={[base, surfaces[surface][variant], sizes[size], className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}

export default Button;
