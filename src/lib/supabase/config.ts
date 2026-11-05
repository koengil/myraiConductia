export type AppEnvironment = 'dev' | 'staging' | 'prod';

export type SupabaseConfig = {
  url: string;
  publishableKey: string;
  secretKey?: string;
  environment: AppEnvironment;
};

export const SUPABASE_ENV_KEYS = {
  url: 'NEXT_PUBLIC_SUPABASE_URL',
  publishableKey: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  secretKey: 'SUPABASE_SECRET_KEY',
  environment: 'NEXT_PUBLIC_APP_ENV',
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseEnvironment(raw: string | undefined): AppEnvironment {
  if (raw === 'staging' || raw === 'prod') return raw;
  return 'dev';
}

export function getMissingSupabaseEnvVars(): string[] {
  const missing: string[] = [];
  if (!readEnv(SUPABASE_ENV_KEYS.url)) missing.push(SUPABASE_ENV_KEYS.url);
  if (!readEnv(SUPABASE_ENV_KEYS.publishableKey)) missing.push(SUPABASE_ENV_KEYS.publishableKey);
  return missing;
}

export function isSupabaseConfigured(): boolean {
  return getMissingSupabaseEnvVars().length === 0;
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = readEnv(SUPABASE_ENV_KEYS.url);
  const publishableKey = readEnv(SUPABASE_ENV_KEYS.publishableKey);
  if (!url || !publishableKey) return null;

  return {
    url,
    publishableKey,
    secretKey: readEnv(SUPABASE_ENV_KEYS.secretKey),
    environment: parseEnvironment(readEnv(SUPABASE_ENV_KEYS.environment)),
  };
}

// Credentials for the server-side admin client. Deliberately does NOT require the
// publishable key — the admin path only needs the URL and the secret key. (Going
// through getSupabaseConfig() would wrongly return null when only the publishable
// key is missing, silently breaking server-side reads.)
export function getSupabaseAdminCredentials(): { url: string; secretKey: string } | null {
  const url = readEnv(SUPABASE_ENV_KEYS.url);
  const secretKey = readEnv(SUPABASE_ENV_KEYS.secretKey);
  if (!url || !secretKey) return null;
  return { url, secretKey };
}
