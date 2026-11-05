export type SkipInput = { approverId: string; reason: string };

export async function submitSkip(
  projectId: string,
  stepId: string,
  input: SkipInput,
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('A skip reason is required');

  const res = await fetch(
    `/api/v1/deals/${encodeURIComponent(projectId)}/rail/steps/${encodeURIComponent(stepId)}/skip`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approverId: input.approverId, reason }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'That step could not be skipped');
  }
}

/** The server resolves the approver's name and role from the id (#312). */
export type LoggedSkipInput = { approverId: string; reason: string };

export async function submitLoggedSkip(
  projectId: string,
  stepId: string,
  skip: LoggedSkipInput,
): Promise<void> {
  const res = await fetch(
    `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || 'The skip was not recorded.');
  }
}
