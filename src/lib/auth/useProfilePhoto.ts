'use client';

import * as React from 'react';

/**
 * The profile photo, kept in this browser per person until it is saved to the
 * account. Handoff: E8 "Save the profile photo and title". Keyed by user id, so a
 * second person signing in on the same browser never sees the first one's
 * photo. The old single key (`PROFILE_PHOTO_STORAGE_KEY` alone) belonged to
 * nobody in particular and is never read.
 */
const PROFILE_PHOTO_STORAGE_KEY = 'ib-profile-photo-data-url';

function keyFor(userId: string): string {
  return `${PROFILE_PHOTO_STORAGE_KEY}.${userId}`;
}

function readStoredProfilePhoto(userId: string | null): string | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(keyFor(userId));
    return stored && stored.trim().length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function useProfilePhoto(userId: string | null) {
  // Written this visit, per person; anything else is read from storage once
  // per person (the value is a data URL of up to a few MB), not every render.
  const [byUser, setByUser] = React.useState<Record<string, string | null>>({});
  const stored = React.useMemo(() => readStoredProfilePhoto(userId), [userId]);
  const photoUrl = userId ? (userId in byUser ? byUser[userId] : stored) : null;

  /**
   * Keeps the photo in this browser. Returns false, and leaves the current
   * photo as it is, when the browser refuses the write (a full quota, say).
   */
  const savePhoto = React.useCallback(
    (nextPhotoUrl: string | null): boolean => {
      if (!userId) return false;
      try {
        if (nextPhotoUrl) window.localStorage.setItem(keyFor(userId), nextPhotoUrl);
        else window.localStorage.removeItem(keyFor(userId));
      } catch {
        return false;
      }
      setByUser((current) => ({ ...current, [userId]: nextPhotoUrl }));
      return true;
    },
    [userId],
  );

  React.useEffect(() => {
    if (!userId) return undefined;
    const key = keyFor(userId);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      const next = event.newValue && event.newValue.trim() ? event.newValue : null;
      setByUser((current) => ({ ...current, [userId]: next }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  return { photoUrl, savePhoto };
}

export { PROFILE_PHOTO_STORAGE_KEY };
