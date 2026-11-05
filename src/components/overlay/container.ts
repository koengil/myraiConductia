'use client';

import * as React from 'react';

/** The open Dialog's panel, or null outside a Dialog. Provided by `Dialog`. */
export const OverlayContainerContext = React.createContext<HTMLElement | null>(null);

/**
 * Where a floating layer (a Menu, a popover) should portal to: the
 * enclosing Dialog's panel when there is one, so it stays inside the
 * `aria-modal` dialog and its Tab trap, otherwise `undefined` (meaning
 * `document.body`).
 */
export function useOverlayContainer(): HTMLElement | undefined {
  return React.useContext(OverlayContainerContext) ?? undefined;
}
