// The shared shape of a recorded Gmail replay (#259 R15). The recorder
// (phase 1) writes it and the replay reader (phase 6) serves it. Pure: no SDK,
// no token, outside src/lib/google/reader.

export const GMAIL_REPLAY_FORMAT = 'conductia.gmail-replay/v1' as const;
export type ReplayResponse = { status: number; body: unknown; synthetic?: true };

/** One mailbox's replay. Phases mirror mailbox state (R15): seeded,
 * after-imports, after-unspam. A key answering differently over time
 * holds an ordered list; the reader consumes it in order. */
export type GmailReplay = {
  format: typeof GMAIL_REPLAY_FORMAT;
  /** The address the reader sees (the persona address, not the trial address). */
  mailbox: string;
  /** True for the generated twin (plan D10). */
  synthetic: boolean;
  /**
   * Set when a committed transform rewrote a recorded replay (#263): what it did. A recording
   * stays `synthetic: false`, since its mail is real Google answers, but it is no longer the
   * bytes Google sent, and the file says so until a fresh live recording replaces it.
   */
  transformed?: string;
  phases: Record<string, Record<string, ReplayResponse[]>>;
};

/** "GET /gmail/v1/users/<mailbox>/threads?includeSpamTrash=false&maxResults=100&pageToken=…".
 * Query parameters are sorted by name; repeated parameters keep their order within a name. */
export function replayKey(method: string, url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index))
    .map(({ entry }) => entry);
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${method.toUpperCase()} ${decodeURIComponent(u.pathname)}${query ? `?${query}` : ''}`;
}
