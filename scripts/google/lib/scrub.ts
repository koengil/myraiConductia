import type { GmailReplay, ReplayResponse } from '../../../src/lib/google/replay/format';

// The recorder's scrubber (#259 R15). It runs before any file is written.
//
// The patterns are assembled from fragments on purpose: the repo's "no keys
// committed" grep looks for the literal key-material strings, and a scrubber
// that spells them out would trip it.
const SECRET_PATTERN = new RegExp(
  [String.raw`ya29\.`, String.raw`Bearer\s`, '"private_' + 'key"', '-----' + 'BEGIN'].join('|'),
);

export type AddressMap = Record<string, string>; // trial address -> persona address

function rewriteText(text: string, map: AddressMap): string {
  let out = text;
  for (const [trial, persona] of Object.entries(map)) {
    out = out.split(trial).join(persona);
    out = out.split(encodeURIComponent(trial)).join(encodeURIComponent(persona));
  }
  return out;
}

const IDENTITY_FIELDS = new Set(['emailAddress', 'userId']);

// The top-level MIME headers a raw message keeps: what src/lib/google/reader/mime.ts
// reads, and what it needs to decode the body. Everything else at the top of a
// raw message is transport metadata Gmail added on delivery (Delivered-To,
// Received, X-Received, X-Forwarded-Encrypted, ARC-*, DKIM-Signature,
// Authentication-Results, ...), which names the trial domain and Google's
// servers and carries nothing the reader uses. Part headers inside the body
// are left alone.
const RAW_KEPT_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

function scrubRawHeaders(rawBase64Url: string): string {
  const text = Buffer.from(rawBase64Url, 'base64url').toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  if (end < 0) return rawBase64Url;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept: string[] = [];
  let keeping = false;
  for (const line of text.slice(0, end).split(/\r?\n/)) {
    // A folded line continues the header above it.
    if (/^[ \t]/.test(line)) {
      if (keeping) kept.push(line);
      continue;
    }
    keeping = RAW_KEPT_HEADERS.has(line.slice(0, line.indexOf(':')).trim().toLowerCase());
    if (keeping) kept.push(line);
  }
  const out = kept.join(eol) + text.slice(end);
  // latin1 round-trips every byte, so an 8-bit body is not re-encoded.
  return Buffer.from(out, 'latin1').toString('base64url');
}

function rewriteValue(value: unknown, map: AddressMap, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'raw') return scrubRawHeaders(value);
    return key && IDENTITY_FIELDS.has(key) ? rewriteText(value, map) : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteValue(v, map, k)]));
  }
  return value;
}

function assertNoSecrets(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) throw new Error(`Refusing to record: a secret-shaped string in ${where}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => assertNoSecrets(v, where));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertNoSecrets(k, where);
      assertNoSecrets(v, where);
    }
  }
}

/** The replay as text, with every raw message decoded, so a check sees the MIME too. */
function searchableText(value: unknown): string {
  const json = JSON.stringify(value);
  const decoded = [...json.matchAll(/"raw":"([A-Za-z0-9_-]+)"/g)].map((m) => Buffer.from(m[1], 'base64url').toString('latin1'));
  return [json, ...decoded].join('\n');
}

function assertNoTrialAddress(value: unknown, map: AddressMap, where: string): void {
  const text = searchableText(value).toLowerCase();
  for (const trial of Object.keys(map)) {
    if (text.includes(trial.toLowerCase())) throw new Error(`Refusing to record: a trial address remains in ${where}`);
  }
}

/** Rejects secret-shaped strings (raw messages decoded), rewrites the trial
 * address to the persona address in request keys and in JSON emailAddress /
 * userId fields, drops the transport headers from each raw message, and
 * refuses to return a replay that still names a trial address. Response
 * headers and request headers are never part of a replay. */
export function scrubReplay(replay: GmailReplay, map: AddressMap = {}): GmailReplay {
  assertNoSecrets(replay, 'the replay');
  if (SECRET_PATTERN.test(searchableText(replay))) throw new Error('Refusing to record: a secret-shaped string in a raw message');
  const phases: GmailReplay['phases'] = {};
  for (const [phase, keys] of Object.entries(replay.phases)) {
    phases[phase] = {};
    for (const [key, responses] of Object.entries(keys)) {
      const rewrittenKey = rewriteText(key, map);
      phases[phase][rewrittenKey] = responses.map(
        (r): ReplayResponse => ({ ...r, body: rewriteValue(r.body, map) }),
      );
    }
  }
  const out: GmailReplay = { ...replay, mailbox: rewriteText(replay.mailbox, map), phases };
  assertNoTrialAddress(out, map, 'the scrubbed replay');
  return out;
}
