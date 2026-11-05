import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GMAIL_DEMO_TWIN_DIR } from '../discovery/lib/corpusSelect';
import { SEED_USERS } from '../seed-data';

/**
 * The #173 gap list's redaction denylist (design R7), rebuilt from the committed demo Gmail twin on every run so the
 * check is repeatable rather than hand-made. Proposed: the outline adds this file so the R7 check is not rebuilt by hand.
 *
 *   node --import tsx scripts/rehearsal/denylist.ts [--out <file>]
 *   grep -nFi -f ~/.pr-review/scratch/cdt-173/denylist.txt gap-list.md      # must print nothing
 *
 * Terms: every subject (and its base without RE:/FW:), every display name, every message body's first line, every
 * address as its `local@` part, every address domain (bank.example among them), and the seeded people's names. The
 * fixture codenames (Project Kestrel, Project Osprey) are allowed in the gap list and never become a term. Local
 * parts are written as `local@`, so the team inbox's `deals@` does not match the word "deals".
 *
 * The file is written outside the repository (0600) and never committed; it is refused inside the working tree.
 * Only the term count is printed, never a term.
 */

export const DEFAULT_DENYLIST = path.join(os.homedir(), '.pr-review', 'scratch', 'cdt-173', 'denylist.txt');

/** Allowed in the gap list (R7): the fixture codenames. */
const ALLOWED = new Set(['project kestrel', 'project osprey', 'kestrel', 'osprey']);
/** What the journey types into the Promote dialog (e2e/journeys/team-inbox-demo.spec.ts): a person and the target company. */
const JOURNEY_INPUTS = ['Avery Lindqvist', 'Northwind Robotics'];
const ADDRESS_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'sender', 'delivered-to']);
/** A term shorter than this would match ordinary words. */
const MIN_TERM = 4;

type Add = (term: string) => void;

/** `"Name" <local@domain>, other@domain` → names, `local@` parts and domains. */
function addAddresses(value: string, add: Add): void {
  for (const part of value.split(',')) {
    const address = /<([^>]+)>/.exec(part)?.[1] ?? part.trim();
    const name = part.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
    if (name && !name.includes('@')) add(name);
    const at = address.lastIndexOf('@');
    if (at > 0) {
      add(`${address.slice(0, at)}@`);
      add(address.slice(at + 1));
    }
  }
}

function addSubject(value: string, add: Add): void {
  add(value);
  add(value.replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, ''));
}

function addHeader(name: string, value: string, add: Add): void {
  const key = name.toLowerCase();
  if (key === 'subject') addSubject(value, add);
  else if (ADDRESS_HEADERS.has(key)) addAddresses(value, add);
}

const decodeQuotedPrintable = (text: string) =>
  text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A raw RFC 822 message (the twin's format=raw answers): its subject and address headers, and its body's first line. */
function addRawMessage(raw: string, add: Add): void {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  let body = split ? text.slice(split.index + split[0].length) : '';
  const headers = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of headers) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) addHeader(match[1], match[2], add);
  }
  if (headers.some((h) => /^content-transfer-encoding:\s*quoted-printable/i.test(h))) body = decodeQuotedPrintable(body);
  if (headers.some((h) => /^content-type:\s*text\/html/i.test(h))) {
    body = body.replace(/<[^>]+>/g, '\n').replace(/&(\w+);/g, (m, name: string) => ENTITIES[name] ?? m);
  }
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= MIN_TERM);
  if (first) add(first);
}

/** Every header array and raw message in one replay answer, wherever the Gmail shape nests it. */
function walk(node: unknown, add: Add): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, add);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.raw === 'string') addRawMessage(record.raw, add);
  if (Array.isArray(record.headers)) {
    for (const h of record.headers as Array<{ name?: unknown; value?: unknown }>) {
      if (typeof h.name === 'string' && typeof h.value === 'string') addHeader(h.name, h.value, add);
    }
  }
  for (const [key, value] of Object.entries(record)) if (key !== 'raw' && key !== 'headers') walk(value, add);
}

/** The denylist terms, sorted and unique: never an allowed codename, never shorter than MIN_TERM. */
export function denylistTerms(twinDir: string = GMAIL_DEMO_TWIN_DIR): string[] {
  const terms = new Set<string>();
  const add: Add = (term) => {
    const t = term.trim();
    if (t.length >= MIN_TERM && !ALLOWED.has(t.toLowerCase())) terms.add(t);
  };
  for (const file of fs.readdirSync(twinDir).filter((f) => f.endsWith('.replay.json')).sort()) {
    const replay = JSON.parse(fs.readFileSync(path.join(twinDir, file), 'utf8')) as { mailbox?: unknown; phases?: unknown };
    if (typeof replay.mailbox === 'string') addAddresses(replay.mailbox, add);
    walk(replay.phases, add);
  }
  for (const user of SEED_USERS) {
    for (const name of [user.fullName, user.displayName]) if (name.includes(' ')) add(name);
  }
  for (const input of JOURNEY_INPUTS) add(input);
  return [...terms].sort((a, b) => a.localeCompare(b));
}

/** The one refusal whose message is printed: it names no term. */
export class DenylistRefusal extends Error {}

/**
 * Writes the denylist outside `repoRoot` and returns how many terms it holds. Both sides are compared as real paths,
 * so a symlinked parent cannot lead the file into the working tree, and a target that is itself a symlink is refused.
 * The file is 0600 even when it existed with a wider mode.
 */
export function writeDenylist(out: string, repoRoot: string = process.cwd()): number {
  const inside = () => new DenylistRefusal('denylist: refuses to write inside the working tree (the denylist is never committed)');
  const root = fs.realpathSync(path.resolve(repoRoot));
  const wanted = path.resolve(out);
  if (wanted === root || wanted.startsWith(`${root}${path.sep}`)) throw inside();
  fs.mkdirSync(path.dirname(wanted), { recursive: true, mode: 0o700 });
  const target = path.join(fs.realpathSync(path.dirname(wanted)), path.basename(wanted));
  if (target === root || target.startsWith(`${root}${path.sep}`)) throw inside();
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new DenylistRefusal('denylist: refuses a target that is a symlink');
  }
  const terms = denylistTerms(path.join(root, GMAIL_DEMO_TWIN_DIR));
  fs.writeFileSync(target, `${terms.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return terms.length;
}

if (process.argv[1]?.endsWith('denylist.ts')) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  const out = at === -1 ? DEFAULT_DENYLIST : argv[at + 1];
  if (!out) {
    console.error('usage: denylist.ts [--out <file outside the repo>]');
    process.exitCode = 2;
  } else {
    try {
      console.log(`Wrote ${writeDenylist(out)} terms to ${path.resolve(out)}.`);
    } catch (error) {
      // A parse error can quote fixture text, so anything but the refusal prints a fixed line.
      console.error(error instanceof DenylistRefusal ? error.message : 'denylist: failed to read the demo twin');
      process.exitCode = 1;
    }
  }
}
