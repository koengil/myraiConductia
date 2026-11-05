import * as React from 'react';

import { readFragmentValue } from '@/lib/util/fragment';

/**
 * The person the CRM network graph focused on `/leads`, held in a tiny external
 * store because the URL alone cannot announce a change.
 *
 * The person rides in the fragment (`/leads?tab=&lead=#person=`). The graph
 * navigates with router.push, which calls history.pushState, and pushState never
 * fires `hashchange`. The tab switch is local state, so the search string does
 * not change either when the user returns to Network and clicks a second person
 * on the same lead: only the fragment changes, and nothing keyed on the search
 * params would notice. So `pushCrmFocus` publishes the person here directly, and
 * `hashchange` (a hand-edited fragment, back/forward) and `location.hash` on
 * mount (a deep link) feed the same store.
 *
 * Snapshot: the last person published, or read from `location.hash`.
 */

const PERSON_KEY = 'person';

let focused: string | undefined;
// True until the snapshot has been read from the address bar for this mount.
let stale = true;
const listeners = new Set<() => void>();

const readHash = (): string | undefined =>
  typeof window === 'undefined' ? undefined : readFragmentValue(window.location.hash, PERSON_KEY);

function set(next: string | undefined) {
  stale = false;
  if (next === focused) return;
  focused = next;
  for (const listener of [...listeners]) listener();
}

/** Publish the focused person (undefined clears it). Called by pushCrmFocus after the router push. */
export function publishCrmFocus(person: string | undefined): void {
  set(person?.trim() || undefined);
}

export function getCrmFocusSnapshot(): string | undefined {
  if (stale && typeof window !== 'undefined') {
    focused = readHash();
    stale = false;
  }
  return focused;
}

const getServerSnapshot = (): string | undefined => undefined;

function onHashChange() {
  set(readHash());
}

export function subscribeCrmFocus(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('hashchange', onHashChange);
    // A page mounted on a fresh URL starts from that URL's fragment, not from a previous visit.
    set(readHash());
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('hashchange', onHashChange);
      stale = true;
    }
  };
}

/** The focused person name for the leads page; re-renders when the focus changes. */
export function useCrmFocus(): string | undefined {
  return React.useSyncExternalStore(subscribeCrmFocus, getCrmFocusSnapshot, getServerSnapshot);
}
