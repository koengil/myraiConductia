// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The reader comes through that module.
import { graphContentSourceOver, type GraphReaderContext } from '../../../src/lib/mailboxAccess/readers';

import type { GraphHttpOptions } from '../../../src/lib/graph/http';
import type { ExtractFn } from '../../../src/lib/graph/reader/drive';
import type { ReaderFactory } from '../../../worker/classify';
import { verifyDigest } from './digest';
import { assertCassetteClean, interactionKey, readCassette, type CassetteData, type CassetteSource } from './format';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces every occurrence of a source's address (raw, lower-cased or encodeURIComponent form, in any
 * letter case) with `<mailbox N>` or `<site N>`, N being the source's index. An address is the tenant's data.
 */
export function redactSources(text: string, sources: CassetteSource[]): string {
  let out = text;
  sources.forEach((source, index) => {
    const label = `<${source.kind === 'mailbox' ? 'mailbox' : 'site'} ${index}>`;
    const forms = [
      ...new Set([source.address, source.address.toLowerCase(), encodeURIComponent(source.address), encodeURIComponent(source.address.toLowerCase())]),
    ].sort((a, b) => b.length - a.length);
    out = out.replace(new RegExp(forms.map(escapeRegExp).join('|'), 'gi'), label);
  });
  return out;
}

const LABEL = /^<(?:mailbox|site) (?:\d+|\?)>$/;

/**
 * Also redacts every mailbox and site segment that matches no source, in both Graph forms
 * (`/users/<x>/`, `users('<x>')`, and `/sites/<x>` up to the next `/`, `?` or `(`), so an unknown
 * address is not printed either.
 */
function redactSegments(text: string): string {
  return text
    .replace(/(\/users\/)([^/?(]+)/gi, (whole, lead: string, segment: string) => (LABEL.test(segment) ? whole : `${lead}<mailbox ?>`))
    .replace(/(users\((?:'|%27))([^')]*?)((?:'|%27)\))/gi, (whole, lead: string, segment: string, tail: string) =>
      LABEL.test(segment) ? whole : `${lead}<mailbox ?>${tail}`,
    )
    .replace(/(\/sites\/)([^/?(]+)/gi, (whole, lead: string, segment: string) => (LABEL.test(segment) ? whole : `${lead}<site ?>`));
}

/**
 * The query values a miss may print, by parameter name (either spelling of `$`), each with the shape its value
 * must have. These are the OData parameters the readers send (`$top`, `$select`): a count, or property names.
 * Everything else is redacted with its name kept: `$skiptoken`, `$deltatoken`, `tempauth` and `token` carry
 * credentials or tenant-issued cursors, and `$filter`, `$search` or any parameter we do not know can carry an
 * address, a subject or a token. A value that does not have the shape (`$select=alex@bank.example`) is redacted too.
 */
const HARMLESS_PARAMS: Record<string, RegExp> = {
  $top: /^\d{1,5}$/,
  $select: /^[A-Za-z0-9_,./]{1,500}$/,
  $orderby: /^[A-Za-z0-9_,./ ]{1,200}$/,
  $count: /^(?:true|false)$/,
};
const PARAM_NAME = /^[A-Za-z0-9_$.%-]{1,64}$/;
const REDACTED = '<redacted>';

/**
 * The literal path segments the readers send (src/lib/graph/reader/mail.ts and drive.ts), lower-cased: resource
 * names and the well-known folder names. Every other segment is a tenant value (a folder, item or drive id, an
 * address, a token), so one longer than MAX_OPAQUE_SEGMENT is redacted. A shorter one stays readable: the
 * ids in a miss are what tells an engineer which request drifted. A literal is never redacted, however it is cased.
 */
const GRAPH_LITERALS = new Set(
  [
    'v1.0', 'beta', 'users', 'sites', 'drives', 'drive', 'root', 'items', 'content', 'children', 'delta',
    'mailFolders', 'childFolders', 'messages', 'attachments', 'me',
    // well-known folder names (EXCLUDED_WELL_KNOWN_FOLDERS and the ones a delta read names)
    'inbox', 'sentitems', 'deleteditems', 'junkemail', 'drafts', 'outbox', 'recoverableitemsdeletions', 'archive',
  ].map((name) => name.toLowerCase()),
);
const MAX_OPAQUE_SEGMENT = 40;
const OPAQUE_SEGMENT = '<segment>';

function redactLongSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.length > MAX_OPAQUE_SEGMENT && !GRAPH_LITERALS.has(segment.toLowerCase()) ? OPAQUE_SEGMENT : segment))
    .join('/');
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * `path?query` of a request, safe to print: query VALUES are redacted (HARMLESS_PARAMS aside), parameter names
 * stay, and the `delta(token='…')` cursor in a path is redacted too. A parameter with no `=` is printed as
 * `<param>` (a bare name can itself be the token), and a path segment over 40 characters that is not a Graph
 * literal as `<segment>`. Source addresses are labelled as before.
 */
export function redactedRequest(url: string, sources: CassetteSource[] = []): string {
  const { pathname, search } = new URL(url);
  // delta(token='…') in either quote spelling: everything up to the closing parenthesis is the cursor.
  const path = pathname.replace(/(\(token=)[^)]*/gi, `$1${REDACTED}`);
  const query = search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const name = at === -1 ? pair : pair.slice(0, at);
      const value = at === -1 ? null : pair.slice(at + 1);
      if (value === null) return '<param>';
      const shown = PARAM_NAME.test(name) ? name : '<param>';
      const shape = HARMLESS_PARAMS[decoded(name).toLowerCase()];
      return `${shown}=${shape?.test(decoded(value)) ? value : REDACTED}`;
    })
    .join('&');
  const label = (text: string) => redactSegments(redactSources(text, sources));
  // The path is cut down after the address labels are in (an address longer than 40 keeps its `<mailbox N>`).
  const shownPath = redactLongSegments(label(path));
  return query ? `${shownPath}?${label(query)}` : shownPath;
}

const COMMIT = /^[0-9a-f]{40}$/;

export class CassetteMissError extends Error {
  /** `url` stays a property for tests; the message never prints it. */
  constructor(
    readonly method: string,
    readonly url: string,
    sources: CassetteSource[] = [],
    readerCommit?: string,
  ) {
    // Only a well-formed sha is printed: a manifest that came from elsewhere never puts free text in the message.
    const recordedWith =
      readerCommit && COMMIT.test(readerCommit)
        ? `, or check out ${readerCommit} (the reader this cassette was recorded with)`
        : '';
    super(
      `no recorded response for ${method} ${redactedRequest(url, sources)}. ` +
        `The readers asked for something this cassette does not hold; re-record it (scripts/m365/README.md, "Record and replay")${recordedWith}.`,
    );
    this.name = 'CassetteMissError';
  }
}

/**
 * `requests` and `misses` hold `METHOD path?query` in the redacted form (redactedRequest), never a raw URL:
 * a failed assertion prints them. What was asked for is checked through `unrequested()`, a count kept by
 * interaction, because two different recorded keys can redact to the same line.
 */
export type ReplayFetch = typeof fetch & { requests: string[]; misses: string[]; unrequested: () => number };

export function replayFetch(data: CassetteData): ReplayFetch {
  const byKey = new Map(data.interactions.map((i) => [interactionKey(i.method, i.url), i]));
  const requested = new Set<string>(); // keys of recorded interactions that were asked for; never exposed
  const requests: string[] = [];
  const misses: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const key = interactionKey(method, url);
    const shown = `${method} ${redactedRequest(url, data.manifest.sources)}`;
    requests.push(shown);
    const hit = byKey.get(key);
    if (!hit) {
      misses.push(shown);
      throw new CassetteMissError(method, url, data.manifest.sources, data.manifest.readerCommit);
    }
    requested.add(key);
    let body: BodyInit | null;
    if (hit.bodyRef) {
      // Never an empty replay: a body the cassette does not hold is a corrupt cassette, not a 200 with no content.
      const bytes = data.bodies.get(hit.bodyRef);
      if (!bytes) throw new Error(`the cassette holds no body for a recorded ${hit.status} response (bodyRef is not in bodies/); it is corrupt, re-record it`);
      body = bytes as BodyInit;
    } else {
      body = hit.body ?? null;
    }
    return new Response(body, { status: hit.status, headers: hit.headers });
  }) as typeof fetch;
  const unrequested = () => [...byKey.keys()].filter((key) => !requested.has(key)).length;
  return Object.assign(impl, { requests, misses, unrequested });
}

export type Cassette = CassetteData & { dir: string; digestSha256: string; fetch: ReplayFetch };

export function loadCassette(dir: string): Cassette {
  const { digestSha256 } = verifyDigest(dir); // first: a missing, extra or altered file is refused before anything reads it
  const data = readCassette(dir);
  assertCassetteClean(data); // a cassette dragged in from elsewhere is refused, not replayed
  return { ...data, dir, digestSha256, fetch: replayFetch(data) };
}

/** Graph options for replay: a static token (no MSAL), no waits, and a miss is never retried. */
export function replayHttp(fetchImpl: typeof fetch): GraphHttpOptions {
  return { getToken: async () => 'replay', fetchImpl, sleep: async () => undefined, maxAttempts: 1 };
}

/**
 * The worker's readerFor over a cassette: the real Graph readers, no network. runOnce wraps what this
 * returns in the mailbox guard before the first page, like any readerFor override.
 */
export function replayReaderFor(cassette: Cassette, options: { extract?: ExtractFn } = {}): ReaderFactory {
  const context: GraphReaderContext = { http: replayHttp(cassette.fetch), extract: options.extract };
  return (source) => graphContentSourceOver(source.kind, context);
}
