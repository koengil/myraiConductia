import type { Transition } from 'framer-motion';

/**
 * The overlay motion tokens. Every overlay (Dialog, Menu, Disclosure) moves on
 * the same clock so things enter and leave the screen the same way everywhere.
 * Reduced motion keeps the fade and drops all travel (Workbench accessibility
 * floor: "prefers-reduced-motion strips travel, keeps state changes").
 */
export const OVERLAY_DURATION_S = 0.18;

/** Decelerating curve: quick to arrive, soft to settle. */
export const OVERLAY_EASE: [number, number, number, number] = [0.2, 0, 0, 1];

/** Distance a dialog rises as it enters, in px. Menus drop half of it. */
export const OVERLAY_RISE_PX = 8;

/** The one transition every overlay uses. */
export const overlayTransition: Transition = {
  duration: OVERLAY_DURATION_S,
  ease: OVERLAY_EASE,
};

/**
 * Enter/exit targets for a panel that travels `distance` px on the y axis
 * (positive rises from below, negative drops from above). With `reduce` the
 * panel only fades.
 */
export function travel(reduce: boolean, distance: number = OVERLAY_RISE_PX) {
  const y = reduce ? 0 : distance;
  return {
    initial: { opacity: 0, y },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y },
  };
}
