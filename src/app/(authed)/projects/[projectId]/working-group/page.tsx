import { redirect } from 'next/navigation';

/**
 * Compatibility route. Team is the canonical roster, invitation, and access
 * surface; historical Working Group links resolve there without duplicating UI.
 */
export default async function WorkingGroupRedirect({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/team`);
}
