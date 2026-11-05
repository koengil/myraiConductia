// Which Supabase the M365 replay and record scripts may talk to. Both write to the database they are pointed at
// (replay seeds a tenant, the live recorder asks the mailbox guard, which writes refusal state), so neither may
// reach a project nobody named.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A loopback host is always allowed. Any other host is allowed only when --allow-remote-supabase names that exact
 * hostname AND the URL is https: a remote database is never reached in the clear. Runs before createClient.
 */
export function assertSupabaseTarget(url: string, allowHost: string | null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not a URL');
  }
  const host = parsed.hostname;
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return;
  if (allowHost === null || allowHost.toLowerCase() !== host.toLowerCase()) {
    throw new Error(
      `Refusing ${host}: this script works against a local Supabase only (pass --allow-remote-supabase ${host} to name a remote https host)`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing ${host}: a remote Supabase must be reached over https`);
  }
}
