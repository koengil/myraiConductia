import type { BoxClient } from './types';

/** Canonical secret; BOX_CLIENT_SECRET is a legacy alias. */
export function getBoxClientSecret(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.BOX_SECRET?.trim() || env.BOX_CLIENT_SECRET?.trim() || undefined;
}

/** Box root partition folder name — mirrors deployment environment. */
export function boxEnvironmentName(appEnv = process.env.NEXT_PUBLIC_APP_ENV): string {
  switch (appEnv?.trim()) {
    case 'prod':
      return 'production';
    case 'staging':
      return 'staging';
    case 'dev':
    default:
      return 'develop';
  }
}

/** Ensure /{develop|staging|production} under the Box enterprise root (0). */
export async function ensureBoxEnvironmentRootFolder(box: BoxClient): Promise<string> {
  const folder = await box.createFolder(boxEnvironmentName(), '0');
  return folder.id;
}
