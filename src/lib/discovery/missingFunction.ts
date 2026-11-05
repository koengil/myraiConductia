// The app can deploy before its migration lands (supabase/AGENTS.md), so a caller of a new definer falls back to the
// path it replaces while the definer is not there yet. PostgREST answers PGRST202 for a function missing from its
// schema cache; Postgres answers 42883 for a call with no matching identity. Codes only, never the message.
export function isMissingFunction(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}
