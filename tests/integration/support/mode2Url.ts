const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];
const BLOCKED_PORTS = new Set(["54321", "54322"]);

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function assertMode2SupabaseUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CONDUCTIA_SUPABASE_E2E_URL must be an http(s) URL");
  }
  if (!LOOPBACK_HOSTS.includes(normalizedHostname(parsed.hostname))) {
    throw new Error("CONDUCTIA_SUPABASE_E2E_URL must be a loopback host");
  }
  if (BLOCKED_PORTS.has(parsed.port)) {
    throw new Error(
      "CONDUCTIA_SUPABASE_E2E_URL must not point at the shared local Supabase stack (54321 or 54322)",
    );
  }
  return parsed;
}

export function requireMode2ServiceRoleKey(
  env: Record<string, string | undefined>,
): string {
  const key = env.CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY must be set for recovery mode 2",
    );
  }
  return key;
}
