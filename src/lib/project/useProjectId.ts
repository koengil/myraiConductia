'use client';

import { useParams } from 'next/navigation';

import { resolveProjectId } from './resolveProjectId';

/**
 * The active deal id from the `/projects/[projectId]` route segment, normalized
 * to a single string (sandbox fallback for a missing/garbled segment).
 *
 * Centralizes the one verbose expression that otherwise repeats at every
 * per-deal client surface:
 *   `resolveProjectId(useParams()?.projectId as string | string[] | undefined)`
 *
 * Kept separate from `resolveProjectId` so the pure resolver stays server-safe
 * (the server route imports `DEFAULT_PROJECT_ID` from it) while this hook owns
 * the client-only `next/navigation` dependency.
 */
export function useProjectId(): string {
  return resolveProjectId(useParams()?.projectId as string | string[] | undefined);
}
