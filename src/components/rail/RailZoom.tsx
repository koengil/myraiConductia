'use client';

import * as React from 'react';

/**
 * The rail's two levels and the gestures between them: the board stays on the
 * page, and one step opens over it in a dialog (DealRail, StepZoom).
 *
 * Provisional: the zoom-out gestures (Escape, ctrl-wheel, trackpad and touch
 * pinch) are not a settled design. Marco owns the question "How should the rail
 * be laid out and zoomed?".
 */

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** Wheel distance (px) a ctrl-wheel or trackpad pinch-out must travel. */
const WHEEL_ZOOM_OUT_PX = 60;
/** A two-finger pinch that closes to this share of its opening span zooms out. */
const PINCH_ZOOM_OUT_RATIO = 0.7;

function touchSpan(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * Zoom-out gestures for the zoomed-in step: Escape (unless a dialog, menu or
 * text field has it), ctrl-wheel down or a trackpad pinch (Chrome and Firefox
 * send it as ctrl-wheel, Safari as a gesture event), and a two-finger touch
 * pinch. Each gesture fires `onZoomOut` once.
 */
export function useZoomOutGestures(
  el: HTMLElement | null,
  enabled: boolean,
  onZoomOut: () => void,
) {
  const onZoomOutRef = React.useRef(onZoomOut);
  React.useEffect(() => {
    onZoomOutRef.current = onZoomOut;
  }, [onZoomOut]);

  React.useEffect(() => {
    if (!enabled) return;
    const zoomOut = () => onZoomOutRef.current();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditable(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      zoomOut();
    };
    document.addEventListener('keydown', onKeyDown);

    let wheelTravel = 0;
    let wheelReset: number | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY <= 0) return;
      e.preventDefault();
      wheelTravel += e.deltaY;
      window.clearTimeout(wheelReset);
      wheelReset = window.setTimeout(() => {
        wheelTravel = 0;
      }, 250);
      if (wheelTravel >= WHEEL_ZOOM_OUT_PX) {
        wheelTravel = -Infinity;
        zoomOut();
      }
    };

    let pinchStart = 0;
    const onTouchStart = (e: TouchEvent) => {
      pinchStart = e.touches.length === 2 ? touchSpan(e.touches) : 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinchStart === 0 || e.touches.length !== 2) return;
      const ratio = touchSpan(e.touches) / pinchStart;
      if (ratio < 1) e.preventDefault();
      if (ratio <= PINCH_ZOOM_OUT_RATIO) {
        pinchStart = 0;
        zoomOut();
      }
    };
    const onTouchEnd = () => {
      pinchStart = 0;
    };

    // Safari's trackpad pinch: `scale` below 1 is a pinch closing.
    let gestureFired = false;
    const onGestureChange = (e: Event) => {
      const scale = (e as Event & { scale?: number }).scale;
      if (typeof scale !== 'number' || gestureFired) return;
      e.preventDefault();
      if (scale <= PINCH_ZOOM_OUT_RATIO) {
        gestureFired = true;
        zoomOut();
      }
    };

    el?.addEventListener('wheel', onWheel, { passive: false });
    el?.addEventListener('touchstart', onTouchStart, { passive: true });
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('gesturechange', onGestureChange);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(wheelReset);
      el?.removeEventListener('wheel', onWheel);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('gesturechange', onGestureChange);
    };
  }, [enabled, el]);
}
