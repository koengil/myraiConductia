/**
 * The rail's zoom in browser history. Zooming into a step pushes one shallow
 * entry (`?step=<seq>`, plus a marker in history.state naming the deal and the
 * step), so browser Back zooms out and Forward zooms back in. Walking between
 * steps inside the zoom replaces that entry; it never adds one per step.
 *
 * The marker is what tells this rail's own entry apart from a `?step=` deep
 * link (Conductor Center task rows, chat quick actions). A deep link the rail
 * lands zoomed on is adopted in place: its entry is replaced (never a new
 * one) with a marker flagged `link`, so the address bar keeps `?step=` and
 * the zoom can be copied on. Back still leaves the page, as before, and
 * zooming out of an adopted entry makes it plain instead of stepping back.
 * Next.js keeps its own keys on the entry when history.pushState /
 * replaceState are called directly.
 */

const ZOOM_KEY = 'conductiaRailZoom';

type ZoomEntry = { deal: string; step: string; link?: true };

/** The step id a history state's zoom entry names for this deal, or null. */
export function zoomEntryStep(state: unknown, deal: string): string | null {
  if (!state || typeof state !== 'object') return null;
  const entry = (state as Record<string, unknown>)[ZOOM_KEY] as Partial<ZoomEntry> | undefined;
  return entry && entry.deal === deal && typeof entry.step === 'string' ? entry.step : null;
}

/** The step the current history entry zooms into for this deal, or null. */
export function currentZoomEntry(deal: string): string | null {
  if (typeof window === 'undefined') return null;
  return zoomEntryStep(window.history.state, deal);
}

/** The `?step=` the current entry carries when it is this rail's zoom, or null. */
export function zoomEntryStepParam(deal: string): string | null {
  if (currentZoomEntry(deal) === null) return null;
  return new URL(window.location.href).searchParams.get('step');
}

/** True when the current entry is a `?step=` deep link this rail adopted. */
function currentEntryIsLink(deal: string): boolean {
  if (currentZoomEntry(deal) === null) return false;
  const entry = (window.history.state as Record<string, unknown>)[ZOOM_KEY] as Partial<ZoomEntry>;
  return entry.link === true;
}

function hrefWithStep(seq: number | null): string {
  const url = new URL(window.location.href);
  if (seq === null) url.searchParams.delete('step');
  else url.searchParams.set('step', String(seq));
  return `${url.pathname}${url.search}${url.hash}`;
}

function entryFor(deal: string, step: string, link = false): Record<string, ZoomEntry> {
  return { [ZOOM_KEY]: link ? { deal, step, link: true } : { deal, step } };
}

/**
 * Zoom in: push the step's entry, or replace it when the current entry is
 * already this rail's zoom (one entry per zoom, never a stack of steps).
 */
export function pushZoomEntry(deal: string, step: string, seq: number | null): void {
  if (currentZoomEntry(deal) !== null) {
    window.history.replaceState(entryFor(deal, step, currentEntryIsLink(deal)), '', hrefWithStep(seq));
  } else {
    window.history.pushState(entryFor(deal, step), '', hrefWithStep(seq));
  }
}

/** Walking inside the zoom: the entry now names this step. */
export function replaceZoomEntry(deal: string, step: string, seq: number | null): void {
  if (currentZoomEntry(deal) === null) return;
  window.history.replaceState(entryFor(deal, step, currentEntryIsLink(deal)), '', hrefWithStep(seq));
}

/**
 * The rail landed zoomed from a `?step=` deep link: mark that entry as this
 * rail's zoom in place (replaceState, no new entry), keeping `?step=` in the
 * address bar.
 */
export function adoptLinkZoomEntry(deal: string, step: string, seq: number | null): void {
  if (currentZoomEntry(deal) !== null) return;
  window.history.replaceState(entryFor(deal, step, true), '', hrefWithStep(seq));
}

/**
 * Turn this rail's zoom entry back into a plain one (no marker, no `?step=`):
 * a reload or a return to the page lands on the board, as it always has.
 */
export function dropZoomEntry(deal: string): void {
  if (currentZoomEntry(deal) === null) return;
  window.history.replaceState({}, '', hrefWithStep(null));
}

/**
 * Zoom out from the page (Esc, the zoom-out button): step back off this
 * rail's zoom entry so the next Back leaves the rail, not the zoom. True when
 * a history step was taken; its popstate arrives after the view has changed.
 * An adopted deep link has no board entry under it: it is made plain instead.
 */
export function leaveZoomEntry(deal: string): boolean {
  if (currentZoomEntry(deal) === null) return false;
  if (currentEntryIsLink(deal)) {
    dropZoomEntry(deal);
    return false;
  }
  window.history.back();
  return true;
}
