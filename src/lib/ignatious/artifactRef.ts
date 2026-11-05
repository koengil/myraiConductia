import type { createControlPlane } from './control-plane';

/**
 * Run artifacts are addressed by index (`?executionId=&artifact=<n>`), never by
 * file path (#331): the URL carries ids and an integer, and the route resolves
 * the path from the run's own artifact list.
 */

export const ARTIFACT_PATH_REFUSED = 'Artifact paths are not accepted in the URL';
export const ARTIFACT_REF_REQUIRED = 'executionId and artifact are required';

/** A non-negative integer, or null for anything else (absent, blank, signed, fractional, trailing text). */
export function parseArtifactIndex(raw: string | null): number | null {
  const text = raw?.trim();
  if (!text || !/^\d{1,6}$/.test(text)) return null;
  return Number(text);
}

/**
 * The path of artifact `index` in the run's artifact list, or null when the run
 * has no such artifact. One control-plane read; the run is already bound to the
 * deal or lead by the caller.
 */
export async function resolveArtifactPath(
  plane: Pick<ReturnType<typeof createControlPlane>, 'getRun'>,
  executionId: string,
  index: number,
): Promise<string | null> {
  const run = await plane.getRun(executionId);
  const artifact = run.artifacts[index];
  return typeof artifact?.path === 'string' && artifact.path ? artifact.path : null;
}
