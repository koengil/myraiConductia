import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_FORMATS,
  canonicalRow,
  canonicalTimestamp,
  canonicalizeV1,
  chainHash,
  chainSeq,
  matchingFormat,
  verifyChain,
  verifyTenantChains,
  type AuditChainRow,
  type CanonicalForm,
} from '@/lib/audit/chain';

// Golden rows written by the SQL chain (audit_canonical_row + the
// zz_audit_log_chain_append trigger) on a local stack. The TypeScript port must
// reproduce the SQL canonical text and hash byte for byte. The rows cover a
// genesis row, a user row whose tenant comes from its deal, a model row whose
// detail holds escapes, control characters, U+2028, an astral character and
// numbers jsonb normalizes, and a row whose -05:00 timestamp crosses midnight UTC.
type GoldenRow = AuditChainRow & { canonical: string };
const golden = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/audit-chain-golden.json'), 'utf8'),
) as { rows: GoldenRow[] };
const rows: AuditChainRow[] = golden.rows;

describe('audit chain canonical form', () => {
  it.each(golden.rows.map((row) => [row.chain_seq, row] as const))(
    'reproduces the SQL canonical text and hash for chain_seq %s',
    (_seq, row) => {
      const canonical = canonicalRow(row);
      expect(canonical).toBe(row.canonical);
      expect(chainHash(row.prev_hash, canonical)).toBe(row.hash);
    },
  );

  it('normalizes every timestamp rendering to UTC with microseconds', () => {
    expect(canonicalTimestamp('2026-09-25T10:00:00+00:00')).toBe('2026-09-25T10:00:00.000000Z');
    expect(canonicalTimestamp('2026-09-25 10:00:00.5+00')).toBe('2026-09-25T10:00:00.500000Z');
    expect(canonicalTimestamp('2026-09-25T23:59:59.000001-05:00')).toBe('2026-09-26T04:59:59.000001Z');
    expect(canonicalTimestamp('2026-09-25T10:00:00.123456+0530')).toBe('2026-09-25T04:30:00.123456Z');
    expect(canonicalTimestamp('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000000Z');
    expect(() => canonicalTimestamp('2026-09-25T10:00:00')).toThrow(/Unrecognized/);
  });

  it('accepts bytea hashes with the \\x prefix', () => {
    const [first, second] = rows;
    expect(chainHash(`\\x${first.hash}`, canonicalRow(second))).toBe(second.hash);
  });
});

describe('verifyChain', () => {
  it('verifies the golden chain', () => {
    expect(verifyChain(rows)).toEqual({ ok: true, length: 4 });
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it('names the tampered row when detail is edited', () => {
    const tampered = rows.map((row) =>
      row.chain_seq === 2 ? { ...row, detail_text: '{"to": 13, "from": 11, "fromStepKey": "p2-s11"}' } : row,
    );
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: BigInt(2) });
  });

  it('names the tampered row when an attribution column is edited', () => {
    const tampered = rows.map((row) =>
      row.chain_seq === 3 ? { ...row, actor_type: 'service', service_identity: 'conductia' } : row,
    );
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: BigInt(3) });
  });

  it('detects a rewritten row whose hash was recomputed, at the next link', () => {
    const edited = { ...rows[1], detail_text: '{"to": 99}' };
    edited.hash = chainHash(edited.prev_hash, canonicalRow(edited));
    expect(verifyChain([rows[0], edited, rows[2], rows[3]])).toMatchObject({
      ok: false,
      brokenAt: BigInt(3),
      reason: 'prev_hash does not match the previous row',
    });
  });

  it('detects a removed row and a genesis row with a predecessor', () => {
    expect(verifyChain([rows[0], rows[2], rows[3]])).toMatchObject({ ok: false, brokenAt: BigInt(3) });
    expect(verifyChain([{ ...rows[0], prev_hash: rows[3].hash }])).toMatchObject({
      ok: false,
      brokenAt: BigInt(1),
    });
  });

  it('verifies each tenant separately', () => {
    const other: AuditChainRow = {
      ...rows[0],
      id: '55555555-5555-4555-8555-555555555555',
      tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const results = verifyTenantChains([rows[3], other, rows[1], rows[0], rows[2]]);
    expect(results).toEqual([
      { tenantId: rows[0].tenant_id, verdict: { ok: true, length: 4 } },
      { tenantId: other.tenant_id, verdict: { ok: false, brokenAt: BigInt(1), reason: 'hash does not match the row contents' } },
    ]);
  });
});

describe('chain_seq as a BigInt', () => {
  it('reads text, bigint and safe numbers, and refuses anything that lost digits', () => {
    expect(chainSeq('9007199254740993')).toBe(BigInt('9007199254740993'));
    expect(chainSeq(BigInt(7))).toBe(BigInt(7));
    expect(chainSeq(7)).toBe(BigInt(7));
    expect(() => chainSeq(9007199254740993)).toThrow(/safe integer/);
    expect(() => chainSeq('7.5')).toThrow(/Malformed/);
  });

  it('renders a chain_seq beyond 2^53 exactly in the canonical row', () => {
    const row = { ...rows[0], chain_seq: '9007199254740993' };
    expect(canonicalRow(row)).toContain('"9007199254740993"');
  });

  it('verifies a chain read with chain_seq as text', () => {
    const asText = rows.map((row) => ({ ...row, chain_seq: String(row.chain_seq) }));
    expect(verifyChain(asText)).toEqual({ ok: true, length: 4 });
  });
});

describe('format version dispatch', () => {
  // A stand-in for a future canonical form: same fields, another tag.
  const canonicalizeV2: CanonicalForm = (row) =>
    canonicalizeV1(row).replace('"audit_log/v1"', '"audit_log/v2"');
  const formats: Record<string, CanonicalForm> = {
    ...AUDIT_CHAIN_FORMATS,
    'audit_log/v2': canonicalizeV2,
  };

  // The golden chain with its last row rewritten as if written under v2.
  const mixed = rows.map((row, index) =>
    index === rows.length - 1 ? { ...row, hash: chainHash(row.prev_hash, canonicalizeV2(row)) } : row,
  );

  it('ships exactly the v1 form, and it is the one canonicalRow writes', () => {
    expect(Object.keys(AUDIT_CHAIN_FORMATS)).toEqual(['audit_log/v1']);
    expect(matchingFormat(rows[0])).toBe('audit_log/v1');
  });

  it('verifies a row hashed under any registered version', () => {
    expect(matchingFormat(mixed[3], formats)).toBe('audit_log/v2');
    expect(matchingFormat(mixed[0], formats)).toBe('audit_log/v1');
    expect(verifyChain(mixed, formats)).toEqual({ ok: true, length: 4 });
    expect(verifyTenantChains(mixed, formats)).toEqual([
      { tenantId: rows[0].tenant_id, verdict: { ok: true, length: 4 } },
    ]);
  });

  it('fails a row that matches no registered version', () => {
    expect(matchingFormat(mixed[3])).toBeNull();
    expect(verifyChain(mixed)).toEqual({
      ok: false,
      brokenAt: BigInt(4),
      reason: 'hash does not match the row contents',
    });
    const forged = { ...rows[3], hash: chainHash(rows[3].prev_hash, canonicalRow(rows[3]).replace('v1', 'v9')) };
    expect(matchingFormat(forged, formats)).toBeNull();
    expect(verifyChain([...rows.slice(0, 3), forged], formats)).toMatchObject({ ok: false, brokenAt: BigInt(4) });
  });
});
