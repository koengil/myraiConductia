import { REHEARSAL_STACK_ID, assertRehearsalStack } from '../../scripts/rehearsal/stack';

/**
 * The hermetic tier runs against a local Supabase stack only. Next.js falls
 * back to .env.local for any variable not already in process.env, so an unset
 * Supabase URL here is exactly the case where the build would pick up a
 * developer's hosted project. Decided from the environment alone; .env.local is
 * never read. The refusal never echoes the URL it refuses.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The refusal for a hermetic run, or null when it may proceed. `playwright test
 * --list` starts no webServer, so listing (and editor test discovery) loads
 * without a stack.
 */
export function hermeticSupabaseRefusal(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): string | null {
  if (argv.includes('--list')) return null;
  const checks = [
    ['NEXT_PUBLIC_SUPABASE_URL', true],
    ['SUPABASE_URL', false],
  ] as const;
  for (const [name, required] of checks) {
    const raw = env[name]?.trim();
    if (!raw && !required) continue;
    if (raw && isLoopbackHttpUrl(raw)) continue;
    const problem = raw ? 'is not a loopback URL' : 'is not set';
    return `Hermetic e2e refused: ${name} ${problem}. Export the local stack's values first: eval "$(supabase status -o env)" && export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY".`;
  }
  // The #173 rehearsal (scripts/rehearsal/rehearse.sh sets REHEARSAL_STACK): w9-m365cap and nothing else, decided
  // here, at config load, before auth setup or any webServer runs. Unset, CI's stack on 54321 passes as before.
  if (env.REHEARSAL_STACK !== undefined) {
    if (env.REHEARSAL_STACK !== REHEARSAL_STACK_ID) return 'Hermetic e2e refused: an unknown REHEARSAL_STACK.';
    try {
      assertRehearsalStack('Hermetic e2e', env);
    } catch (error) {
      // The guard's message names host:port only (scripts/rehearsal/stack.ts).
      return `Hermetic e2e refused: ${error instanceof Error ? error.message : 'the rehearsal stack'}.`;
    }
  }
  return null;
}

export function refuseNonLoopbackSupabase(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): void {
  const refusal = hermeticSupabaseRefusal(env, argv);
  if (refusal) throw new Error(refusal);
}
