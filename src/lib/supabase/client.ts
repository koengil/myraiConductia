import { createBrowserClient } from '@supabase/ssr';

// Browser client. These must be STATIC process.env.NEXT_PUBLIC_* references so
// Next.js inlines them into the browser bundle — a dynamic lookup (e.g.
// getSupabaseConfig's process.env[name]) resolves to undefined client-side,
// which is why the server-side config helper cannot be reused here.
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      'Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)',
    );
  }

  return createBrowserClient(url, publishableKey);
}
