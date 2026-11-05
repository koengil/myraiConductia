import { createHash } from 'node:crypto';

import {
  ALLOWED_RESPONSE_HEADERS,
  CASSETTE_FORMAT,
  type AllowedHeader,
  type CassetteData,
  type CassetteSource,
  type Interaction,
} from './format';
import { createTokenRewriter, maskTokens } from './paging';
import type { RawInteraction } from './recordFetch';

/**
 * Raw capture → cassette data. Rules, in order:
 *   0. divergence refusal: every FINAL raw response (2xx, 3xx, 404) for one key must agree, or the
 *      tenant changed during the recording and scrub throws ScrubDivergenceError (a count, never a URL)
 *   1. collapse retries: one interaction per `METHOD url`, the LAST response wins,
 *      kept at the position the key was first seen (drops 401/429/5xx intermediates)
 *   2. response headers: allowlist only; the dropped NAMES are returned, never values
 *   3. bodies: JSON → canonical text (JSON.stringify(JSON.parse(text))), no content-length. An error
 *      body (status >= 400) is reduced to {"error":{"code":<error.code>}}: Graph's message and innerError
 *      (date, request-id, client-request-id) are correlation data and change on every call. An error
 *      response whose body is not JSON (a SharePoint HTML error page) keeps NO body at all: such a page
 *      carries correlation ids and cannot be reduced to a code
 *   4. downloads: every 3xx Location → https://replay.invalid/content/<n> (first-seen order), the
 *      interaction it points at re-keyed to match; a non-JSON body → bodies/<sha256>, with a
 *      content-length recomputed from the bytes. Only the Locations of KEPT 3xx responses are mapped: a
 *      non-Graph interaction that no kept Location points at (the earlier hop of a driveItem that
 *      appeared twice in a delta feed) is an orphan and is dropped, and counted in orphansDropped
 *   5. paging tokens ($skiptoken, $deltatoken, token=, delta(token='…')) → r<n>, first-seen order, in
 *      each request URL and in each body's @odata.nextLink / @odata.deltaLink. A body link is
 *      normalized with new URL(link).toString() first, which is what graphUrl does to the request it
 *      becomes, so the two forms of one link always meet on the same placeholder.
 *   6. retry collapse: rule 1, which is why a 429's throttle headers never reach the cassette.
 * Rules 2 and 5 name what they dropped or rewrote by kind only, never by value; lintCassette proves
 * they worked.
 */

/** Where every download hop is replayed from: a name that can never resolve, so no real host is stored. */
export const REPLAY_ORIGIN = 'https://replay.invalid';

const ALLOWED = new Set<string>(ALLOWED_RESPONSE_HEADERS);
const decoder = new TextDecoder();

const GRAPH_HOST = 'graph.microsoft.com';

const isJson = (headers: Record<string, string>) => /json/i.test(headers['content-type'] ?? '');
const isRedirect = (status: number) => status >= 300 && status < 400;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const keyOf = (item: RawInteraction) => `${item.method.toUpperCase()} ${item.url}`;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** Thrown when one key was answered differently during the recording. It names a count, never a URL. */
export class ScrubDivergenceError extends Error {
  constructor(readonly keys: number) {
    super(`the tenant changed during the recording (${keys} keys); re-record`);
    this.name = 'ScrubDivergenceError';
  }
}

/** Error bodies keep Graph's error code only; message and innerError are correlation data. */
function reduceErrorBody(parsed: unknown): string {
  const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return JSON.stringify({ error: typeof code === 'string' ? { code } : {} });
}

/** The canonical text a JSON body is stored as: reduced when it is an error body. */
function canonicalJson(text: string, status: number): string {
  const parsed: unknown = JSON.parse(text);
  return status >= 400 ? reduceErrorBody(parsed) : JSON.stringify(parsed);
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sortKeys(v)]),
        )
      : value;

/** A JSON content type AND text that parses: the only error body scrub keeps (reduced to its code). */
function parsesAsJson(item: RawInteraction): boolean {
  if (!item.bytes || !isJson(item.headers)) return false;
  try {
    JSON.parse(decoder.decode(item.bytes));
    return true;
  } catch {
    return false;
  }
}

/** What "the same answer" means for one final response. A 3xx is its status only; a hop is compared separately. */
function signature(item: RawInteraction): string {
  if (isRedirect(item.status)) return `${item.status}`;
  if (!item.bytes || item.bytes.byteLength === 0) return `${item.status} empty`;
  // A non-JSON error body is dropped by scrubOne, so what it said (per-call ids) is not part of the answer.
  if (item.status >= 400 && !parsesAsJson(item)) return `${item.status} empty`;
  if (isJson(item.headers)) {
    try {
      const reduced = canonicalJson(decoder.decode(item.bytes), item.status);
      // Property order and Graph's per-call fields never count as a change; paging tokens are masked.
      return `${item.status} json ${maskTokens(JSON.stringify(sortKeys(JSON.parse(reduced))))}`;
    } catch {
      // not JSON after all: compared by its bytes
    }
  }
  return `${item.status} bytes ${sha256(item.bytes)}`;
}

const isFinal = (item: RawInteraction) =>
  (item.status >= 200 && item.status < 400) || item.status === 404; // 401, 429 and 5xx are retry intermediates

/**
 * Rule 0. Collapse keeps one answer per key, so it would hide a tenant that changed between two reads
 * of one key (a listing requested in both the backfill and the delta round). Replay would then run
 * a backfill whose deltaLink the delta round misses. Refuse instead.
 */
function assertNoDivergence(raw: RawInteraction[]): void {
  const finals = new Map<string, RawInteraction[]>();
  for (const item of raw) {
    if (!isFinal(item)) continue;
    const list = finals.get(keyOf(item)) ?? [];
    list.push(item);
    finals.set(keyOf(item), list);
  }
  const diverged = new Set<string>();
  for (const [key, list] of finals) {
    if (new Set(list.map(signature)).size > 1) diverged.add(key);
    // A second hop is compared by its bytes, against the hop of the kept 3xx for the same /content key:
    // the orphan it replaces must carry the same bytes.
    const hops = new Set<string>();
    for (const redirect of list) {
      const location = redirect.headers['location'];
      if (!isRedirect(redirect.status) || !location) continue;
      const hop = (finals.get(`GET ${location}`) ?? []).at(-1);
      if (hop?.bytes) hops.add(`${hop.status} ${sha256(hop.bytes)}`);
    }
    if (hops.size > 1) diverged.add(key);
  }
  if (diverged.size > 0) throw new ScrubDivergenceError(diverged.size);
}

function collapse(raw: RawInteraction[]): RawInteraction[] {
  const slots = new Map<string, RawInteraction>();
  for (const item of raw) {
    // Map keeps the first-seen position of a key; set() only replaces its value.
    slots.set(keyOf(item), item);
  }
  return [...slots.values()];
}

/** Rule 5: rewrites the paging tokens of one interaction, walking in recorded order (so a link is seen before its request). */
function rewritePaging(interaction: Interaction, rewrite: (text: string) => string): Interaction {
  const out: Interaction = { ...interaction, url: rewrite(interaction.url) };
  if (interaction.body === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(interaction.body);
  } catch {
    return out; // not JSON: lint still scans it
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const record = parsed as Record<string, unknown>;
  let touched = false;
  for (const field of ['@odata.nextLink', '@odata.deltaLink']) {
    const link = record[field];
    if (typeof link !== 'string') continue;
    let normalized = link;
    try {
      normalized = new URL(link).toString();
    } catch {
      // an unparseable link stays as it is; lint reports it
    }
    record[field] = rewrite(normalized);
    touched = true;
  }
  if (touched) out.body = JSON.stringify(record);
  return out;
}

/** Rule 4, first half: each distinct redirect target gets a placeholder, numbered in first-seen order. */
function downloadPlaceholders(items: RawInteraction[]): Map<string, string> {
  const placeholders = new Map<string, string>();
  for (const item of items) {
    const location = item.headers['location'];
    if (isRedirect(item.status) && location && !placeholders.has(location)) {
      placeholders.set(location, `${REPLAY_ORIGIN}/content/${placeholders.size + 1}`);
    }
  }
  return placeholders;
}

function scrubOne(
  item: RawInteraction,
  placeholders: Map<string, string>,
  dropped: Set<string>,
  bodies: Map<string, Uint8Array>,
): Interaction {
  const headers: Partial<Record<AllowedHeader, string>> = {};
  for (const [name, value] of Object.entries(item.headers)) {
    if (ALLOWED.has(name)) headers[name as AllowedHeader] = value;
    else dropped.add(name);
  }

  const location = item.headers['location'];
  if (isRedirect(item.status) && location) headers.location = placeholders.get(location) ?? location;

  const out: Interaction = { method: 'GET', url: placeholders.get(item.url) ?? item.url, status: item.status, headers };
  if (item.status >= 400 && !parsesAsJson(item)) {
    // An error page (HTML, plain text, or JSON-typed text that is not JSON): no body, and no length of one.
    delete out.headers['content-length'];
  } else if (item.bytes && item.bytes.byteLength > 0) {
    if (isJson(item.headers)) {
      const text = decoder.decode(item.bytes);
      try {
        out.body = canonicalJson(text, item.status);
        delete out.headers['content-length']; // the canonical text has a different length
      } catch {
        out.body = text; // not JSON after all: kept as raw text; lint still scans it
      }
    } else {
      const sha = sha256(item.bytes);
      bodies.set(sha, item.bytes);
      out.bodyRef = sha;
      out.headers['content-length'] = String(item.bytes.byteLength);
    }
  }
  return out;
}

export function scrub(
  raw: RawInteraction[],
  meta: { sources: CassetteSource[]; recordedAt: string },
): { cassette: CassetteData; droppedHeaders: string[]; orphansDropped: number } {
  assertNoDivergence(raw); // before anything is collapsed: nothing is written on a refusal
  const dropped = new Set<string>();
  // Every attempt counts: a 429's throttle headers are dropped with the attempt itself, and still reported.
  for (const item of raw) for (const name of Object.keys(item.headers)) if (!ALLOWED.has(name)) dropped.add(name);
  const bodies = new Map<string, Uint8Array>();
  const collapsed = collapse(raw);

  // Only the Locations of kept 3xx responses are mapped. A non-Graph interaction no kept Location points
  // at is an orphan (live: its URL carries a tempauth credential), so it is dropped, not rewritten.
  const keptLocations = new Set(
    collapsed.filter((item) => isRedirect(item.status) && item.headers['location']).map((item) => item.headers['location']),
  );
  const kept = collapsed.filter((item) => {
    const host = hostOf(item.url);
    return host === null || host === GRAPH_HOST || keptLocations.has(item.url);
  });
  const orphansDropped = collapsed.length - kept.length;

  const placeholders = downloadPlaceholders(kept);
  const rewrite = createTokenRewriter();
  const interactions = kept
    .map((item) => scrubOne(item, placeholders, dropped, bodies))
    .map((interaction) => rewritePaging(interaction, rewrite));
  const sorted = new Map([...bodies].sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    cassette: {
      manifest: {
        format: CASSETTE_FORMAT,
        recordedAt: meta.recordedAt,
        sources: meta.sources,
        interactions: interactions.length,
        bodies: Object.fromEntries([...sorted].map(([sha, bytes]) => [sha, bytes.byteLength])),
      },
      interactions,
      bodies: sorted,
    },
    droppedHeaders: [...dropped].sort(),
    orphansDropped,
  };
}
