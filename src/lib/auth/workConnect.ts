// Client-safe: the connect entry points (profile menu, /join) share these.
import type { WorkIdentityProvider } from '@/lib/constants/workIdentity';

export const WORK_CONNECT_LABEL: Record<WorkIdentityProvider, string> = {
  google: 'Connect Google Workspace',
  azure: 'Connect Microsoft',
};

/** Where the profile menu's connect returns; the callback issues the success proof only here. */
export const PROFILE_CONNECT_DESTINATION = '/profile';

/** /auth/work/connect needs the AAL2 session and returns to redirectTo with the outcome. */
export const workConnectHref = (provider: WorkIdentityProvider, redirectTo: string) =>
  `/auth/work/connect?${new URLSearchParams({ provider, redirectTo }).toString()}`;
