/** The single gate for the /dev-api console and the OpenAPI document it renders.
 *
 * Open under `next dev` (local development). Closed in any production build —
 * staging and prod — unless that specific deployment opts in with the
 * server-side ENABLE_DEV_API env var ('true' / '1'), which lets one preview
 * expose the console without opening it everywhere.
 *
 * Deliberately NOT a NEXT_PUBLIC_* var: read server-side only, never inlined
 * into the client bundle.
 */
export function devApiEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const optIn = process.env.ENABLE_DEV_API?.trim().toLowerCase();
  return optIn === 'true' || optIn === '1';
}
