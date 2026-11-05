/**
 * Local-only guard for demo seeds that write fabricated records (the demo
 * book). A developer's .env.local can point NEXT_PUBLIC_SUPABASE_URL at a
 * shared hosted project, so these seeds refuse any host that is not a local
 * Supabase stack. Unlike scripts/enable-flags.ts there is no override: demo
 * deals, mail and spend must never reach a hosted database.
 *
 * Pure: the caller passes the values, so nothing here reads the environment.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function assertLocalSupabase(url: string | undefined, appEnv?: string): string {
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL must be set; nothing was changed');
  if (appEnv === 'prod') throw new Error('Refusing to seed demo data in prod; nothing was changed');
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL is not a URL (${url}); nothing was changed`);
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to seed demo data into non-local Supabase host "${hostname}". ` +
        'This seed runs against a local stack (localhost or 127.0.0.1) only; nothing was changed.',
    );
  }
  return hostname;
}
