export function resolvePublicOrigin(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return new URL(request.url).origin;
  try {
    return new URL(configured).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_APP_URL is not an absolute URL: ${configured}`);
  }
}
