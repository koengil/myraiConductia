/**
 * The scope vocabulary the trigger token is minted against.
 *
 * Every agent already receives a narrow grant at mint time (`mdBriefingScopes`
 * and friends in `@/lib/ignatious/jwt`), but until the token was signed those
 * scopes were unforgeable only in theory: a caller could mint their own token
 * claiming any scope, so reading them would have been security theatre. Now
 * that the signature is checked, the grant means something and the seam holds
 * each route to it.
 *
 * The shared instance key is not scoped. It is the deployment's own
 * credential rather than one agent's grant, so it passes every route.
 */
export const SCOPE = {
  LEAD_READ: 'lead.read',
  LEAD_WRITE: 'lead.write',
  DOCUMENTS_READ: 'documents.read',
  DOCUMENTS_WRITE: 'documents.write',
  MAPS_READ: 'maps.read',
  MAPS_WRITE: 'maps.write',
  TASKS_WRITE: 'tasks.write',
  NOTES_WRITE: 'notes.write',
  LIBRARY_READ: 'library.read',
  PERSONAS_READ: 'personas.read',
  PERSONAS_WRITE: 'personas.write',
} as const;

export type AgentScope = (typeof SCOPE)[keyof typeof SCOPE];

/** Whether a granted scope list covers the scope a route requires. */
export function grantsScope(granted: readonly string[], required: AgentScope): boolean {
  return granted.includes(required);
}
