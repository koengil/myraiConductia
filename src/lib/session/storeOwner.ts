/**
 * The owner of this browser's per-user local stores (#162): the rail run state
 * (`ib-rail-run:<deal>`) and the Gate 0 create receipt
 * (`ib-gate0-receipt:<code>`). Each entry is stamped with the owner that wrote
 * it, and a reader only ever returns an entry stamped with the current owner,
 * whatever order the auth events arrive in.
 *
 * The shared-read auth listener (`src/lib/api/inflightRead.ts`) keeps this in
 * step with the Supabase session; it installs on the first
 * `subscribeGeneration` call, which the shell's deal list makes on every
 * authenticated page. The owner is:
 *  - `null` until the first auth event, and after a sign-out: unknown, so
 *    readers return nothing and writers persist nothing (fail closed);
 *  - the signed-in user's id once an auth event carries a session;
 *  - `LOCAL_STORE_OWNER` when this document has no auth client at all
 *    (Supabase unconfigured, local dev only: staging and production fail
 *    closed in middleware), so the single local actor keeps its rail state.
 *
 * No imports on purpose: the stores read it, and the auth listener that writes
 * it already imports the stores' clear functions.
 */

/** The owner stamped when this document has no auth client (local dev only). */
export const LOCAL_STORE_OWNER = 'local';

let owner: string | null = null;

/** The current owner, or null while unknown or signed out. Synchronous. */
export function storeOwner(): string | null {
  return owner;
}

/** Set by the auth listener; tests set it directly. */
export function setStoreOwner(next: string | null): void {
  owner = next;
}
