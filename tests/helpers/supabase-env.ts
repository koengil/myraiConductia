import { SUPABASE_ENV_KEYS } from '@/lib/supabase/config';

export const SUPABASE_TEST_PROJECT = {
  url: 'https://example.supabase.co',
  publishableKey: 'sb_publishable_test',
  secretKey: 'sb_secret_test',
  authHealthVersion: 'v2.176.0',
} as const;

export type SupabaseEnvValues = Partial<{
  [K in keyof typeof SUPABASE_ENV_KEYS]: string;
}>;

export function clearSupabaseEnv(): void {
  for (const key of Object.values(SUPABASE_ENV_KEYS)) {
    delete process.env[key];
  }
}

export function setSupabaseEnv(values: SupabaseEnvValues): void {
  for (const [name, envVar] of Object.entries(SUPABASE_ENV_KEYS)) {
    const value = values[name as keyof typeof SUPABASE_ENV_KEYS];
    if (value !== undefined) {
      process.env[envVar] = value;
    }
  }
}
