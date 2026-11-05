// The answer key: the true deals of a test tenant and which items belong to
// them. It is the held-out ground truth of the deal-discovery eval (design
// Q15, handoff 09 rule 8), so two rules hold:
//
//   1. It is read from EVAL_ANSWER_KEY_PATH only, and a path inside the repo
//      (this working tree, or the main checkout git names for it) is refused,
//      after symlinks are resolved. The key never enters the
//      development loop: no test, fixture or script in the repo holds one.
//   2. Nothing in the app imports this package (an ESLint fence), so the key
//      cannot reach application code either.
//
// Format, version 1 (`format` must be exactly ANSWER_KEY_FORMAT):
//
//   {
//     "format": "conductia.deal-discovery.answer-key/v1",
//     "itemCoverage": "complete",          // or "partial", see below
//     "deals": [
//       {
//         "id": "T01",                     // unique; items refer to it
//         "name": "Project Falcon",        // shown on the scorecard
//         "codename": "Falcon",            // optional; "Project " is ignored when matching
//         "aliases": ["Heliotrope sale"],  // optional; other names the deal goes by
//         "side": "sell",                  // optional: sell | buy | other
//         "parties": [                     // optional; the external companies on the deal
//           { "name": "Heliotrope Inc", "domains": ["heliotrope.example"], "role": "target" }
//         ],
//         "window": { "start": "2026-01-15", "end": "2026-06-30" }   // optional; end optional
//       }
//     ],
//     "items": [
//       { "kind": "message", "internetMessageId": "<falcon-001@bank.example>", "dealIds": ["T01"] },
//       { "kind": "message", "internetMessageId": "<fwd-008@bank.example>", "dealIds": ["T02"], "attachmentOnly": true },
//       { "kind": "message", "internetMessageId": "<lunch-006@bank.example>", "dealIds": [] },
//       { "kind": "document", "path": "Falcon/CIM v3.pdf", "driveItemId": "01ABCDEF", "dealIds": ["T01"] }
//     ]
//   }
//
// Items:
//   - A message is keyed by its Internet Message-ID header, the same value on
//     every mailbox copy. Angle brackets are optional; matching ignores case.
//     A value with no "@" is refused: it is a Graph message id, which would
//     never match.
//   - A document is keyed by its path inside the document library, as the
//     reader records it (folder path, then the file name; a leading slash and
//     case are ignored). A bare file name matches when exactly one stored
//     document has that name. driveItemId, the Graph driveItem id, is
//     optional: only with it can the scorer find a document the worker read
//     but did not store (unrouted, or skipped with a reason), because the
//     ledger records documents by that id and holds no path.
//   - dealIds lists every deal the item is evidence for. An empty list marks
//     an item that belongs to no deal (a negative label).
//   - attachmentOnly marks a message whose deal evidence sits only in a mail
//     attachment. The worker does not read mail attachments yet (phase 4),
//     so such a miss is reported apart from routing misses.
//
// itemCoverage:
//   - "complete": every item in the tenant that belongs to a deal is listed,
//     so a routed item missing from the key counts against item precision.
//   - "partial": the list is a sample, so routed items missing from the key
//     are counted as unlabeled and left out of item precision.
//
// Validation is strict: an unknown field, a duplicate id or item, a dealIds
// entry naming no deal, or a malformed or impossible date (2026-02-30) is an
// error with its path, so a
// typo in a converted key fails loudly instead of scoring silently wrong.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANSWER_KEY_FORMAT = 'conductia.deal-discovery.answer-key/v1';
export const ANSWER_KEY_ENV = 'EVAL_ANSWER_KEY_PATH';

export type DealSide = 'sell' | 'buy' | 'other';
export type ItemCoverage = 'complete' | 'partial';

export type KeyParty = { name: string; domains: string[]; role: string | null };

export type KeyDeal = {
  id: string;
  name: string;
  codename: string | null;
  aliases: string[];
  side: DealSide | null;
  parties: KeyParty[];
  window: { start: string | null; end: string | null };
};

export type KeyMessageItem = {
  kind: 'message';
  internetMessageId: string;
  dealIds: string[];
  attachmentOnly: boolean;
};

export type KeyDocumentItem = {
  kind: 'document';
  path: string;
  driveItemId: string | null;
  dealIds: string[];
};

export type KeyItem = KeyMessageItem | KeyDocumentItem;

export type AnswerKey = {
  format: typeof ANSWER_KEY_FORMAT;
  itemCoverage: ItemCoverage;
  deals: KeyDeal[];
  items: KeyItem[];
};

export type ParseResult = { ok: true; key: AnswerKey } | { ok: false; errors: string[] };

// ── Normalized identities, shared with the scorer ───────────────────────────

/** An Internet Message-ID as the scorer compares it: bracketed, lower case. */
export function normalizeMessageId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const bare = trimmed.replace(/^<+/, '').replace(/>+$/, '');
  return `<${bare}>`;
}

/** A document path as the scorer compares it: forward slashes, no leading slash, lower case. */
export function normalizeDocumentPath(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// ── Validation ───────────────────────────────────────────────────────────────

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * An ISO date (YYYY-MM-DD) or a full timestamp that names a real instant.
 * Date.parse rolls an impossible date over (2026-02-30 reads as March 2), so
 * each field is checked against the calendar instead (review item 7).
 */
export function isRealIsoDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1])) return false;
  if (m[4] === undefined) return true;
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), m[6] === undefined ? 0 : Number(m[6])];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[7] !== undefined && (Number(m[7]) > 14 || Number(m[8]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  fields(value: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, `unknown field (allowed: ${allowed.join(', ')})`);
    }
  }

  text(value: Obj, key: string, path: string, options: { optional?: boolean } = {}): string | null {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      if (!options.optional) this.fail(`${path}.${key}`, 'is required');
      return null;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      this.fail(`${path}.${key}`, 'must be a non-empty string');
      return null;
    }
    return raw.trim();
  }

  textList(value: Obj, key: string, path: string, options: { optional?: boolean } = {}): string[] {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      if (!options.optional) this.fail(`${path}.${key}`, 'is required');
      return [];
    }
    if (!Array.isArray(raw)) {
      this.fail(`${path}.${key}`, 'must be an array of strings');
      return [];
    }
    const out: string[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        this.fail(`${path}.${key}[${index}]`, 'must be a non-empty string');
      } else {
        out.push(entry.trim());
      }
    });
    return out;
  }

  date(value: Obj, key: string, path: string): string | null {
    const raw = this.text(value, key, path, { optional: true });
    if (raw === null) return null;
    if (!isRealIsoDate(raw)) {
      this.fail(`${path}.${key}`, `"${raw}" is not a real ISO date (YYYY-MM-DD, or a full timestamp)`);
      return null;
    }
    return raw;
  }
}

function parseDeal(raw: unknown, path: string, check: Checker): KeyDeal | null {
  if (!isObject(raw)) {
    check.fail(path, 'must be an object');
    return null;
  }
  check.fields(raw, path, ['id', 'name', 'codename', 'aliases', 'side', 'parties', 'window']);
  const id = check.text(raw, 'id', path);
  const name = check.text(raw, 'name', path);
  const codename = check.text(raw, 'codename', path, { optional: true });
  const aliases = check.textList(raw, 'aliases', path, { optional: true });

  let side: DealSide | null = null;
  if (raw.side !== undefined && raw.side !== null) {
    if (raw.side === 'sell' || raw.side === 'buy' || raw.side === 'other') side = raw.side;
    else check.fail(`${path}.side`, 'must be one of sell, buy, other');
  }

  const parties: KeyParty[] = [];
  if (raw.parties !== undefined && raw.parties !== null) {
    if (!Array.isArray(raw.parties)) {
      check.fail(`${path}.parties`, 'must be an array');
    } else {
      raw.parties.forEach((party, index) => {
        const partyPath = `${path}.parties[${index}]`;
        if (!isObject(party)) {
          check.fail(partyPath, 'must be an object');
          return;
        }
        check.fields(party, partyPath, ['name', 'domains', 'role']);
        const partyName = check.text(party, 'name', partyPath);
        const domains = check.textList(party, 'domains', partyPath, { optional: true }).map((d) => d.toLowerCase());
        domains.forEach((domain, d) => {
          if (!DOMAIN.test(domain)) check.fail(`${partyPath}.domains[${d}]`, `"${domain}" is not a mail domain`);
        });
        const role = check.text(party, 'role', partyPath, { optional: true });
        if (partyName) parties.push({ name: partyName, domains, role });
      });
    }
  }

  const window = { start: null as string | null, end: null as string | null };
  if (raw.window !== undefined && raw.window !== null) {
    const windowPath = `${path}.window`;
    if (!isObject(raw.window)) {
      check.fail(windowPath, 'must be an object with start and end');
    } else {
      check.fields(raw.window, windowPath, ['start', 'end']);
      window.start = check.date(raw.window, 'start', windowPath);
      window.end = check.date(raw.window, 'end', windowPath);
      if (window.start && window.end && Date.parse(window.start) > Date.parse(window.end)) {
        check.fail(windowPath, 'start is after end');
      }
    }
  }

  if (!id || !name) return null;
  return { id, name, codename, aliases, side, parties, window };
}

function parseItem(raw: unknown, path: string, check: Checker): KeyItem | null {
  if (!isObject(raw)) {
    check.fail(path, 'must be an object');
    return null;
  }
  const dealIds = check.textList(raw, 'dealIds', path);
  if (new Set(dealIds).size !== dealIds.length) check.fail(`${path}.dealIds`, 'lists a deal twice');

  if (raw.kind === 'message') {
    check.fields(raw, path, ['kind', 'internetMessageId', 'dealIds', 'attachmentOnly']);
    const id = check.text(raw, 'internetMessageId', path);
    let attachmentOnly = false;
    if (raw.attachmentOnly !== undefined) {
      if (typeof raw.attachmentOnly === 'boolean') attachmentOnly = raw.attachmentOnly;
      else check.fail(`${path}.attachmentOnly`, 'must be true or false');
    }
    if (attachmentOnly && dealIds.length === 0) {
      check.fail(`${path}.attachmentOnly`, 'is set on an item that belongs to no deal');
    }
    if (id && /\s/.test(id)) check.fail(`${path}.internetMessageId`, 'contains whitespace');
    // A Graph REST id (AAMkAD...) is not a Message-ID; it would never match (review item 4).
    if (id && !id.includes('@')) {
      check.fail(`${path}.internetMessageId`, 'has no "@": an Internet Message-ID is required, not a Graph message id');
    }
    return id ? { kind: 'message', internetMessageId: id, dealIds, attachmentOnly } : null;
  }
  if (raw.kind === 'document') {
    check.fields(raw, path, ['kind', 'path', 'driveItemId', 'dealIds']);
    const docPath = check.text(raw, 'path', path);
    const driveItemId = check.text(raw, 'driveItemId', path, { optional: true });
    return docPath ? { kind: 'document', path: docPath, driveItemId, dealIds } : null;
  }
  check.fail(`${path}.kind`, 'must be "message" or "document"');
  return null;
}

/** Validates a parsed JSON value as an answer key. Every problem is reported, with its path. */
export function parseAnswerKey(raw: unknown): ParseResult {
  const check = new Checker();
  if (!isObject(raw)) return { ok: false, errors: ['The answer key must be a JSON object.'] };
  check.fields(raw, '$', ['format', 'itemCoverage', 'deals', 'items']);

  if (raw.format !== ANSWER_KEY_FORMAT) {
    check.fail('$.format', `must be "${ANSWER_KEY_FORMAT}" (found ${JSON.stringify(raw.format ?? null)})`);
  }
  let itemCoverage: ItemCoverage = 'complete';
  if (raw.itemCoverage === 'complete' || raw.itemCoverage === 'partial') itemCoverage = raw.itemCoverage;
  else check.fail('$.itemCoverage', 'must be "complete" or "partial"');

  const deals: KeyDeal[] = [];
  if (!Array.isArray(raw.deals) || raw.deals.length === 0) {
    check.fail('$.deals', 'must be a non-empty array');
  } else {
    raw.deals.forEach((entry, index) => {
      const deal = parseDeal(entry, `$.deals[${index}]`, check);
      if (deal) deals.push(deal);
    });
  }
  const dealIds = new Set<string>();
  for (const deal of deals) {
    if (dealIds.has(deal.id)) check.fail('$.deals', `deal id "${deal.id}" appears twice`);
    dealIds.add(deal.id);
  }

  const items: KeyItem[] = [];
  if (!Array.isArray(raw.items)) {
    check.fail('$.items', 'must be an array (it may be empty)');
  } else {
    const seen = new Map<string, number>();
    raw.items.forEach((entry, index) => {
      const path = `$.items[${index}]`;
      const item = parseItem(entry, path, check);
      if (!item) return;
      for (const dealId of item.dealIds) {
        if (!dealIds.has(dealId)) check.fail(`${path}.dealIds`, `names deal "${dealId}", which is not in $.deals`);
      }
      const identity =
        item.kind === 'message'
          ? `message:${normalizeMessageId(item.internetMessageId)}`
          : `document:${normalizeDocumentPath(item.path)}`;
      const first = seen.get(identity);
      if (first !== undefined) check.fail(path, `is the same item as $.items[${first}]`);
      else seen.set(identity, index);
      items.push(item);
    });
  }

  if (check.errors.length > 0) return { ok: false, errors: check.errors };
  return { ok: true, key: { format: ANSWER_KEY_FORMAT, itemCoverage, deals, items } };
}

// ── Where the key may live ───────────────────────────────────────────────────

export const PACKAGE_NAME = '@conductia/eval-deal-discovery';

export class AnswerKeyError extends Error {}

function packageDir(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === PACKAGE_NAME) return dir;
    } catch {
      // No package.json here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new AnswerKeyError(`Cannot find the ${PACKAGE_NAME} package directory.`);
    dir = parent;
  }
}

/**
 * This checkout's root: two levels above this package's own directory
 * (<repo>/evals/deal-discovery), found by walking up to its package.json, so
 * it holds from the sources and from the compiled dist/ alike. Its evals/out
 * is where a redacted scorecard may go.
 */
export function defaultRepoRoot(): string {
  return resolve(packageDir(), '..', '..');
}

/**
 * The roots git knows `from` belongs to (review item 8): the working tree it
 * sits in, and the main checkout, the parent of `git rev-parse
 * --git-common-dir`. In a linked worktree those differ, and a key inside the
 * main checkout is still inside the repository. Fails closed: without git,
 * the harness does not guess.
 */
export function gitRepoRoots(from: string): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['-C', from, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new AnswerKeyError(
      'git rev-parse failed, so the repository root is unknown. Run the harness from a git checkout of the repository.',
    );
  }
  const [topLevel, commonDir] = output.trim().split('\n');
  if (!topLevel || !commonDir) throw new AnswerKeyError('git rev-parse returned no repository root.');
  // <main>/.git in a normal checkout or a linked worktree; a bare repository is its own root.
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  return [topLevel, mainRoot];
}

/** A root list, first entry first, each resolved through symlinks and listed once. */
export function realRoots(repoRoot: string | readonly string[]): string[] {
  const roots = typeof repoRoot === 'string' ? [repoRoot] : [...repoRoot];
  if (roots.length === 0) throw new AnswerKeyError('No repository root to check against.');
  return [...new Set(roots.map((r) => realpathSync.native(r)))];
}

/**
 * Every root the key must stay out of: this checkout (first), and each root
 * git reports for it.
 */
export function defaultRepoRoots(): string[] {
  return realRoots([defaultRepoRoot(), ...gitRepoRoots(packageDir())]);
}

/** True when `path` is `root` or anything below it. Both must already be real paths. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when `path` is inside any of the roots. */
export function isInsideAny(roots: readonly string[], path: string): boolean {
  return roots.some((root) => isInside(root, path));
}

/**
 * Resolves the key's location from EVAL_ANSWER_KEY_PATH and refuses any path
 * inside the repository, symlinks resolved on both sides, so neither a
 * relative path, a `..` segment nor a link from outside can point the
 * harness at a file in the working copy or in the main checkout.
 */
export function resolveAnswerKeyPath(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string | readonly string[] = defaultRepoRoots(),
): string {
  const raw = env[ANSWER_KEY_ENV]?.trim();
  if (!raw) {
    throw new AnswerKeyError(`${ANSWER_KEY_ENV} is not set. Point it at the answer key, stored outside the repository.`);
  }
  let keyPath: string;
  try {
    keyPath = realpathSync.native(resolve(raw));
  } catch {
    throw new AnswerKeyError(`${ANSWER_KEY_ENV} names a file that does not exist or cannot be read.`);
  }
  if (isInsideAny(realRoots(repoRoot), keyPath)) {
    throw new AnswerKeyError(
      `${ANSWER_KEY_ENV} points inside the repository. The answer key must stay outside it, so it never enters the development loop.`,
    );
  }
  return keyPath;
}

/** Reads and validates the answer key named by EVAL_ANSWER_KEY_PATH. */
export function loadAnswerKey(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string | readonly string[] = defaultRepoRoots(),
): AnswerKey {
  const path = resolveAnswerKeyPath(env, repoRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is not valid JSON' : 'cannot be read';
    throw new AnswerKeyError(`The answer key ${reason}.`);
  }
  const result = parseAnswerKey(parsed);
  if (!result.ok) {
    const shown = result.errors.slice(0, 50);
    const more = result.errors.length > shown.length ? `\n  ... and ${result.errors.length - shown.length} more` : '';
    throw new AnswerKeyError(`The answer key is not valid:\n  ${shown.join('\n  ')}${more}`);
  }
  return result.key;
}
