/**
 * Local-only escape hatch for testing without TOTP enrollment.
 * Honored only when NEXT_PUBLIC_APP_ENV=dev and DISABLE_MFA (or
 * NEXT_PUBLIC_DISABLE_MFA for client bundles) is truthy.
 * Never enable on staging or production.
 */
export function isMfaBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NEXT_PUBLIC_APP_ENV !== 'dev') return false;
  const raw = (env.DISABLE_MFA ?? env.NEXT_PUBLIC_DISABLE_MFA)?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}
