export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function path(...parts: string[]): string {
  return `/api/v1/deals/${parts.map(encodeURIComponent).join("/")}`;
}

export function init(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
}

export async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
