// The Gmail replay reader (#259 phase 6, R15). In fixture mode the real Gmail
// ContentSource runs over a recorded or generated replay instead of Google, so
// CI, the demo and sibling workstreams read Gmail-shaped mail with no trial, no
// credential and no network. Like every reader module it demands the reader
// capability before it touches the disk.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import { GMAIL_REPLAY_FORMAT, replayKey, type GmailReplay } from '@/lib/google/replay/format';

/** The committed synthetic twin (plan D10). The recorded replay lives beside it, in ../gmail. */
export const DEFAULT_GMAIL_REPLAY_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail-twin');
/** The phase the fixture reader serves unless DISCOVERY_GMAIL_REPLAY_PHASE says otherwise. */
export const DEFAULT_GMAIL_REPLAY_PHASE = 'seeded';

/** The replay has no answer for a request. Names the request without its query: a page token or an id is not mail, but nothing else is needed to find the gap. */
export class ReplayMissError extends Error {
  constructor(readonly key: string) {
    super(`Gmail replay has no response for ${key.split('?')[0]}`);
    this.name = 'ReplayMissError';
  }
}

/**
 * A fetch that answers from a replay. A request the replay lacks fails loudly
 * instead of being answered out of order (R15). A key that answered
 * differently over time holds an ordered list: each request consumes the next
 * answer, and the last one repeats.
 */
export function replayFetch(replays: GmailReplay[], phase: string): typeof fetch {
  const cursors = new Map<string, number>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = replayKey(init?.method ?? 'GET', String(input));
    const mailbox = replays.find((r) => key.includes(`/users/${r.mailbox}/`));
    const list = mailbox?.phases[phase]?.[key];
    if (!mailbox || !list || list.length === 0) throw new ReplayMissError(key);
    const i = cursors.get(key) ?? 0;
    cursors.set(key, Math.min(i + 1, list.length - 1));
    const reply = list[i];
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

/** Every `*.replay.json` in a directory, in name order. */
export function loadGmailReplays(capability: ReaderCapability, dir: string = DEFAULT_GMAIL_REPLAY_DIR): GmailReplay[] {
  // First, before the directory is read.
  requireReaderCapability(capability);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.replay.json'))
    .sort()
    .map((name) => {
      const replay = JSON.parse(readFileSync(join(dir, name), 'utf8')) as GmailReplay;
      if (replay.format !== GMAIL_REPLAY_FORMAT) throw new Error(`Unknown replay format in ${name}`);
      return replay;
    });
}
