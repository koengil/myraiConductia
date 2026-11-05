// Converts the synthetic tenant's ground truth (ground-truth.json, written by
// the seeder outside the repo) into an answer key (answerKey.ts, format v1).
//
//   npm --prefix evals/deal-discovery run convert -- --ground-truth <file> --describe
//     prints the file's structure: keys, value types and array lengths, never
//     a value. Use it to check the input shape below against the real file.
//
//   npm --prefix evals/deal-discovery run convert -- --ground-truth <file> --out <file>
//     --coverage complete|partial [--message-ids <file>]
//     writes the key (mode 0600) and prints counts only. --coverage has no
//     default: whether the ground truth lists every deal item is a fact about
//     the file that only its owner knows.
//
// The key must never enter the repo, so both files are refused inside it
// (symlinks resolved), including evals/out, and an existing --out is never
// overwritten. The key is validated with parseAnswerKey before anything is
// written: an invalid conversion writes nothing.
//
// Input shape. The real file has not been seen from this repo, so the reader
// accepts the common spellings of each field and fails with the keys it found
// (never the values) when the shape differs. It fails closed (review item 4):
//   - a field present under two of its spellings (id and dealId, say) is an
//     error, not a silent choice;
//   - on an item, a key that names a deal but is not a spelling below
//     (deal_id, deals, dealID) is an error, and so is a deal reference that is
//     not a string or a list of strings (a numeric dealId). Otherwise the item
//     would silently become a negative;
//   - a Message-ID with no "@" is an error: it is a Graph REST id, which the
//     tenant's Internet Message-ID header never equals;
//   - a field or array it does not read (deals[].emails, threads, a top-level
//     emails list, a window's from/to) is an error, never dropped (second
//     review). So is a value of the wrong type, null included: dealId: null,
//     window: "2026-01", attachmentOnly: "true". Map such a file explicitly,
//     from its --describe output, rather than let a field vanish.
// A top-level item with no deal reference at all belongs to no deal (a
// negative label); the converter prints how many there are. A message or file
// listed both with a deal and without one keeps its deal, is not counted as a
// negative, and is reported in a warning.
//
//   {
//     "deals": [{
//       "id" | "dealId": "T01",
//       "name" | "title": "...",
//       "codename" | "codeName"?, "aliases"?: ["..."], "side"?: "sell" | "buy" | "other",
//       "parties"?: ["Heliotrope Inc", ...] | [{ "name", "domain": "..." | "domains": [...], "role"? }],
//       "window"?: { "start" | "startDate"?, "end" | "endDate"? } | flat "start" / "startDate", "end" / "endDate",
//       "messages"?: [...], "files" | "documents"?: [...]      // nested: their deal is this one
//     }],
//     "messages"?: [{                                          // top level: deals named per item
//       "internetMessageId" | "messageId" | "internet_message_id"?: "<...@...>",
//       "id" | "seedId"?,                                      // looked up in --message-ids
//       "dealIds": [...] | "dealId" | "deal": "T01",           // none: an item of no deal
//       "attachmentOnly"?: true | false
//     }],
//     "files" | "documents"?: [{ "path" | "drivePath" (or, without either, "name"),
//                                "driveItemId" | "itemId"?, "dealIds" | "dealId" | "deal"? }]
//   }
//
// --message-ids (answers Q1 and Q2 whichever way they go). When the ground
// truth records no Internet Message-ID, a map from the seeder's own message id
// to the Message-ID the tenant assigned, built on the machine that can reach
// Graph (never from the sandbox): { "<seed id>": "<Message-ID>" }. A value may
// be an array when each mailbox copy got its own Message-ID; each copy then
// becomes its own key item, and the converter warns that the worker cannot
// deduplicate those copies across mailboxes.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { byCodePoint } from './compare.ts';
import { ANSWER_KEY_FORMAT, isInsideAny, parseAnswerKey, realRoots, type AnswerKey, type ItemCoverage } from './answerKey.ts';

export class ConvertError extends Error {}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Where the files may live ─────────────────────────────────────────────────

/**
 * Refuses a path inside the repo: this checkout, or any other root given (the
 * main checkout of a linked worktree). The file need not exist; its directory
 * must.
 */
export function refuseInsideRepo(path: string, repoRoot: string | readonly string[], what: string): string {
  const roots = realRoots(repoRoot);
  const lexical = (typeof repoRoot === 'string' ? [repoRoot] : [...repoRoot]).map((r) => resolve(r));
  const target = resolve(path);
  let realDir: string;
  try {
    realDir = realpathSync.native(dirname(target));
  } catch {
    throw new ConvertError(`${what}: its directory does not exist.`);
  }
  const real = resolve(realDir, basename(target));
  if (isInsideAny(roots, real) || isInsideAny(lexical, target)) {
    throw new ConvertError(`${what} points inside the repository. The answer key and its source stay outside it.`);
  }
  if (existsSync(real) && isInsideAny(roots, realpathSync.native(real))) {
    throw new ConvertError(`${what} links into the repository. The answer key and its source stay outside it.`);
  }
  return real;
}

// ── --describe: the structure, never a value ─────────────────────────────────

/** One line per key path: its type, and the length of an array. Values are never printed. */
export function describeStructure(value: unknown, path = '$', out: string[] = [], seen = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    out.push(`${path}: array (${value.length})`);
    // The union of the entries' shapes, so an optional field shows up once.
    for (const entry of value) describeStructure(entry, `${path}[]`, out, seen);
    return out;
  }
  const line = (type: string) => {
    const text = `${path}: ${type}`;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  if (isObject(value)) {
    line('object');
    for (const key of Object.keys(value).sort()) describeStructure(value[key], `${path}.${key}`, out, seen);
    return out;
  }
  line(value === null ? 'null' : typeof value);
  return out;
}

// ── Reading the ground truth ─────────────────────────────────────────────────

/** Every problem found, collected so one run reports them all. */
type Problems = string[];

/**
 * The value of a field that may be spelled several ways. Two spellings
 * present at once is an error: the converter never picks one silently. A
 * null is present, not absent: the caller's type check refuses it.
 */
function pick(obj: Obj, names: readonly string[], where: string, errors: Problems): unknown {
  const present = names.filter((name) => obj[name] !== undefined);
  if (present.length > 1) {
    errors.push(`${where}: ${present.map((n) => `"${n}"`).join(' and ')} are spellings of one field; keep one`);
  }
  return present.length === 0 ? undefined : obj[present[0]];
}

/** Which of a field's spellings is present, for error paths. */
function spelling(obj: Obj, names: readonly string[]): string {
  return names.find((name) => obj[name] !== undefined) ?? names[0];
}

/** A non-empty string, or null when the field is absent. Any other value is an error. */
function text(obj: Obj, names: readonly string[], where: string, errors: Problems): string | null {
  const value = pick(obj, names, where, errors);
  if (value === undefined) return null;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  errors.push(`${where}.${spelling(obj, names)}: must be a non-empty string`);
  return null;
}

/** An array of non-empty strings, or [] when absent. Any other value is an error. */
function textList(value: unknown, where: string, errors: Problems): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    return value.map((v: string) => v.trim());
  }
  errors.push(`${where}: must be an array of non-empty strings`);
  return [];
}

function keysOf(obj: Obj): string {
  return Object.keys(obj).sort().join(', ') || 'none';
}

const DEAL_ID = ['id', 'dealId'] as const;
const DEAL_NAME = ['name', 'title'] as const;
const CODENAME = ['codename', 'codeName'] as const;
const ITEM_DEALS = ['dealIds', 'dealId', 'deal'] as const;
const MESSAGE_ID = ['internetMessageId', 'messageId', 'internet_message_id'] as const;
const SEED_ID = ['id', 'seedId'] as const;
const FILE_PATH = ['path', 'drivePath'] as const;
const FILE_NAME = ['name'] as const;
const DRIVE_ITEM_ID = ['driveItemId', 'itemId'] as const;
const FILE_LISTS = ['files', 'documents'] as const;
const DOMAINS = ['domains', 'domain'] as const;
const WINDOW_START = ['start', 'startDate'] as const;
const WINDOW_END = ['end', 'endDate'] as const;
/** An item key that looks like a deal reference. Any not in ITEM_DEALS is refused with its own message. */
const DEAL_REFERENCE = /deal/i;

/** The fields each level of the ground truth may hold. Anything else is an error, never dropped. */
const FIELDS = {
  top: ['deals', 'messages', ...FILE_LISTS],
  deal: [...DEAL_ID, ...DEAL_NAME, ...CODENAME, 'aliases', 'side', 'parties', 'window', ...WINDOW_START, ...WINDOW_END, 'messages', ...FILE_LISTS],
  party: ['name', ...DOMAINS, 'role'],
  window: [...WINDOW_START, ...WINDOW_END],
  message: [...MESSAGE_ID, ...SEED_ID, ...ITEM_DEALS, 'attachmentOnly'],
  file: [...FILE_PATH, ...FILE_NAME, ...DRIVE_ITEM_ID, ...ITEM_DEALS],
} as const;

/** Refuses every key of `obj` not in `allowed`, by name only. */
function onlyFields(obj: Obj, allowed: readonly string[], where: string, errors: Problems, item = false): void {
  for (const key of Object.keys(obj).sort()) {
    if (allowed.includes(key)) continue;
    if (item && DEAL_REFERENCE.test(key)) {
      errors.push(`${where}: "${key}" is not a deal reference the converter reads (use one of ${ITEM_DEALS.join(', ')})`);
    } else {
      errors.push(`${where}.${key}: a field the converter does not read. Nothing is dropped silently: map it, or leave it out of the file`);
    }
  }
}

type RawItem = { raw: Obj; where: string; parentDealId: string | null };

export type ConvertInput = {
  groundTruth: unknown;
  messageIds?: unknown;
  /** Required: whether the ground truth lists every deal item in the tenant. */
  coverage: ItemCoverage;
};

export type ConvertResult = { key: AnswerKey; warnings: string[]; negatives: number };

function parties(value: unknown, where: string, errors: Problems): AnswerKey['deals'][number]['parties'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${where}.parties: expected an array`);
    return [];
  }
  return value.flatMap((party, index) => {
    const at = `${where}.parties[${index}]`;
    if (typeof party === 'string' && party.trim() !== '') return [{ name: party.trim(), domains: [], role: null }];
    if (isObject(party)) {
      onlyFields(party, FIELDS.party, at, errors);
      const name = text(party, ['name'], at, errors);
      if (!name) {
        if (party.name === undefined) errors.push(`${at}: no name (keys: ${keysOf(party)})`);
        return [];
      }
      pick(party, DOMAINS, at, errors); // both spellings at once is an error
      let domains: string[];
      if (party.domain !== undefined) {
        const domain = text(party, ['domain'], at, errors);
        domains = domain ? [domain] : [];
      } else {
        domains = textList(party.domains, `${at}.domains`, errors);
      }
      return [{ name, domains: domains.map((d) => d.toLowerCase()), role: text(party, ['role'], at, errors) }];
    }
    errors.push(`${at}: expected a non-empty name or an object`);
    return [];
  });
}

function window(deal: Obj, where: string, errors: Problems): { start: string | null; end: string | null } {
  const flat = [...WINDOW_START, ...WINDOW_END].filter((k) => deal[k] !== undefined);
  if (deal.window === undefined) {
    return { start: text(deal, WINDOW_START, where, errors), end: text(deal, WINDOW_END, where, errors) };
  }
  if (flat.length > 0) {
    errors.push(`${where}: "window" and ${flat.map((k) => `"${k}"`).join(', ')} both give its dates; keep one`);
  }
  const at = `${where}.window`;
  if (!isObject(deal.window)) {
    errors.push(`${at}: must be an object with start and end`);
    return { start: null, end: null };
  }
  onlyFields(deal.window, FIELDS.window, at, errors);
  return { start: text(deal.window, WINDOW_START, at, errors), end: text(deal.window, WINDOW_END, at, errors) };
}

/** The deals an item names: a string or a list of strings under one accepted key, nothing else. */
function dealReferences(item: RawItem, errors: Problems): string[] {
  const value = pick(item.raw, ITEM_DEALS, item.where, errors);
  let refs: string[] = [];
  if (value !== undefined) {
    const list = Array.isArray(value) ? value : [value];
    if (list.some((v) => typeof v !== 'string' || v.trim() === '')) {
      errors.push(`${item.where}: its deal reference must be a deal id or a list of deal ids (strings)`);
    } else {
      refs = [...new Set(list.map((v) => (v as string).trim()))];
    }
  }
  if (item.parentDealId === null) return refs;
  if (refs.some((r) => r !== item.parentDealId)) {
    errors.push(`${item.where}: names a deal other than the one it is listed under`);
  }
  return [item.parentDealId];
}

function checkMessageId(id: string, where: string, errors: Problems): boolean {
  if (id.includes('@')) return true;
  errors.push(`${where}: a Message-ID with no "@" is a Graph message id, not an Internet Message-ID`);
  return false;
}

function messageIdMap(raw: unknown, errors: Problems): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    errors.push('--message-ids: expected a JSON object of seed id to Message-ID');
    return out;
  }
  for (const [seedId, value] of Object.entries(raw)) {
    const where = `--message-ids entry ${JSON.stringify(seedId)}`;
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string' && v.trim() !== '')) {
      errors.push(`${where}: must be a Message-ID or a non-empty list of Message-IDs (strings)`);
      continue;
    }
    const ids = [...new Set(list.map((v: string) => v.trim()))];
    if (ids.every((id) => checkMessageId(id, where, errors))) out.set(seedId, ids);
  }
  return out;
}

/** Converts a parsed ground truth to a validated answer key. Throws with every problem found. */
export function convertGroundTruth(input: ConvertInput): ConvertResult {
  const errors: Problems = [];
  const warnings: string[] = [];
  const gt = input.groundTruth;
  if (input.coverage !== 'complete' && input.coverage !== 'partial') {
    throw new ConvertError('The coverage must be given: complete or partial.');
  }
  if (!isObject(gt)) throw new ConvertError('The ground truth must be a JSON object.');
  const rawDeals = gt.deals;
  if (!Array.isArray(rawDeals) || rawDeals.length === 0) {
    throw new ConvertError(`The ground truth has no "deals" array (top-level keys: ${keysOf(gt)}). Run --describe.`);
  }
  onlyFields(gt, FIELDS.top, '$', errors);
  const seedMap = messageIdMap(input.messageIds, errors);

  const deals: AnswerKey['deals'] = [];
  const messages: RawItem[] = [];
  const files: RawItem[] = [];
  const lists = (holder: Obj, where: string, parentDealId: string | null) => {
    const into = (list: unknown, target: RawItem[], label: string) => {
      if (list === undefined) return;
      if (!Array.isArray(list)) {
        errors.push(`${where}${label}: expected an array`);
        return;
      }
      list.forEach((raw, i) => {
        const at = `${where}${label}[${i}]`;
        if (!isObject(raw)) {
          errors.push(`${at}: expected an object`);
          return;
        }
        onlyFields(raw, target === messages ? FIELDS.message : FIELDS.file, at, errors, true);
        target.push({ raw, where: at, parentDealId });
      });
    };
    into(holder.messages, messages, 'messages');
    const fileList = pick(holder, FILE_LISTS, where === '' ? '$' : where.slice(0, -1), errors);
    into(fileList, files, spelling(holder, FILE_LISTS));
  };

  rawDeals.forEach((deal, index) => {
    const where = `deals[${index}]`;
    if (!isObject(deal)) {
      errors.push(`${where}: expected an object`);
      return;
    }
    onlyFields(deal, FIELDS.deal, where, errors);
    const id = text(deal, DEAL_ID, where, errors);
    const codename = text(deal, CODENAME, where, errors);
    const name = text(deal, DEAL_NAME, where, errors) ?? codename;
    if (!id || !name) {
      errors.push(`${where}: needs an id and a name (keys: ${keysOf(deal)})`);
      return;
    }
    const side = text(deal, ['side'], where, errors);
    if (side !== null && side !== 'sell' && side !== 'buy' && side !== 'other') {
      errors.push(`${where}.side: must be sell, buy or other`);
    }
    deals.push({
      id,
      name,
      codename,
      aliases: textList(deal.aliases, `${where}.aliases`, errors),
      side: side === 'sell' || side === 'buy' || side === 'other' ? side : null,
      parties: parties(deal.parties, where, errors),
      window: window(deal, where, errors),
    });
    lists(deal, `${where}.`, id);
  });
  lists(gt, '', null);

  // Messages: one key item per Internet Message-ID. The same message listed
  // twice (for example once per mailbox copy) is merged, its deals unioned.
  const byMessageId = new Map<string, { dealIds: Set<string>; attachmentOnly: boolean; listedWithoutDeal: boolean }>();
  let perCopy = 0;
  for (const item of messages) {
    const direct = text(item.raw, MESSAGE_ID, item.where, errors);
    let ids: string[];
    if (direct !== null) {
      if (!checkMessageId(direct, item.where, errors)) continue;
      ids = [direct];
    } else {
      if (MESSAGE_ID.some((k) => item.raw[k] !== undefined)) continue; // wrong type, already reported
      const seedId = text(item.raw, SEED_ID, item.where, errors);
      ids = seedId ? (seedMap.get(seedId) ?? []) : [];
      if (ids.length === 0) {
        errors.push(
          `${item.where}: no Internet Message-ID${seedId ? ', and --message-ids has no entry for its seed id' : ''} (keys: ${keysOf(item.raw)})`,
        );
        continue;
      }
      if (ids.length > 1) perCopy += 1;
    }
    const flag = pick(item.raw, ['attachmentOnly'], item.where, errors);
    if (flag !== undefined && typeof flag !== 'boolean') errors.push(`${item.where}.attachmentOnly: must be true or false`);
    const attachmentOnly = flag === true;
    const dealIds = dealReferences(item, errors);
    for (const id of ids) {
      const entry = byMessageId.get(id) ?? { dealIds: new Set<string>(), attachmentOnly: false, listedWithoutDeal: false };
      for (const dealId of dealIds) entry.dealIds.add(dealId);
      entry.attachmentOnly ||= attachmentOnly;
      entry.listedWithoutDeal ||= dealIds.length === 0;
      byMessageId.set(id, entry);
    }
  }
  if (perCopy > 0) {
    warnings.push(
      `${perCopy} messages have a different Message-ID in each mailbox copy. Each copy is its own key item, ` +
        'and the worker cannot deduplicate them or continue their threads across mailboxes.',
    );
  }

  const byPath = new Map<string, { driveItemId: string | null; dealIds: Set<string>; listedWithoutDeal: boolean }>();
  for (const item of files) {
    const hasPath = FILE_PATH.some((k) => item.raw[k] !== undefined);
    const path = hasPath ? text(item.raw, FILE_PATH, item.where, errors) : text(item.raw, FILE_NAME, item.where, errors);
    if (!path) {
      if (!hasPath && item.raw.name === undefined) errors.push(`${item.where}: no path (keys: ${keysOf(item.raw)})`);
      continue;
    }
    if (hasPath) text(item.raw, FILE_NAME, item.where, errors); // type-checked, not used: the path wins
    const entry = byPath.get(path) ?? { driveItemId: null, dealIds: new Set<string>(), listedWithoutDeal: false };
    const driveItemId = text(item.raw, DRIVE_ITEM_ID, item.where, errors);
    entry.driveItemId ??= driveItemId;
    const dealIds = dealReferences(item, errors);
    for (const dealId of dealIds) entry.dealIds.add(dealId);
    entry.listedWithoutDeal ||= dealIds.length === 0;
    byPath.set(path, entry);
  }
  const withoutDriveItem = [...byPath.values()].filter((f) => f.driveItemId === null).length;
  if (withoutDriveItem > 0) {
    warnings.push(
      `${withoutDriveItem} documents have no driveItemId: a skipped or unrouted one will be reported as "not placed".`,
    );
  }
  const entries = [...byMessageId.values(), ...byPath.values()];
  // Counted on the merged items, so an item that also has a deal is not a negative.
  const negatives = entries.filter((e) => e.dealIds.size === 0).length;
  const both = entries.filter((e) => e.listedWithoutDeal && e.dealIds.size > 0).length;
  if (both > 0) {
    warnings.push(
      `${both} items are listed both with a deal and without one. Each keeps its deal and is not counted as a negative.`,
    );
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, 50);
    const more = errors.length > shown.length ? `\n  ... and ${errors.length - shown.length} more` : '';
    throw new ConvertError(`The ground truth could not be converted:\n  ${shown.join('\n  ')}${more}`);
  }

  const raw = {
    format: ANSWER_KEY_FORMAT,
    itemCoverage: input.coverage,
    deals: deals.map((d) => ({
      id: d.id,
      name: d.name,
      ...(d.codename ? { codename: d.codename } : {}),
      ...(d.aliases.length ? { aliases: d.aliases } : {}),
      ...(d.side ? { side: d.side } : {}),
      ...(d.parties.length
        ? { parties: d.parties.map((p) => ({ name: p.name, ...(p.domains.length ? { domains: p.domains } : {}), ...(p.role ? { role: p.role } : {}) })) }
        : {}),
      ...(d.window.start || d.window.end
        ? { window: { ...(d.window.start ? { start: d.window.start } : {}), ...(d.window.end ? { end: d.window.end } : {}) } }
        : {}),
    })),
    items: [
      ...[...byMessageId].map(([internetMessageId, m]) => ({
        kind: 'message',
        internetMessageId,
        dealIds: [...m.dealIds].sort(byCodePoint),
        ...(m.attachmentOnly ? { attachmentOnly: true } : {}),
      })),
      ...[...byPath].map(([path, f]) => ({
        kind: 'document',
        path,
        ...(f.driveItemId ? { driveItemId: f.driveItemId } : {}),
        dealIds: [...f.dealIds].sort(byCodePoint),
      })),
    ],
  };
  const parsed = parseAnswerKey(raw);
  if (!parsed.ok) {
    throw new ConvertError(`The converted key is not valid:\n  ${parsed.errors.slice(0, 50).join('\n  ')}`);
  }
  return { key: parsed.key, warnings, negatives };
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConvertError(`${what} ${error instanceof SyntaxError ? 'is not valid JSON' : 'cannot be read'}.`);
  }
}

export type ConvertArgs = {
  groundTruth: string;
  out: string | null;
  messageIds: string | null;
  coverage: ItemCoverage | null;
  describe: boolean;
};

export function parseConvertArgs(argv: string[]): ConvertArgs {
  const args: ConvertArgs = { groundTruth: '', out: null, messageIds: null, coverage: null, describe: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--describe') {
      args.describe = true;
      continue;
    }
    const value = argv[i + 1];
    if (!['--ground-truth', '--out', '--message-ids', '--coverage'].includes(flag)) {
      throw new ConvertError(`unknown argument ${flag}`);
    }
    if (!value || value.startsWith('--')) throw new ConvertError(`${flag} needs a value`);
    if (flag === '--ground-truth') args.groundTruth = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--message-ids') args.messageIds = value;
    else if (value === 'complete' || value === 'partial') args.coverage = value;
    else throw new ConvertError('--coverage takes complete or partial');
    i += 1;
  }
  if (!args.groundTruth) throw new ConvertError('--ground-truth <file> is required');
  if (!args.describe && !args.out) throw new ConvertError('--out <file> is required (or --describe)');
  if (!args.describe && args.coverage === null) {
    throw new ConvertError(
      '--coverage complete|partial is required: complete only if the ground truth lists every deal item in the tenant',
    );
  }
  return args;
}

/** Runs the command; returns the lines to print (structure or counts, never a value). */
export function runConvert(argv: string[], repoRoot: string | readonly string[]): string[] {
  const args = parseConvertArgs(argv);
  const groundTruthPath = refuseInsideRepo(args.groundTruth, repoRoot, '--ground-truth');
  const groundTruth = readJson(groundTruthPath, 'The ground truth');
  if (args.describe) return describeStructure(groundTruth);

  const outPath = refuseInsideRepo(args.out!, repoRoot, '--out');
  if (existsSync(outPath)) throw new ConvertError('--out already exists. The converter never overwrites a key.');
  const messageIds = args.messageIds
    ? readJson(refuseInsideRepo(args.messageIds, repoRoot, '--message-ids'), 'The --message-ids map')
    : undefined;

  const { key, warnings, negatives } = convertGroundTruth({ groundTruth, messageIds, coverage: args.coverage! });
  writeFileSync(outPath, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const messages = key.items.filter((i) => i.kind === 'message').length;
  return [
    `Wrote the answer key: ${key.deals.length} deals; ${messages} messages and ${key.items.length - messages} documents; coverage ${key.itemCoverage}.`,
    `${negatives} listed items carry no deal reference and are labeled as belonging to no deal.`,
    ...warnings.map((w) => `Warning: ${w}`),
    `Next: EVAL_ANSWER_KEY_PATH=<that file> npm --prefix evals/deal-discovery run check-key`,
  ];
}
