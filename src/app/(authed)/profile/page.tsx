import { redirect } from 'next/navigation';

import { profileRedirectTarget } from '@/lib/settings/href';

/**
 * /profile is Settings › Profile. The route stays because the work account
 * connect callback returns here (it issues its one-shot success cookie only
 * for this path); the redirect keeps ?connected= / ?error= so the profile
 * section's ConnectResult still shows the outcome.
 */
export default async function ProfilePage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  redirect(profileRedirectTarget(await searchParams));
}
