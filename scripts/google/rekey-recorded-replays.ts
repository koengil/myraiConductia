import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GMAIL_HISTORY_FIELDS,
  GMAIL_METADATA_HEADERS,
  GMAIL_METADATA_QUERY,
  GMAIL_THREAD_LIST_FIELDS,
  GMAIL_THREAD_METADATA_QUERY,
} from '../../src/lib/constants/googleReader';
import { replayKey, type GmailReplay, type ReplayResponse } from '../../src/lib/google/replay/format';
import { argValue } from './lib/live';

// Re-keys the committed recorded replays (tests/fixtures/discovery/gmail, from the
// Oct 7 trial; `synthetic: false`) to the queries the reader makes now (#263), and
// reduces their listing, history and metadata answers to what Gmail returns under
// the reader's `fields` masks. The twin (gmail-twin/) is NOT touched: the twin
// builder owns it. This script owns these three files and nothing else.
//
//   node --import tsx scripts/google/rekey-recorded-replays.ts [--dir <dir>]
//
// Why a transform and not a re-recording: the reader no longer asks for `snippet`
// (about 200 characters of the body) on any call before the policy has run, and its
// metadata header list changed (#263, #337). That changes every replay key, and a live recording
// needs the owner's trial domain (thread T2). Until a fresh recording replaces them,
// each file says it was transformed: it keeps `synthetic: false` (the mail is real
// Google answers) but is no longer the bytes Google sent.
//
// Deterministic and idempotent: running it again changes nothing. Raw (`format=raw`)
// answers, the profile, the recorder-only messages.list and every error answer are
// kept byte for byte.

export const DEFAULT_RECORDED_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail');

export const TRANSFORMED_NOTE =
  'Request keys rewritten to the reader\'s queries (fields masks and metadata header list) and ' +
  'snippet, sizeEstimate, payload.mimeType and other fields outside those masks removed from listing, history and ' +
  'metadata answers (#263), and metadata headers the reader no longer asks for removed (#337). ' +
  'Not the bytes Google sent; replace with a fresh live recording (thread T2).';

const ORIGIN = 'https://gmail.googleapis.com';
const MESSAGE_KEEP = ['id', 'threadId', 'labelIds', 'internalDate', 'historyId', 'payload', 'classificationLabelValues'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keeps `keep`, in the answer's own order. */
function pick(source: Json, keep: readonly string[]): Json {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keep.includes(key)));
}

const METADATA_HEADER_NAMES = new Set<string>(GMAIL_METADATA_HEADERS.map((h) => h.toLowerCase()));

function maskMessage(message: unknown): unknown {
  if (!isObject(message)) return message;
  const kept = pick(message, MESSAGE_KEEP);
  if (isObject(kept.payload)) {
    const payload = pick(kept.payload, ['headers']);
    // Gmail returns only the requested metadataHeaders: a recorded header the reader no longer asks for goes (#337).
    if (Array.isArray(payload.headers)) {
      payload.headers = payload.headers.filter((h) => isObject(h) && typeof h.name === 'string' && METADATA_HEADER_NAMES.has(h.name.toLowerCase()));
    }
    kept.payload = payload;
  }
  return kept;
}

function maskHistoryMessage(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const out: Json = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'message') out.message = isObject(value) ? pick(value, ['id', 'threadId', 'labelIds']) : value;
    else if (key === 'labelIds') out.labelIds = value;
  }
  return out;
}

const maskers = {
  threadList: (body: unknown) => {
    if (!isObject(body)) return body;
    const kept = pick(body, ['threads', 'nextPageToken']);
    if (Array.isArray(kept.threads)) kept.threads = kept.threads.map((t) => (isObject(t) ? pick(t, ['id', 'historyId']) : t));
    return kept;
  },
  threadMetadata: (body: unknown) => {
    if (!isObject(body)) return body;
    const kept = pick(body, ['id', 'historyId', 'messages']);
    if (Array.isArray(kept.messages)) kept.messages = kept.messages.map(maskMessage);
    return kept;
  },
  messageMetadata: maskMessage,
  history: (body: unknown) => {
    if (!isObject(body)) return body;
    const kept = pick(body, ['history', 'historyId', 'nextPageToken']);
    if (Array.isArray(kept.history)) {
      kept.history = kept.history.map((record) => {
        if (!isObject(record)) return record;
        const out = pick(record, ['id', 'messagesAdded', 'labelsRemoved']);
        for (const field of ['messagesAdded', 'labelsRemoved'] as const) {
          if (Array.isArray(out[field])) out[field] = (out[field] as unknown[]).map(maskHistoryMessage);
        }
        return out;
      });
    }
    return kept;
  },
};

type Kind = keyof typeof maskers;

/** The reader's key for a recorded one, and how to mask its answer; null for a key that stays as recorded. */
export function rekey(key: string): { key: string; kind: Kind } | null {
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const target = key.slice(space + 1);
  const url = new URL(`${ORIGIN}${target}`);
  const path = decodeURIComponent(url.pathname);
  const rebuild = (query: string) => replayKey(method, `${ORIGIN}${url.pathname}?${query}`);
  const keepParams = (...drop: string[]) =>
    [...url.searchParams.entries()]
      .filter(([name]) => !drop.includes(name))
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);

  if (/\/users\/[^/]+\/threads$/.test(path)) {
    return { key: rebuild([...keepParams('fields'), `fields=${GMAIL_THREAD_LIST_FIELDS}`].join('&')), kind: 'threadList' };
  }
  if (/\/users\/[^/]+\/threads\/[^/]+$/.test(path) && url.searchParams.get('format') === 'metadata') {
    return { key: rebuild(GMAIL_THREAD_METADATA_QUERY), kind: 'threadMetadata' };
  }
  if (/\/users\/[^/]+\/messages\/[^/]+$/.test(path) && url.searchParams.get('format') === 'metadata') {
    return { key: rebuild(GMAIL_METADATA_QUERY), kind: 'messageMetadata' };
  }
  if (/\/users\/[^/]+\/history$/.test(path)) {
    return { key: rebuild([...keepParams('fields'), `fields=${GMAIL_HISTORY_FIELDS}`].join('&')), kind: 'history' };
  }
  return null;
}

/** The re-keyed, masked replay. Pure. */
export function transformReplay(replay: GmailReplay): GmailReplay {
  const phases: GmailReplay['phases'] = {};
  for (const [phase, entries] of Object.entries(replay.phases)) {
    const next: Record<string, ReplayResponse[]> = {};
    for (const [key, responses] of Object.entries(entries)) {
      const target = rekey(key);
      if (!target) {
        next[key] = responses;
        continue;
      }
      next[target.key] = responses.map((response) =>
        response.status === 200 ? { ...response, body: maskers[target.kind](response.body) } : response,
      );
    }
    phases[phase] = next;
  }
  // `transformed` sits right after `synthetic`, where a reader of the file sees it first.
  const { format, mailbox, synthetic } = replay;
  return { format, mailbox, synthetic, transformed: TRANSFORMED_NOTE, phases };
}

function main(): void {
  const dir = resolve(argValue(process.argv, '--dir') ?? DEFAULT_RECORDED_DIR);
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.replay.json')).sort()) {
    const file = join(dir, name);
    const replay = JSON.parse(readFileSync(file, 'utf8')) as GmailReplay;
    // Never the twin: its builder owns it.
    if (replay.synthetic) throw new Error(`${name} is synthetic: the twin builder owns it, not this transform`);
    writeFileSync(file, `${JSON.stringify(transformReplay(replay), null, 2)}\n`);
    console.log(`transformed ${name}`);
  }
}

if (process.argv[1]?.endsWith('rekey-recorded-replays.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
