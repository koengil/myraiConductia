// Raw capture at the fetchImpl seam (CDT-277). It wraps a `fetch`, captures every
// attempt unscrubbed, and hands the reader an equivalent response. Its full
// headers go back to the reader, so `retry-after` and `request-id` still behave.
// Only scrub decides what is stored.
//
// Capture of a DOWNLOAD is bounded: its body is read as a stream and stops after maxBytes + 1 bytes
// (the rest is cancelled). The reader gets only those bytes, so its byte cap fires exactly as it does
// live (GraphDownloadTooLargeError, ledgered too_large), and neither memory nor the cassette holds a
// whole oversized file. Replay recomputes content-length from the stored bytes and does the same.
// A download is what graphDownload reads through readCapped: a non-3xx response off graph.microsoft.com
// (the second hop) or from a path ending in /content (a direct 200). Graph JSON pages are captured
// whole, as the live reader reads them whole (graphJson → res.json()): a mail page holds up to 50 full
// message bodies, and truncating it would hand the reader broken JSON and abort the recording.
//
// The capture is an observer (#318): `observe(request, response)` records one response and hands back the response
// the reader gets, and `fetch` is `inner` followed by `observe`. A guarded recording session (readers.ts) hands
// its own responses to `observe` and never a request header or a token. Two rules live in `observe`, where every
// recording passes, and abort the whole capture (nothing is written): a 2xx collection page with no `value` array,
// and any URL that addresses a user by object id.

import { EXTRACT_MAX_BYTES } from '../../../src/lib/constants/discovery';
// Type-only, so this file loads no reader and claims no capability: the one definition is readers.ts's.
import type { ResponseObserver } from '../../../src/lib/mailboxAccess/readers';
import { RecorderRefusal } from './refusal';

export type RawInteraction = {
  method: string;
  url: string;
  status: number;
  /** Every response header, lower-cased names. Scrub keeps the allowlist only. */
  headers: Record<string, string>;
  bytes: Uint8Array | null;
};

/** Reads at most `limit` bytes of a body, then cancels the rest. */
async function readBounded(res: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, limit - total);
    chunks.push(take === value.byteLength ? value : value.subarray(0, take));
    total += take;
  }
  await reader.cancel().catch(() => undefined); // a no-op once the body is done
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const isDownload = (url: string): boolean => {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname !== 'graph.microsoft.com' || pathname.endsWith('/content');
  } catch {
    return true; // unparseable: never read unbounded
  }
};

/** The decoded path of a request URL, or '' when it is not one. */
function pathOf(url: string): string {
  try {
    const { pathname } = new URL(url, 'https://graph.microsoft.com');
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  } catch {
    return '';
  }
}

/**
 * `/users/<guid>/` or `/users('<guid>')/` (Graph's links use either form): a read by object id. The readers address a
 * mailbox by address (mail.ts, mailboxPath), never by id.
 */
const USER_OBJECT_ID_PATH =
  /\/users(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'\))(?:\/|$)/i;
const OBJECT_ID_READ = 'a read addressed a user by object id; nothing is written';

/** The collection and delta queries the readers page through: mail folders, child folders, drives, drive delta and message delta. */
const COLLECTION_PATH = /\/(?:mailFolders|childFolders|drives|children|(?:microsoft\.graph\.)?delta(?:\(.*\))?)$/;

/** Parses a collection page's `value`; anything but an array is a malformed page. */
function hasValueArray(bytes: Uint8Array): boolean {
  try {
    const page = JSON.parse(new TextDecoder().decode(bytes)) as { value?: unknown } | null;
    return Array.isArray(page?.value);
  } catch {
    return false;
  }
}

export function createRecorder(
  inner: typeof fetch,
  options: { maxBytes?: number } = {},
): { fetch: typeof fetch; observe: ResponseObserver; raw: RawInteraction[] } {
  const maxBytes = options.maxBytes ?? EXTRACT_MAX_BYTES;
  const raw: RawInteraction[] = [];
  // An abort is sticky. graphFetch retries a transport that throws, so the retry must fail here and never reach Graph.
  let aborted: RecorderRefusal | null = null;
  const abort = (reason: string): never => {
    aborted ??= new RecorderRefusal(reason);
    throw aborted;
  };
  const observe: ResponseObserver = async ({ method: requestMethod, url }, res) => {
    if (aborted) {
      await res.body?.cancel().catch(() => undefined);
      throw aborted;
    }
    const method = requestMethod.toUpperCase();
    // The readers only read. A POST here would be a token or vault call leaking into the Graph seam.
    if (method !== 'GET') throw new Error(`The Graph recorder records GET only, not ${method}`);
    // Belt: no object-id read is ever recorded (and so none of #275's binding check, which carries one).
    if (USER_OBJECT_ID_PATH.test(pathOf(url))) {
      await res.body?.cancel().catch(() => undefined);
      abort(OBJECT_ID_READ);
    }
    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      raw.push({ method, url, status: res.status, headers, bytes: null });
      return new Response(null, { status: res.status, headers: res.headers });
    }
    const download = isDownload(url);
    const bytes = download ? await readBounded(res, maxBytes + 1) : new Uint8Array(await res.arrayBuffer());
    // A page with no `value` reads as an empty one (graphPages), and an empty folder list reads as a finished
    // cycle: the recording would replay a tenant with nothing in it. Refuse it where it is seen.
    if (!download && res.status >= 200 && res.status < 300 && COLLECTION_PATH.test(pathOf(url)) && !hasValueArray(bytes)) {
      abort('a collection page had no value array; nothing is written');
    }
    raw.push({ method, url, status: res.status, headers, bytes });
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    // Refused before the request is sent, not after it is answered.
    if (aborted) throw aborted;
    if (method !== 'GET') throw new Error(`The Graph recorder records GET only, not ${method}`);
    const url = input instanceof Request ? input.url : String(input);
    if (USER_OBJECT_ID_PATH.test(pathOf(url))) abort(OBJECT_ID_READ);
    return observe({ method, url }, await inner(input, init));
  }) as typeof fetch;
  return { fetch: recordingFetch, observe, raw };
}
