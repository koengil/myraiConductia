/**
 * Per-viewer browser conveniences (localStorage). Never state that must
 * persist, be shared, or be read by the server. Every access is guarded: it
 * throws in private windows and does not exist during SSR, so reads fall back
 * to the default and writes are silent no-ops.
 */

export type RailEditPrompt = 'ask' | 'never';
export type RailViewFilter = 'all' | 'open' | 'mine' | 'unassigned' | 'has_activity';
export type RailView = Exclude<RailViewFilter, 'all'>;
/** How the rail is drawn, chosen per person. */
export type RailLayout = 'sequential' | 'dependency' | 'timeline';

const RAIL_VIEWS: readonly RailView[] = ['open', 'mine', 'unassigned', 'has_activity'];

/** The views as stored: 'all', or the chosen ones joined by commas in a fixed order. */
export function railViewValue(views: readonly RailView[]): string {
  const value = RAIL_VIEWS.filter((view) => views.includes(view)).join(',');
  return value || 'all';
}

export function railViewsFrom(value: string): RailView[] {
  return RAIL_VIEWS.filter((view) => value.split(',').includes(view));
}

/** Every combination of views a browser may hold. */
const RAIL_VIEW_VALUES: readonly string[] = Array.from({ length: 2 ** RAIL_VIEWS.length }, (_, mask) =>
  railViewValue(RAIL_VIEWS.filter((_view, bit) => mask & (1 << bit))),
);
/** Matches the values BankHome already persists. */
export type HomeView = 'console' | 'book';

export type LocalPrefs = {
  railEditPrompt: RailEditPrompt;
  railViewFilter: string;
  railLayout: RailLayout;
  homeView: HomeView;
};

export const LOCAL_PREF_DEFAULTS: LocalPrefs = {
  railEditPrompt: 'ask',
  railViewFilter: 'all',
  railLayout: 'sequential',
  homeView: 'console',
};

const ALLOWED: { [K in keyof LocalPrefs]: readonly LocalPrefs[K][] } = {
  railEditPrompt: ['ask', 'never'],
  railViewFilter: RAIL_VIEW_VALUES,
  railLayout: ['sequential', 'dependency', 'timeline'],
  homeView: ['console', 'book'],
};

// homeView keeps its existing key so BankHome can adopt this helper without a storage migration.
const keyOf = (name: keyof LocalPrefs) =>
  name === 'homeView' ? 'conductia.homeView' : `conductia.pref.${name}`;

export function getLocalPref<K extends keyof LocalPrefs>(name: K): LocalPrefs[K] {
  const fallback = LOCAL_PREF_DEFAULTS[name];
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(keyOf(name));
    if (raw === null) return fallback;
    return (ALLOWED[name] as readonly string[]).includes(raw) ? (raw as LocalPrefs[K]) : fallback;
  } catch {
    return fallback;
  }
}

/** Returns true when the value was stored. */
export function setLocalPref<K extends keyof LocalPrefs>(name: K, value: LocalPrefs[K]): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (!(ALLOWED[name] as readonly string[]).includes(value)) return false;
    window.localStorage.setItem(keyOf(name), value);
    return true;
  } catch {
    return false;
  }
}
