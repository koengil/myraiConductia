export type PostRevisionResult =
  | { kind: 'recorded' | 'started'; revisionId: string }
  | { kind: 'refused'; status: number; message: string };

const UNREACHABLE_MESSAGE = 'The edits could not be sent. Check your connection and try again.';
const REFUSED_MESSAGE = 'The edits could not be applied.';

function revisionsPath(runsPath: string, runId: string): string {
  return `${runsPath}/${encodeURIComponent(runId)}/revisions`;
}

export async function postRevision(
  runsPath: string,
  runId: string,
  body: unknown,
): Promise<PostRevisionResult> {
  let response: Response;
  try {
    response = await fetch(revisionsPath(runsPath, runId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'refused', status: 0, message: UNREACHABLE_MESSAGE };
  }
  const parsed = (await response.json().catch(() => null)) as {
    revisionId?: unknown;
    error?: unknown;
  } | null;
  if ((response.status === 201 || response.status === 202) && typeof parsed?.revisionId === 'string') {
    return { kind: response.status === 201 ? 'recorded' : 'started', revisionId: parsed.revisionId };
  }
  return {
    kind: 'refused',
    status: response.status,
    message: typeof parsed?.error === 'string' ? parsed.error : REFUSED_MESSAGE,
  };
}

export async function fetchVersionText(
  runsPath: string,
  runId: string,
  versionId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${revisionsPath(runsPath, runId)}/${encodeURIComponent(versionId)}`,
      { credentials: 'include' },
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}
