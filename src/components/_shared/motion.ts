/**
 * Shared Score-Reveal motion constants.
 *
 * docs/04-brand/motion-language.md § 3 (Score Reveal): the radar arms and the
 * score-breakdown bars extend together over 600ms with a slight-overshoot
 * easing `cubic-bezier(0.34, 1.56, 0.64, 1)` ("confidence, not hesitation").
 * These two values are byte-identical across CultureRadarPanel and
 * ScoreBreakdownPanel, so they live here as the single source of truth.
 *
 * NOTE: this does NOT cover the ScoreDial's separate 700ms / ease-out sweep
 * (motion-language.md § 3 dial row) — that primitive owns its own timing and
 * is intentionally not consolidated here.
 */

// Radar arm / breakdown bar extension — 600ms (motion-language.md § 3).
export const SCORE_REVEAL_DURATION_S = 0.6;

// cubic-bezier(0.34, 1.56, 0.64, 1) — slight overshoot. Framer Motion accepts
// a 4-number bezier tuple (motion-language.md § 3).
export const SCORE_REVEAL_EASE = [0.34, 1.56, 0.64, 1] as const;

/**
 * Shell choreography constants (Dribbble-style rollout, 2026-06).
 * These are deliberately separate from compliance / command-flow timings.
 */
export const SHELL_COLLAPSE_DURATION_S = 0.24;
export const SHELL_FADE_DURATION_S = 0.22;
export const SHELL_REVEAL_DURATION_S = 0.46;
export const SHELL_ITEM_STAGGER_S = 0.06;
export const SHELL_COLLAPSE_EASE = [0.16, 1, 0.3, 1] as const;
export const SHELL_FADE_EASE = [0.25, 0.46, 0.45, 0.94] as const;
export const SHELL_REVEAL_EASE = [0.16, 1, 0.3, 1] as const;

export function shellTransition(reduceMotion: boolean, duration: number) {
  return reduceMotion
    ? { duration: 0 }
    : { duration, ease: SHELL_REVEAL_EASE };
}
