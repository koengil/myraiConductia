/**
 * resolveProjectId — normalize the `[projectId]` route segment into a single
 * string. `useParams()` types a dynamic segment as `string | string[] |
 * undefined`; this collapses it to the active project id, falling back to the
 * sandbox default so a missing/garbled segment never dead-ends a project-scoped
 * surface. URL is the source of truth for the active project (2026-06-05 routing
 * reframe); the sandbox resolves any id to the same dataset.
 *
 * The segment is the deal CODE (e.g. SUM-2026-014) for real deals after the
 * URL-scheme cutover (G14), or a fixture code-name slug (e.g. project-summit)
 * for the demo. Both are opaque, slash-free strings, so this normalizer treats
 * them identically; server resolution accepts code OR UUID (GET /deals/{idOrCode}).
 *
 * COMPLIANCE: the segment is the deal code or code name, never the target
 * company — the URL, browser history, and any shared link must not name the
 * masked seller (2026-07-09 slug reframe).
 */
export const DEFAULT_PROJECT_ID = 'project-summit';

export function resolveProjectId(
  param: string | string[] | undefined,
): string {
  const value = Array.isArray(param) ? param[0] : param;
  return value && value.trim().length > 0 ? value : DEFAULT_PROJECT_ID;
}

/**
 * Swap the deal in a project-scoped pathname while KEEPING the current
 * sub-route — the engine behind the in-context deal switcher. From
 * `/projects/project-summit/acquirers`, switching to `project-harbor` yields
 * `/projects/project-harbor/acquirers`, so the MD changes deal without losing
 * the screen they are on. Deal-specific query params (?step, ?view) are the
 * caller's concern and are dropped by passing only the pathname here.
 *
 * A pathname that is not under `/projects/<id>` is returned unchanged.
 */
export function withProjectId(pathname: string, nextId: string): string {
  return pathname.replace(/^\/projects\/[^/]+/, `/projects/${nextId}`);
}
