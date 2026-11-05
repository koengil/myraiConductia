'use client';

import * as React from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const getSnapshot = (): string | null => window.location.hash;
// The server (and the hydration pass) cannot know the fragment: null means "not read yet".
const getServerSnapshot = (): string | null => null;

/** The current `location.hash`, or null until the client has read it (server render and hydration). */
export function useLocationHash(): string | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
