import { createClient } from '@supabase/supabase-js';
import { chainSeq, verifyTenantChains, type AuditChainRow } from '../src/lib/audit/chain';

/*
 * Recomputes every tenant's audit_log hash chain from the rows themselves
 * (src/lib/audit/chain.ts) and reports, per tenant, ok or the first broken
 * chain_seq. A row verifies when its stored hash matches under any known
 * format version. Exits non-zero when any chain is broken. Read-only.
 *
 *   npm run audit:verify-chain            # uses .env.local
 *
 * Rows written before 20260925100000_audit_hash_chain.sql carry no chain and
 * are counted, not verified.
 *
 * Pages are keyset pages over (tenant_id, chain_seq), each one starting after
 * the last row of the one before. Chains are append-only per tenant, so
 * concurrent inserts can only lengthen a tenant still being read or add to a
 * tenant not yet reached: every tenant is read as a gapless prefix of its
 * chain, which offset paging could not promise. chain_seq is read as text
 * and handled as a BigInt.
 */

const PAGE = 1000;

const COLUMNS = [
  'id',
  'ts',
  'tenant_id',
  // bigint as text, so no digit is lost to a JS number.
  'chain_seq:chain_seq::text',
  'actor_type',
  'actor_id',
  'service_identity',
  'action',
  'deal_id',
  'document_id',
  // The jsonb text Postgres renders, so the hash input is byte-identical.
  'detail_text:detail::text',
  'prev_hash',
  'hash',
].join(', ');

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)',
    );
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const rows: AuditChainRow[] = [];
  let after: { tenantId: string; seq: string } | null = null;
  for (;;) {
    let query = supabase
      .from('audit_log')
      .select(COLUMNS)
      .not('chain_seq', 'is', null)
      .order('tenant_id', { ascending: true })
      .order('chain_seq', { ascending: true })
      .limit(PAGE);
    if (after) {
      // (tenant_id, chain_seq) > (after.tenantId, after.seq)
      query = query.or(
        `tenant_id.gt.${after.tenantId},and(tenant_id.eq.${after.tenantId},chain_seq.gt.${after.seq})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`audit_log read failed: ${error.message}`);
    const page = (data ?? []) as unknown as AuditChainRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    after = { tenantId: last.tenant_id, seq: chainSeq(last.chain_seq).toString() };
  }

  const { count: unchained, error: countError } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .is('chain_seq', null);
  if (countError) throw new Error(`audit_log count failed: ${countError.message}`);

  const results = verifyTenantChains(rows);
  let broken = 0;
  for (const { tenantId, verdict } of results) {
    if (verdict.ok) {
      console.log(`✅ tenant ${tenantId}: ok (${verdict.length} rows)`);
    } else {
      broken += 1;
      console.log(`❌ tenant ${tenantId}: broken at chain_seq ${verdict.brokenAt} (${verdict.reason})`);
    }
  }
  console.log(
    `\n${results.length} tenant chain(s), ${rows.length} chained row(s), ${unchained ?? 0} unchained pre-chain row(s).`,
  );
  if (broken > 0) {
    console.log(`❌ ${broken} chain(s) broken.`);
    process.exitCode = 1;
  } else {
    console.log('✅ Every tenant chain verifies.');
  }
}

main().catch((error) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
