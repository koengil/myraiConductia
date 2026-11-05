import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import {
  SUPABASE_ENV_KEYS,
  getSupabaseAdminCredentials,
  getSupabaseConfig,
} from './config';
import { observeAuditWrites } from './observeAuditWrites';

export function createSupabaseAdminClient() {
  const creds = getSupabaseAdminCredentials();
  if (!creds) {
    throw new Error(
      `Supabase admin client requires ${SUPABASE_ENV_KEYS.url} and ${SUPABASE_ENV_KEYS.secretKey}`,
    );
  }

  return createSupabaseClient(creds.url, creds.secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // A failed audit_log insert writes an audit_write_failed line (#474). The global
    // fetch is looked up per call, as supabase-js does when no fetch is given.
    global: { fetch: observeAuditWrites((input, init) => fetch(input, init)) },
  });
}

export async function createSupabaseServerClient() {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error('Supabase is not configured');
  }

  const cookieStore = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll is called from a Server Component; cookie writes are ignored.
        }
      },
    },
  });
}
