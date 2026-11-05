// The rail's evidence marker, as the rail reads it. This file is the only thing
// the rail shares with deal discovery: a plain type. It names no table and
// imports nothing under src/lib/discovery/, because the rail page's import
// closure must stay clear of it (tests/agent-surfaces.test.ts). The data comes
// from GET /api/v1/discovery/suggestions, a session-RLS route.

export type EvidenceSuggestion = {
  assessmentId: string;
  /** The rail step the evidence points at. Compared by step id, never by step number. */
  stepId: string;
  /** The templated reason, for example "Signing / Announcement Prep because signing on Oct 26, 2026 (1 email)". */
  reason: string;
  /** Distinct emails behind the assessment that the caller can see, else the count of cited events. */
  evidenceCount: number;
  asOf: string;
  /** True once the MD dismissed this very assessment; a newer assessment shows again. */
  dismissed: boolean;
  /** The engine's flags, for example `station_removed`. */
  flags: string[];
};
