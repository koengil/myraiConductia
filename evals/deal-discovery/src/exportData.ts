// Reads what `npm run discovery:export` wrote (scripts/discovery-export.ts in
// the app): one directory per export, metadata only, never text.
//
//   manifest.json      { format, tenantId, exportedAt, counts }
//   sources.jsonl      a content source: id, kind, status, ownerAssigned, sync state
//   ledger.jsonl       every item the worker read: decision, method, skip reason,
//                      and on an unrouted message its conversation and Message-ID;
//                      on an item the exclusion policy skipped (#263), the policy
//                      version, the rule id and the provider thread id
//   items.jsonl        a stored (deal-routed) item's identity and dates
//   provenance.jsonl   which source each stored item was observed in
//   candidates.jsonl   the proposed deals, with parties and date range
//   links.jsonl        item -> candidate evidence links
//
// The two sides share no code (the app never imports this package, and this
// package never imports the app), so the format is versioned: a manifest with
// another `format` is refused rather than misread. Every row is validated
// against its schema as well (second review): a missing or unknown field, a
// value of the wrong type, a value outside its enum (a candidate state of
// "archived" or "Proposed") or a reference to a row the export does not hold
// is an error. Nothing is filtered out, since a row the views silently skip
// would move the metrics. The enums mirror the app's CHECK enums
// (src/lib/constants/discovery.ts); a new value there needs a new format here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRealIsoDate } from './answerKey.ts';

export const EXPORT_FORMAT = 'conductia.discovery-export/v2';

/** The closed set each enum field takes, as the app's CHECK constraints define it. */
export const EXPORT_ENUMS = {
  sourceKind: ['mailbox', 'sharepoint_site'],
  sourceStatus: ['active', 'paused'],
  decision: ['routed', 'unrouted', 'skipped'],
  method: ['codename', 'alias', 'thread_continuation'],
  skipReason: [
    'image_only',
    'unsupported_type',
    'too_large',
    'extraction_failed',
    'extraction_timeout',
    // The exclusion policy's (#263). The first three never fetched the body; the last fetched it and discarded it.
    'policy_excluded',
    'policy_thread_excluded',
    'policy_unevaluable',
    'policy_excluded_after_fetch',
  ],
  itemKind: ['message', 'document'],
  sensitivity: ['standard', 'restricted'],
  discoveryState: ['proposed', 'confirmed', 'rejected', 'merged_into'],
  dealSide: ['sell', 'buy', 'unknown'],
  routeTier: ['firm', 'tentative'],
  linkState: ['proposed', 'confirmed', 'rejected'],
} as const;
type Enum<K extends keyof typeof EXPORT_ENUMS> = (typeof EXPORT_ENUMS)[K][number];

export type RouteMethod = Enum<'method'>;
export type SkipReason = Enum<'skipReason'>;

export type ExportSource = {
  id: string;
  kind: Enum<'sourceKind'>;
  status: Enum<'sourceStatus'>;
  ownerAssigned: boolean;
  backfillCompletedAt: string | null;
  lastSyncedAt: string | null;
};

export type ExportLedgerRow = {
  sourceId: string;
  providerItemId: string;
  decision: Enum<'decision'>;
  method: RouteMethod | null;
  confidence: number | null;
  skipReason: SkipReason | null;
  conversationId: string | null;
  internetMessageId: string | null;
  providerThreadId: string | null;
  policyVersion: number | null;
  exclusionRule: string | null;
  runId: string;
  recordedAt: string;
};

export type ExportItem = {
  id: string;
  kind: Enum<'itemKind'>;
  internetMessageId: string | null;
  conversationId: string | null;
  driveItemKey: string | null;
  drivePath: string | null;
  sentAt: string | null;
  sensitivity: Enum<'sensitivity'>;
};

export type ExportProvenance = { sourceItemId: string; sourceId: string; providerItemId: string };

export type ExportCandidate = {
  id: string;
  clusterKey: string;
  discoveryState: Enum<'discoveryState'>;
  mergedIntoId: string | null;
  promotedDealId: string | null;
  proposedName: string;
  codenameGuess: string | null;
  parties: Array<{ name: string; domain: string }>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  dealSide: Enum<'dealSide'>;
  confidence: number | null;
};

export type ExportLink = {
  id: string;
  candidateId: string | null;
  dealId: string | null;
  sourceItemId: string;
  method: RouteMethod;
  confidence: number | null;
  routeTier: Enum<'routeTier'>;
  state: Enum<'linkState'>;
};

export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  tenantId: string;
  exportedAt: string;
  counts: Record<string, number>;
};

export type DiscoveryExport = {
  manifest: ExportManifest;
  sources: ExportSource[];
  ledger: ExportLedgerRow[];
  items: ExportItem[];
  provenance: ExportProvenance[];
  candidates: ExportCandidate[];
  links: ExportLink[];
};

export const EXPORT_FILES = {
  sources: 'sources.jsonl',
  ledger: 'ledger.jsonl',
  items: 'items.jsonl',
  provenance: 'provenance.jsonl',
  candidates: 'candidates.jsonl',
  links: 'links.jsonl',
} as const;
type Table = keyof typeof EXPORT_FILES;

export class ExportError extends Error {}

// ── Row schemas ──────────────────────────────────────────────────────────────

/** 'id': a non-empty string. 'time': a real ISO timestamp. A trailing '?' allows null. */
type Field =
  | 'id'
  | 'id?'
  | 'string'
  | 'string?'
  | 'number?'
  | 'boolean'
  | 'time'
  | 'time?'
  | 'parties'
  | { enum: keyof typeof EXPORT_ENUMS; nullable?: true };

const SCHEMAS: Record<Table, Record<string, Field>> = {
  sources: {
    id: 'id',
    kind: { enum: 'sourceKind' },
    status: { enum: 'sourceStatus' },
    ownerAssigned: 'boolean',
    backfillCompletedAt: 'time?',
    lastSyncedAt: 'time?',
  },
  ledger: {
    sourceId: 'id',
    providerItemId: 'id',
    decision: { enum: 'decision' },
    method: { enum: 'method', nullable: true },
    confidence: 'number?',
    skipReason: { enum: 'skipReason', nullable: true },
    conversationId: 'id?',
    internetMessageId: 'id?',
    providerThreadId: 'id?',
    policyVersion: 'number?',
    exclusionRule: 'id?',
    runId: 'id',
    recordedAt: 'time',
  },
  items: {
    id: 'id',
    kind: { enum: 'itemKind' },
    internetMessageId: 'id?',
    conversationId: 'id?',
    driveItemKey: 'id?',
    drivePath: 'id?',
    sentAt: 'time?',
    sensitivity: { enum: 'sensitivity' },
  },
  provenance: { sourceItemId: 'id', sourceId: 'id', providerItemId: 'id' },
  candidates: {
    id: 'id',
    clusterKey: 'id',
    discoveryState: { enum: 'discoveryState' },
    mergedIntoId: 'id?',
    promotedDealId: 'id?',
    proposedName: 'string',
    codenameGuess: 'string?',
    parties: 'parties',
    firstSeenAt: 'time?',
    lastSeenAt: 'time?',
    dealSide: { enum: 'dealSide' },
    confidence: 'number?',
  },
  links: {
    id: 'id',
    candidateId: 'id?',
    dealId: 'id?',
    sourceItemId: 'id',
    method: { enum: 'method' },
    confidence: 'number?',
    routeTier: { enum: 'routeTier' },
    state: { enum: 'linkState' },
  },
};

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a value does not fit its field, or null. Never quotes the value: an export row can hold names. */
function misfit(value: unknown, field: Field): string | null {
  if (typeof field === 'object') {
    if (value === null && field.nullable) return null;
    const allowed: readonly string[] = EXPORT_ENUMS[field.enum];
    return typeof value === 'string' && allowed.includes(value)
      ? null
      : `must be one of ${allowed.join(', ')}${field.nullable ? ', or null' : ''}`;
  }
  const nullable = field.endsWith('?');
  if (value === null && nullable) return null;
  const or = nullable ? ', or null' : '';
  switch (field.replace('?', '')) {
    case 'id':
      return typeof value === 'string' && value.trim() !== '' ? null : `must be a non-empty string${or}`;
    case 'string':
      return typeof value === 'string' ? null : `must be a string${or}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `must be a number${or}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'time':
      return typeof value === 'string' && isRealIsoDate(value) ? null : `must be an ISO timestamp${or}`;
    default: // parties
      return Array.isArray(value) &&
        value.every(
          (p) =>
            isObject(p) &&
            Object.keys(p).sort().join(',') === 'domain,name' &&
            typeof p.name === 'string' &&
            typeof p.domain === 'string',
        )
        ? null
        : 'must be an array of { name, domain } strings';
  }
}

/** The constraints between one row's fields, as the app's CHECKs state them. */
function rowRules(table: Table, row: Obj): string[] {
  const out: string[] = [];
  if (table === 'ledger') {
    if ((row.decision === 'routed') !== (row.method !== null)) out.push('method is set exactly when decision is routed');
    if ((row.decision === 'skipped') !== (row.skipReason !== null)) out.push('skipReason is set exactly when decision is skipped');
    // The ledger's routing_ledger_policy_shape_check: a policy reason carries its version, rule and thread id, and
    // only a policy reason carries all three.
    const policy = typeof row.skipReason === 'string' && row.skipReason.startsWith('policy_');
    const shaped = row.policyVersion !== null && row.exclusionRule !== null && row.providerThreadId !== null;
    if (policy !== shaped) out.push('policyVersion, exclusionRule and providerThreadId are all set exactly when skipReason is a policy reason');
  }
  if (table === 'candidates' && (row.discoveryState === 'merged_into') !== (row.mergedIntoId !== null)) {
    out.push('mergedIntoId is set exactly when discoveryState is merged_into');
  }
  if (table === 'links' && (row.candidateId === null) === (row.dealId === null)) {
    out.push('exactly one of candidateId and dealId is set');
  }
  return out;
}

const MAX_ERRORS = 50;

/**
 * Validates every row of an export, and the references between them. Throws
 * one ExportError listing every problem (up to 50), each with its file and
 * line; never a value. score() calls it too, so no caller can skip it.
 */
export function validateRows(data: Omit<DiscoveryExport, 'manifest'>): void {
  const errors: string[] = [];
  const fail = (table: Table, index: number, message: string) =>
    errors.push(`${EXPORT_FILES[table]} line ${index + 1}: ${message}`);

  for (const table of Object.keys(EXPORT_FILES) as Table[]) {
    const rows = data[table] as unknown;
    if (!Array.isArray(rows)) {
      errors.push(`${EXPORT_FILES[table]}: must be a list of rows`);
      continue;
    }
    const schema = SCHEMAS[table];
    rows.forEach((row: unknown, index) => {
      if (!isObject(row)) return fail(table, index, 'must be a JSON object');
      for (const key of Object.keys(row).sort()) {
        if (!(key in schema)) fail(table, index, `unknown field ${JSON.stringify(key)}`);
      }
      let typed = true;
      for (const [key, field] of Object.entries(schema)) {
        if (!(key in row)) {
          fail(table, index, `${key} is missing`);
          typed = false;
          continue;
        }
        const problem = misfit(row[key], field);
        if (problem) {
          fail(table, index, `${key} ${problem}`);
          typed = false;
        }
      }
      if (typed) for (const rule of rowRules(table, row)) fail(table, index, rule);
    });
  }

  if (errors.length === 0) {
    const unique = (table: 'sources' | 'items' | 'candidates' | 'links') => {
      const ids = new Set<string>();
      data[table].forEach((row, index) => {
        if (ids.has(row.id)) fail(table, index, 'repeats the id of an earlier row');
        ids.add(row.id);
      });
      return ids;
    };
    const sources = unique('sources');
    const items = unique('items');
    const candidates = unique('candidates');
    unique('links');
    data.candidates.forEach((c, index) => {
      if (c.mergedIntoId !== null && !candidates.has(c.mergedIntoId)) fail('candidates', index, 'mergedIntoId names no exported candidate');
    });
    data.links.forEach((l, index) => {
      if (l.candidateId !== null && !candidates.has(l.candidateId)) fail('links', index, 'candidateId names no exported candidate');
      if (!items.has(l.sourceItemId)) fail('links', index, 'sourceItemId names no exported item');
    });
    data.provenance.forEach((p, index) => {
      if (!items.has(p.sourceItemId)) fail('provenance', index, 'sourceItemId names no exported item');
      if (!sources.has(p.sourceId)) fail('provenance', index, 'sourceId names no exported source');
    });
  }

  if (errors.length > 0) {
    const more = errors.length > MAX_ERRORS ? `\n  ... and ${errors.length - MAX_ERRORS} more` : '';
    throw new ExportError(`The export does not match ${EXPORT_FORMAT}:\n  ${errors.slice(0, MAX_ERRORS).join('\n  ')}${more}`);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

function readJsonl(dir: string, name: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch {
    throw new ExportError(`The export has no ${name}. Run npm run discovery:export again.`);
  }
  const rows: unknown[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new ExportError(`${name} line ${index + 1} is not valid JSON.`);
    }
  });
  return rows;
}

/**
 * Reads an export directory, refusing another format, a file whose row count
 * disagrees with the manifest, and any row that does not match its schema.
 */
export function readExport(dir: string): DiscoveryExport {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new ExportError(`${dir} holds no readable manifest.json. Point --export at a discovery:export directory.`);
  }
  if (!isObject(manifest)) throw new ExportError('manifest.json must be a JSON object.');
  if (manifest.format !== EXPORT_FORMAT) {
    throw new ExportError(`The export is format ${JSON.stringify(manifest.format)}; this harness reads ${EXPORT_FORMAT}.`);
  }
  const problems: string[] = [];
  for (const key of Object.keys(manifest).sort()) {
    if (!['format', 'tenantId', 'exportedAt', 'counts'].includes(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  if (misfit(manifest.tenantId, 'id')) problems.push('tenantId must be a non-empty string');
  if (misfit(manifest.exportedAt, 'time')) problems.push('exportedAt must be an ISO timestamp');
  const counts = isObject(manifest.counts) ? manifest.counts : null;
  const files: string[] = Object.values(EXPORT_FILES);
  if (
    !counts ||
    Object.keys(counts).sort().join(',') !== [...files].sort().join(',') ||
    !Object.values(counts).every((n) => Number.isInteger(n) && (n as number) >= 0)
  ) {
    problems.push(`counts must give a row count for each of ${files.join(', ')}, and nothing else`);
  }
  if (problems.length > 0) throw new ExportError(`manifest.json does not match ${EXPORT_FORMAT}: ${problems.join('; ')}.`);

  const rows = Object.fromEntries(
    (Object.entries(EXPORT_FILES) as Array<[Table, string]>).map(([table, file]) => [table, readJsonl(dir, file)]),
  ) as Record<Table, unknown[]>;
  for (const [table, file] of Object.entries(EXPORT_FILES) as Array<[Table, string]>) {
    const expected = counts![file];
    const actual = rows[table].length;
    if (expected !== actual) {
      throw new ExportError(`${file} holds ${actual} rows but the manifest says ${expected}. The export is incomplete.`);
    }
  }
  const data = rows as unknown as Omit<DiscoveryExport, 'manifest'>;
  validateRows(data);
  return { manifest: manifest as ExportManifest, ...data };
}
