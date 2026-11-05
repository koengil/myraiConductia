// Reader progress (reader liveness, #409): a pass that is still reading proves it by the provider calls that come
// back, not by its start. The worker hands a callback in the reader's context (GuardedReaderContext.onProgress), and
// the reader calls it after every successful response and every token it is given, so a page of many requests under
// retries still shows progress between them (READER_LIVENESS_SECONDS documents the arithmetic). Nothing about the
// request or response is passed on: the callback takes no argument.

/** The transport shape the Gmail and Graph clients share. */
type ProgressTransport = {
  getToken: (...args: never[]) => Promise<string>;
  fetchImpl?: typeof fetch;
};

/** The transport, with `onProgress` called after each token and each successful response. Unchanged without one. */
export function withReadProgress<T extends ProgressTransport>(http: T, onProgress?: () => void): T {
  if (!onProgress) return http;
  const fetchImpl = http.fetchImpl ?? fetch;
  const getToken = http.getToken as (...args: unknown[]) => Promise<string>;
  return {
    ...http,
    getToken: (async (...args: unknown[]) => {
      const token = await getToken(...args);
      onProgress();
      return token;
    }) as T['getToken'],
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchImpl(input, init);
      if (res.ok) onProgress();
      return res;
    }) as typeof fetch,
  };
}
