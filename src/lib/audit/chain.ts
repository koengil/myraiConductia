/**
 * The audit_log hash chain, recomputed outside the database.
 *
 * 20260925100000_audit_hash_chain.sql chains every new audit_log row within
 * its tenant:
 *
 *   hash = sha256(prev_hash || utf8(audit_canonical_row(row)))
 *
 * with prev_hash empty for the genesis row (chain_seq 1). This module is the
 * TypeScript port of audit_canonical_row plus a verifier, so a chain can be
 * checked by code that does not trust the database's own functions.
 * tests/audit-chain.test.ts pins the port to golden rows produced by the SQL
 * function, and tests/db/audit-hash-chain.test.ts compares the two live.
 *
 * Format versions. The canonical row begins with a format tag, and rows store
 * no format tag. A row verifies when its stored hash matches under any known
 * version; the verifier tries every version in AUDIT_CHAIN_FORMATS. A change
 * to audit_canonical_row adds a new version to that map and never removes an
 * old one, because hashes already written cannot be recomputed.
 *
 * chain_seq is a Postgres bigint, so it is handled as a BigInt throughout:
 * read it as text and never pass it through Number.
 *
 * Server and script use only: it needs node:crypto.
 */

import { createHash } from 'node:crypto';

/** The format the SQL function writes today: the first element of its canonical row. */
export const AUDIT_CHAIN_FORMAT = 'audit_log/v1';

/**
 * One chained row as read back from the database. Column names match
 * audit_log. `detail_text` is `detail::text`: the jsonb rendering Postgres
 * produced, not a re-serialized object, so number digits survive exactly.
 * `ts` is any ISO 8601 or Postgres text timestamp with an offset. Hashes are
 * hex, with or without the `\x` bytea prefix. `chain_seq` is best read as
 * text; a JS number is accepted only while it is a safe integer.
 */
export type AuditChainRow = {
  id: string;
  ts: string;
  tenant_id: string;
  chain_seq: bigint | number | string;
  actor_type: string | null;
  actor_id: string | null;
  service_identity: string | null;
  action: string;
  deal_id: string | null;
  document_id: string | null;
  detail_text: string | null;
  prev_hash: string | null;
  hash: string | null;
};

export type ChainVerdict =
  | { ok: true; length: number }
  | { ok: false; brokenAt: bigint; reason: string };

/** Renders one row in a canonical form. */
export type CanonicalForm = (row: AuditChainRow) => string;

/**
 * chain_seq as a BigInt. Text must be an integer literal; a number must be a
 * safe integer, since a larger one has already lost digits in JSON.parse.
 */
export function chainSeq(value: AuditChainRow['chain_seq']): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) throw new Error(`Malformed chain_seq: ${value}`);
    return BigInt(value.trim());
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`chain_seq ${value} is not a safe integer; read it as text`);
  }
  return BigInt(value);
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2}){0,2})$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function offsetSeconds(zone: string): number {
  if (zone === 'Z') return 0;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replaceAll(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || '0');
  const seconds = Number(digits.slice(4, 6) || '0');
  return sign * (hours * 3600 + minutes * 60 + seconds);
}

/**
 * The canonical timestamp: UTC, microsecond precision, `Z` suffix. Mirrors
 * `to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
 */
export function canonicalTimestamp(value: string): string {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) throw new Error(`Unrecognized audit timestamp: ${value}`);
  const [, y, mo, d, h, mi, s, fraction = '', zone] = match;
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
    offsetSeconds(zone) * 1000;
  const at = new Date(utcMs);
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}`;
  const time = `${pad(at.getUTCHours(), 2)}:${pad(at.getUTCMinutes(), 2)}:${pad(at.getUTCSeconds(), 2)}`;
  return `${date}T${time}.${fraction.padEnd(6, '0')}Z`;
}

/**
 * Port of audit_canonical_row(audit_log) as first shipped (`audit_log/v1`).
 * jsonb renders an array of text as `["a", null, "b"]`, escaping strings
 * exactly as JSON.stringify does (`\"`, `\\`, `\b \f \n \r \t`, other
 * control characters as lowercase `\u00xx`, everything else verbatim).
 */
export function canonicalizeV1(row: AuditChainRow): string {
  const fields: (string | null)[] = [
    'audit_log/v1',
    row.id,
    row.tenant_id,
    chainSeq(row.chain_seq).toString(),
    canonicalTimestamp(row.ts),
    row.actor_type,
    row.actor_id,
    row.service_identity,
    row.action,
    row.deal_id,
    row.document_id,
    row.detail_text,
  ];
  return `[${fields.map((f) => (f === null ? 'null' : JSON.stringify(f))).join(', ')}]`;
}

/**
 * Every known canonical form, by format tag. Add a version here when
 * audit_canonical_row changes; never remove one.
 */
export const AUDIT_CHAIN_FORMATS: Readonly<Record<string, CanonicalForm>> = {
  'audit_log/v1': canonicalizeV1,
};

/** The canonical form the SQL function writes today. */
export function canonicalRow(row: AuditChainRow): string {
  return AUDIT_CHAIN_FORMATS[AUDIT_CHAIN_FORMAT](row);
}

/** Bytes of a bytea value read back as hex (`\x…` or bare). */
export function hexBytes(value: string | null): Buffer {
  if (value === null) return Buffer.alloc(0);
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Malformed hash hex');
  return Buffer.from(hex, 'hex');
}

/** sha256(prev_hash || utf8(canonical)), as hex. */
export function chainHash(prevHash: string | null, canonical: string): string {
  return createHash('sha256')
    .update(hexBytes(prevHash))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex');
}

function normalizedHex(value: string | null): string | null {
  return value === null ? null : hexBytes(value).toString('hex');
}

/**
 * The format tag under which `row`'s stored hash recomputes, or null when it
 * matches none. Every version is tried, since rows store no format tag.
 */
export function matchingFormat(
  row: AuditChainRow,
  formats: Readonly<Record<string, CanonicalForm>> = AUDIT_CHAIN_FORMATS,
): string | null {
  const stored = normalizedHex(row.hash);
  if (stored === null) return null;
  for (const [format, canonicalize] of Object.entries(formats)) {
    if (chainHash(row.prev_hash, canonicalize(row)) === stored) return format;
  }
  return null;
}

/**
 * Verify one tenant's chain. `rows` must be that tenant's chained rows in
 * chain_seq order. Reports the first chain_seq that fails: a gap or repeat
 * in the sequence, a prev_hash that does not name the previous row's hash,
 * or a hash that does not recompute from the row's contents under any known
 * format.
 */
export function verifyChain(
  rows: readonly AuditChainRow[],
  formats: Readonly<Record<string, CanonicalForm>> = AUDIT_CHAIN_FORMATS,
): ChainVerdict {
  let previousHash: string | null = null;
  const tenant = rows[0]?.tenant_id;
  let expected = BigInt(1);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const seq = chainSeq(row.chain_seq);
    const broken = (reason: string): ChainVerdict => ({ ok: false, brokenAt: seq, reason });
    if (row.tenant_id !== tenant) return broken('row belongs to another tenant');
    if (seq !== expected) return broken(`expected chain_seq ${expected}`);
    if (normalizedHex(row.prev_hash) !== previousHash) {
      return broken(index === 0 ? 'genesis row has a prev_hash' : 'prev_hash does not match the previous row');
    }
    if (matchingFormat(row, formats) === null) {
      return broken('hash does not match the row contents');
    }
    previousHash = normalizedHex(row.hash);
    expected += BigInt(1);
  }
  return { ok: true, length: rows.length };
}

function compareSeq(a: AuditChainRow, b: AuditChainRow): number {
  const left = chainSeq(a.chain_seq);
  const right = chainSeq(b.chain_seq);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Group rows by tenant, order each group by chain_seq, verify each chain. */
export function verifyTenantChains(
  rows: readonly AuditChainRow[],
  formats: Readonly<Record<string, CanonicalForm>> = AUDIT_CHAIN_FORMATS,
): { tenantId: string; verdict: ChainVerdict }[] {
  const byTenant = new Map<string, AuditChainRow[]>();
  for (const row of rows) {
    const group = byTenant.get(row.tenant_id) ?? [];
    group.push(row);
    byTenant.set(row.tenant_id, group);
  }
  return [...byTenant.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tenantId, group]) => ({
      tenantId,
      verdict: verifyChain([...group].sort(compareSeq), formats),
    }));
}
