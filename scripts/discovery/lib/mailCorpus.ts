// conductia.mail-corpus/v1: the one hand-written source of the deal-discovery
// demo mail. Its messages are conductia.gmail-seed/v1 records verbatim
// (scripts/google/lib/seedFormat.ts), so the Gmail seeder reads them as they
// are. parseCorpus is stricter than parseSeedJsonl: demo personas only, no
// labels, and every reference in "<id@domain>" form.

import { readFileSync } from 'node:fs';

import type { SeedMessage } from '../../google/lib/seedFormat';

export type { SeedAddress, SeedMessage } from '../../google/lib/seedFormat';
export type MailCorpusV1 = { format: 'conductia.mail-corpus/v1'; messages: SeedMessage[] };

export const DEMO_PERSONAS = {
  'storm.duncan@bank.example': 'storm',
  'morgan.vale@bank.example': 'morgan',
  'alex.chen@bank.example': 'alex',
} as const;

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

function fail(where: string, what: string): never {
  throw new Error(`mail corpus: ${where}: ${what}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkAddress(where: string, value: unknown): void {
  if (!isObject(value)) fail(where, 'expected an address object');
  if (typeof value.address !== 'string' || !value.address.includes('@')) fail(where, 'address must be an email address');
  if (value.name !== undefined && typeof value.name !== 'string') fail(where, 'name must be a string');
}

function checkAddresses(where: string, value: unknown): void {
  if (!Array.isArray(value)) fail(where, 'expected an array of addresses');
  value.forEach((a, i) => checkAddress(`${where}[${i}]`, a));
}

function checkMessage(index: number, value: unknown): void {
  const at = `messages[${index}]`;
  if (!isObject(value)) fail(at, 'expected an object');
  const where = (field: string) => `${at}.${field}`;
  if (typeof value.messageId !== 'string' || !MESSAGE_ID.test(value.messageId)) fail(where('messageId'), 'expected "<id@domain>"');
  if (typeof value.date !== 'string' || Number.isNaN(Date.parse(value.date))) fail(where('date'), 'expected a parseable date');
  checkAddress(where('from'), value.from);
  checkAddresses(where('to'), value.to);
  checkAddresses(where('cc'), value.cc);
  if (typeof value.subject !== 'string' || value.subject.length === 0) fail(where('subject'), 'expected a subject');
  if (value.inReplyTo !== undefined && (typeof value.inReplyTo !== 'string' || !MESSAGE_ID.test(value.inReplyTo))) {
    fail(where('inReplyTo'), 'expected "<id@domain>"');
  }
  if (
    value.references !== undefined &&
    (!Array.isArray(value.references) || !value.references.every((r) => typeof r === 'string' && MESSAGE_ID.test(r)))
  ) {
    fail(where('references'), 'expected an array of "<id@domain>"');
  }
  if (!isObject(value.body)) fail(where('body'), 'expected { contentType, content }');
  if (value.body.contentType !== 'html' && value.body.contentType !== 'text') fail(where('body.contentType'), 'expected html or text');
  if (typeof value.body.content !== 'string') fail(where('body.content'), 'expected a string');
  if (!Array.isArray(value.mailboxes) || value.mailboxes.length === 0 || !value.mailboxes.every((m) => typeof m === 'string')) {
    fail(where('mailboxes'), 'expected a non-empty array of persona addresses');
  }
  if (value.mailboxes.some((m) => !(m in DEMO_PERSONAS))) fail(where('mailboxes'), 'every mailbox must be a demo persona address');
  if (value.labels !== undefined && (!Array.isArray(value.labels) || !value.labels.every((l) => l === 'SPAM'))) {
    fail(where('labels'), 'expected an array of SPAM');
  }
  if (value.phase !== undefined && value.phase !== 'seeded' && value.phase !== 'after-imports') {
    fail(where('phase'), 'expected seeded or after-imports');
  }
}

/** Parses a corpus file and throws on the first bad field. */
export function parseCorpus(text: string): MailCorpusV1 {
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || value.format !== 'conductia.mail-corpus/v1') fail('root', 'expected format "conductia.mail-corpus/v1"');
  if (!Array.isArray(value.messages)) fail('root', 'expected messages');
  value.messages.forEach((m, i) => checkMessage(i, m));
  return value as unknown as MailCorpusV1;
}

export function readCorpus(path: string): MailCorpusV1 {
  return parseCorpus(readFileSync(path, 'utf8'));
}
