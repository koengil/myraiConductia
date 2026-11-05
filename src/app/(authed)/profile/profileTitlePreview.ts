'use client';

import * as React from 'react';

/**
 * Preview: the profile title is kept in this browser only, per person, until
 * the profile API has a title field.
 * Handoff: E8 "Save the profile photo and title".
 * The UI shows it with the Preview chip, offers Reset, and never calls it saved.
 */
export const PROFILE_TITLE_PREVIEW_KEY = 'conductia.preview.profileTitle';

function keyFor(userId: string) {
  return `${PROFILE_TITLE_PREVIEW_KEY}.${userId}`;
}

function read(userId: string | null): string {
  if (!userId || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(keyFor(userId)) ?? '';
  } catch {
    return '';
  }
}

export function useProfileTitlePreview(userId: string | null): [string, (next: string) => void] {
  const [byUser, setByUser] = React.useState<Record<string, string>>({});
  const title = userId ? (byUser[userId] ?? read(userId)) : '';

  const setTitle = React.useCallback(
    (next: string) => {
      if (!userId) return;
      setByUser((current) => ({ ...current, [userId]: next }));
      try {
        if (next) window.localStorage.setItem(keyFor(userId), next);
        else window.localStorage.removeItem(keyFor(userId));
      } catch {
        // Storage unavailable: the title lasts for this visit only.
      }
    },
    [userId],
  );

  return [title, setTitle];
}
