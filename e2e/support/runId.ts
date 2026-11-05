/**
 * Per-run unique suffix for created entities. The hermetic tier resets the
 * database per run and would not need it; the live tier runs against a shared
 * database somebody may be demonstrating on, and the journey code is shared —
 * so it is always on (design: data strategy).
 */
export function newRunId(): string {
  return Math.random().toString(36).slice(2, 8);
}
