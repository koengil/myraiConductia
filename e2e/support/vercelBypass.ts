export function vercelBypassHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!env.E2E_BASE_URL || !secret) return undefined;
  return { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' };
}
