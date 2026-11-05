// The recall corpus format, conductia.recall-corpus/v1 (#173 G-09).
//
// A corpus is three JSON files that share a name: <name>.messages.json, <name>.labels.json and
// <name>.world.json. Labels and world never sit inside a message, so the router sees only what a mailbox
// holds. The in-repo corpus (corpus.ts) emits the same three objects the loader returns, so both go through
// one code path. parseRecallCorpus fails closed: an unknown field, a missing label, a label for a message
// that is not there, or a reference to a source or deal the world does not define is refused. Errors name the
// path and the field, never a value, because a corpus is mail.

import type { MailMessage, MailRecipient } from '@/lib/discovery/source/types';

export const RECALL_FORMAT = 'conductia.recall-corpus/v1' as const;

/** Messages per page in the harness's page10 stress shape (harness.ts); the reader-shaped modes use the readers' own pages. */
export const RECALL_PAGE_SIZE = 10;

/** The marker forms, in report order. */
export const RECALL_FORMS = [
  'project_codename',
  'thread_reply',
  'thread_cross_source',
  'subject_prefix',
  'subject_prefix_thin',
  'alias_same_source',
  'alias_cross_source',
  'alias_mixed_copy_leak',
  'alias_mixed_copy_personal_cost',
  'alias_mixed_copy_shared_cost',
  'real_name',
  'real_name_unentitled',
  'real_name_unapproved',
  'real_name_document',
  'no_marker',
  'noise',
  'noise_collision',
  'noise_client_mention',
  'noise_client_coverage_term',
] as const;
export type RecallForm = (typeof RECALL_FORMS)[number];

/** One message as a mailbox holds it (Graph shape), read in every listed source. */
export type RecallMail = MailMessage & { sources: string[] };
export type RecallDocument = {
  kind: 'document';
  id: string;
  name: string;
  text: string;
  author: string;
  sources: string[];
};
export type RecallMessage = RecallMail | RecallDocument;

export type RecallLabel = { deal: string | null; form: RecallForm; variant?: string };

export type RecallSource = {
  id: string;
  address: string;
  kind: 'personal' | 'team';
  ownerPersonId?: string;
  readerPersonIds?: string[];
  /** The source the headline table counts (the team inbox). Exactly one. */
  headline?: true;
};
export type RecallPerson = { id: string; address: string; companyId: string; leadsView: boolean; searchCompanies: boolean };
export type RecallCompany = {
  id: string;
  name: string;
  type: 'bank' | 'client' | 'target' | 'acquirer';
  registeredByCompanyId: string;
};
export type RecallWorld = {
  firm: { companyId: string; domain: string; approvals: Array<'firm_name_alias'> };
  sources: RecallSource[];
  people: RecallPerson[];
  companies: RecallCompany[];
  /** Accepted route keys per deal: 'aster' or 'firm:fenwick-foods'. */
  deals: Record<string, { keys: string[] }>;
};

export type RecallMessagesV1 = { format: typeof RECALL_FORMAT; messages: RecallMessage[] };
export type RecallLabelsV1 = { format: typeof RECALL_FORMAT; labels: Record<string, RecallLabel> };
export type RecallWorldV1 = { format: typeof RECALL_FORMAT } & RecallWorld;

/** The three files, as JSON values. */
export type RecallCorpusFiles = { messages: RecallMessagesV1; labels: RecallLabelsV1; world: RecallWorldV1 };

/** A parsed corpus: the three files without their format tags. */
export type RecallCorpus = { messages: RecallMessage[]; labels: Record<string, RecallLabel>; world: RecallWorld };

export function isRecallDocument(message: RecallMessage): message is RecallDocument {
  return 'kind' in message && message.kind === 'document';
}

/** A message's key in labels.json: its Internet message id, or a document's id. */
export function corpusIdOf(message: RecallMessage): string {
  return isRecallDocument(message) ? message.id : message.internetMessageId;
}

export class RecallFormatError extends Error {
  constructor(path: string, why: string) {
    super(`recall corpus: ${path}: ${why}`);
    this.name = 'RecallFormatError';
  }
}

const refuse = (path: string, why: string): never => {
  throw new RecallFormatError(path, why);
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse(path, 'expected an object');
  return value as Record<string, unknown>;
}

/** The object has every required key, no key outside required and optional. */
function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const obj = record(value, path);
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) refuse(path, `unknown field "${key}"`);
  }
  for (const key of required) if (!(key in obj)) refuse(path, `missing field "${key}"`);
  return obj;
}

function str(value: unknown, path: string): string {
  return typeof value === 'string' ? value : refuse(path, 'expected a string');
}

function strOrNull(value: unknown, path: string): string | null {
  return value === null ? null : str(value, path);
}

function list(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : refuse(path, 'expected an array');
}

function strings(value: unknown, path: string): string[] {
  return list(value, path).map((entry, i) => str(entry, `${path}[${i}]`));
}

function bool(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : refuse(path, 'expected a boolean');
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = str(value, path);
  return (allowed as readonly string[]).includes(text) ? (text as T) : refuse(path, 'not an allowed value');
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) refuse(path, 'duplicate entries');
}

function recipient(value: unknown, path: string): MailRecipient {
  const obj = exact(value, path, ['emailAddress']);
  const address = exact(obj.emailAddress, `${path}.emailAddress`, ['address'], ['name']);
  return {
    emailAddress: {
      address: str(address.address, `${path}.emailAddress.address`),
      ...('name' in address ? { name: strOrNull(address.name, `${path}.emailAddress.name`) } : {}),
    },
  };
}

const MAIL_REQUIRED = [
  'id',
  'internetMessageId',
  'conversationId',
  'subject',
  'sentDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'body',
  'sources',
] as const;
const MAIL_OPTIONAL = ['providerThreadId', 'receivedDateTime', 'hasAttachments'] as const;
const DOCUMENT_REQUIRED = ['kind', 'id', 'name', 'text', 'author', 'sources'] as const;

function parseMessage(value: unknown, path: string): RecallMessage {
  const obj = record(value, path);
  if (obj.kind === 'document') {
    const doc = exact(obj, path, DOCUMENT_REQUIRED);
    return {
      kind: 'document',
      id: str(doc.id, `${path}.id`),
      name: str(doc.name, `${path}.name`),
      text: str(doc.text, `${path}.text`),
      author: str(doc.author, `${path}.author`),
      sources: strings(doc.sources, `${path}.sources`),
    };
  }
  const mail = exact(obj, path, MAIL_REQUIRED, MAIL_OPTIONAL);
  const body = exact(mail.body, `${path}.body`, ['contentType', 'content']);
  return {
    id: str(mail.id, `${path}.id`),
    ...('providerThreadId' in mail ? { providerThreadId: str(mail.providerThreadId, `${path}.providerThreadId`) } : {}),
    internetMessageId: str(mail.internetMessageId, `${path}.internetMessageId`),
    conversationId: strOrNull(mail.conversationId, `${path}.conversationId`),
    subject: strOrNull(mail.subject, `${path}.subject`),
    sentDateTime: strOrNull(mail.sentDateTime, `${path}.sentDateTime`),
    ...('receivedDateTime' in mail
      ? { receivedDateTime: strOrNull(mail.receivedDateTime, `${path}.receivedDateTime`) }
      : {}),
    from: mail.from === null ? null : recipient(mail.from, `${path}.from`),
    toRecipients: list(mail.toRecipients, `${path}.toRecipients`).map((r, i) => recipient(r, `${path}.toRecipients[${i}]`)),
    ccRecipients: list(mail.ccRecipients, `${path}.ccRecipients`).map((r, i) => recipient(r, `${path}.ccRecipients[${i}]`)),
    body: {
      contentType: oneOf(body.contentType, `${path}.body.contentType`, ['html', 'text'] as const),
      content: str(body.content, `${path}.body.content`),
    },
    ...('hasAttachments' in mail ? { hasAttachments: bool(mail.hasAttachments, `${path}.hasAttachments`) } : {}),
    sources: strings(mail.sources, `${path}.sources`),
  };
}

function parseLabel(value: unknown, path: string): RecallLabel {
  const obj = exact(value, path, ['deal', 'form'], ['variant']);
  return {
    deal: strOrNull(obj.deal, `${path}.deal`),
    form: oneOf(obj.form, `${path}.form`, RECALL_FORMS),
    ...('variant' in obj ? { variant: str(obj.variant, `${path}.variant`) } : {}),
  };
}

function parseWorld(value: unknown): RecallWorld {
  const obj = exact(value, 'world', ['format', 'firm', 'sources', 'people', 'companies', 'deals']);
  const firm = exact(obj.firm, 'world.firm', ['companyId', 'domain', 'approvals']);
  const sources = list(obj.sources, 'world.sources').map((entry, i): RecallSource => {
    const path = `world.sources[${i}]`;
    const source = exact(entry, path, ['id', 'address', 'kind'], ['ownerPersonId', 'readerPersonIds', 'headline']);
    if ('headline' in source && source.headline !== true) refuse(`${path}.headline`, 'expected true');
    return {
      id: str(source.id, `${path}.id`),
      address: str(source.address, `${path}.address`),
      kind: oneOf(source.kind, `${path}.kind`, ['personal', 'team'] as const),
      ...('ownerPersonId' in source ? { ownerPersonId: str(source.ownerPersonId, `${path}.ownerPersonId`) } : {}),
      ...('readerPersonIds' in source ? { readerPersonIds: strings(source.readerPersonIds, `${path}.readerPersonIds`) } : {}),
      ...('headline' in source ? { headline: true as const } : {}),
    };
  });
  const people = list(obj.people, 'world.people').map((entry, i): RecallPerson => {
    const path = `world.people[${i}]`;
    const person = exact(entry, path, ['id', 'address', 'companyId', 'leadsView', 'searchCompanies']);
    return {
      id: str(person.id, `${path}.id`),
      address: str(person.address, `${path}.address`),
      companyId: str(person.companyId, `${path}.companyId`),
      leadsView: bool(person.leadsView, `${path}.leadsView`),
      searchCompanies: bool(person.searchCompanies, `${path}.searchCompanies`),
    };
  });
  const companies = list(obj.companies, 'world.companies').map((entry, i): RecallCompany => {
    const path = `world.companies[${i}]`;
    const company = exact(entry, path, ['id', 'name', 'type', 'registeredByCompanyId']);
    return {
      id: str(company.id, `${path}.id`),
      name: str(company.name, `${path}.name`),
      type: oneOf(company.type, `${path}.type`, ['bank', 'client', 'target', 'acquirer'] as const),
      registeredByCompanyId: str(company.registeredByCompanyId, `${path}.registeredByCompanyId`),
    };
  });
  const deals: Record<string, { keys: string[] }> = {};
  for (const [name, entry] of Object.entries(record(obj.deals, 'world.deals'))) {
    deals[name] = { keys: strings(exact(entry, `world.deals.${name}`, ['keys']).keys, `world.deals.${name}.keys`) };
  }
  const approvals = strings(firm.approvals, 'world.firm.approvals').map((a, i) =>
    oneOf(a, `world.firm.approvals[${i}]`, ['firm_name_alias'] as const),
  );

  unique(sources.map((s) => s.id), 'world.sources');
  unique(people.map((p) => p.id), 'world.people');
  unique(companies.map((c) => c.id), 'world.companies');
  if (sources.filter((s) => s.headline).length !== 1) refuse('world.sources', 'exactly one source must be the headline');
  const personIds = new Set(people.map((p) => p.id));
  for (const source of sources) {
    for (const id of [...(source.ownerPersonId ? [source.ownerPersonId] : []), ...(source.readerPersonIds ?? [])]) {
      if (!personIds.has(id)) refuse(`world.sources.${source.id}`, 'refers to a person the world does not define');
    }
  }
  return {
    firm: { companyId: str(firm.companyId, 'world.firm.companyId'), domain: str(firm.domain, 'world.firm.domain'), approvals },
    sources,
    people,
    companies,
    deals,
  };
}

function formatTag(value: unknown, path: string): void {
  if (value !== RECALL_FORMAT) refuse(path, `format must be ${RECALL_FORMAT}`);
}

/**
 * Parses the three files of one corpus. `files` is JSON.parse output, unchecked. Fails closed (see above).
 */
export function parseRecallCorpus(files: { messages: unknown; labels: unknown; world: unknown }): RecallCorpus {
  const messagesFile = exact(files.messages, 'messages', ['format', 'messages']);
  formatTag(messagesFile.format, 'messages.format');
  const labelsFile = exact(files.labels, 'labels', ['format', 'labels']);
  formatTag(labelsFile.format, 'labels.format');
  formatTag(record(files.world, 'world').format, 'world.format');

  const world = parseWorld(files.world);
  const messages = list(messagesFile.messages, 'messages.messages').map((entry, i) =>
    parseMessage(entry, `messages.messages[${i}]`),
  );
  const labels: Record<string, RecallLabel> = {};
  for (const [id, entry] of Object.entries(record(labelsFile.labels, 'labels.labels'))) {
    labels[id] = parseLabel(entry, `labels.labels.${id}`);
  }

  const ids = messages.map(corpusIdOf);
  unique(ids, 'messages.messages');
  const sourceIds = new Set(world.sources.map((s) => s.id));
  messages.forEach((message, i) => {
    const path = `messages.messages[${i}]`;
    if (message.sources.length === 0) refuse(path, 'a message is read in at least one source');
    unique(message.sources, `${path}.sources`);
    if (message.sources.some((s) => !sourceIds.has(s))) refuse(path, 'read in a source the world does not define');
  });
  const idSet = new Set(ids);
  for (const [id, label] of Object.entries(labels)) {
    if (!idSet.has(id)) refuse(`labels.labels.${id}`, 'a label for a message that is not in the corpus');
    if (label.deal !== null && !Object.hasOwn(world.deals, label.deal)) refuse(`labels.labels.${id}`, 'a deal the world does not define');
  }
  for (const id of ids) if (!Object.hasOwn(labels, id)) refuse(`labels.labels.${id}`, 'a message without a label');

  return { messages, labels, world };
}
