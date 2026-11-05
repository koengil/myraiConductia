export type RestoreStepResult =
  { ok: true } | { ok: false; error: string };

/** A failed restore reads plainly; the server's own text goes to the console. */
export const RESTORE_FAILED_COPY = 'The step was not restored. Try again.';

export async function restoreStepRequest(
  projectId: string,
  stepId: string,
): Promise<RestoreStepResult> {
  try {
    const response = await fetch(
      `/api/v1/deals/${encodeURIComponent(projectId)}/rail/steps/${encodeURIComponent(stepId)}/restore`,
      { method: "POST", credentials: "include" },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (body.error) console.error("[rail] restore step refused", response.status, body.error);
    return { ok: false, error: RESTORE_FAILED_COPY };
  } catch {
    return { ok: false, error: RESTORE_FAILED_COPY };
  }
}
