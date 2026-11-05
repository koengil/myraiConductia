/**
 * Onboarding demo enabler: prepare deterministic seller and buyer companies
 * for a deal so smart lookup, domain verification and both invite paths work.
 *
 * Gate 0 creates the target party but there is no acquirer-party API yet. This
 * script reconciles the seller fixture, attaches a buyer shortlist party and
 * records only explicit operations-supplied domain reference data.
 *
 *   DEAL_CODE=RANGE-2026-123 npm run seed:onboarding-demo
 *
 * Defaults are the live-demo golden path:
 *   FutureProofing / futureproofing.dev / martin.casado@futureproofing.dev
 *
 * Idempotent: companies are matched case-insensitively, party rows are reused,
 * and verified domains are upserted by (company_id, domain).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DOCUMENT_CLASSIFICATION,
  DOCUMENT_ROOM,
} from '../src/lib/constants/documents';
import { getDataRoomStorage } from '../src/lib/storage';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const dealCode = process.env.DEAL_CODE;
const sellerName = process.env.SELLER_NAME?.trim() || 'FutureProofing';
const sellerDomain = normalizeDomain(
  process.env.SELLER_DOMAIN || 'futureproofing.dev',
);
const sellerEmail = (
  process.env.SELLER_EMAIL || 'martin.casado@futureproofing.dev'
)
  .trim()
  .toLowerCase();
const buyerName = process.env.BUYER_NAME?.trim() || 'Vista Equity Partners';

if (!url || !secretKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (see .env.example)',
  );
}
if (!dealCode) {
  throw new Error(
    'DEAL_CODE is required, e.g. DEAL_CODE=RANGE-2026-123 npm run seed:onboarding-demo',
  );
}
if (!isBusinessDomain(sellerDomain)) {
  throw new Error(
    `SELLER_DOMAIN must be a normalized business domain; received "${sellerDomain}"`,
  );
}
if (emailDomain(sellerEmail) !== sellerDomain) {
  throw new Error(
    `SELLER_EMAIL (${sellerEmail}) must use the operations-supplied SELLER_DOMAIN (${sellerDomain})`,
  );
}

const admin = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Db = SupabaseClient;

const DEMO_DOCUMENTS = [
  {
    name: 'FutureProofing Process Letter.txt',
    minPhase: 0,
    body: 'Synthetic demo artifact: FutureProofing seller process letter.\n',
  },
  {
    name: 'FutureProofing Financial Overview.txt',
    minPhase: 2,
    body: 'Synthetic demo artifact: FutureProofing phase-two financial overview.\n',
  },
] as const;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

function emailDomain(value: string): string | null {
  const parts = value.split('@');
  return parts.length === 2 && parts[0] && parts[1]
    ? normalizeDomain(parts[1])
    : null;
}

function isBusinessDomain(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9-]*$/.test(value) &&
    !value.includes('..')
  );
}

async function ensureCompany(
  db: Db,
  tenantId: string,
  name: string,
  type: 'target' | 'acquirer',
): Promise<{ id: string; type: string; created: boolean }> {
  const { data, error } = await db
    .from('companies')
    .select('id, type')
    .eq('tenant_id', tenantId)
    .ilike('name', name)
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) {
    return {
      id: data[0].id as string,
      type: data[0].type as string,
      created: false,
    };
  }

  const { data: created, error: createError } = await db
    .from('companies')
    .insert({ tenant_id: tenantId, name, type })
    .select('id, type')
    .single();
  if (createError) throw createError;
  return {
    id: created.id as string,
    type: created.type as string,
    created: true,
  };
}

async function ensureSellerParty(
  db: Db,
  dealId: string,
  companyId: string,
): Promise<'target' | 'co_seller'> {
  const { data: existing, error: existingError } = await db
    .from('deal_parties')
    .select('party_role')
    .eq('deal_id', dealId)
    .eq('company_id', companyId)
    .in('party_role', ['target', 'co_seller'])
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.[0]?.party_role)
    return existing[0].party_role as 'target' | 'co_seller';

  const { data: currentTarget, error: targetError } = await db
    .from('deal_parties')
    .select('id')
    .eq('deal_id', dealId)
    .eq('party_role', 'target')
    .limit(1);
  if (targetError) throw targetError;

  const partyRole = currentTarget?.length ? 'co_seller' : 'target';
  const { error: insertError } = await db.from('deal_parties').insert({
    deal_id: dealId,
    company_id: companyId,
    party_role: partyRole,
  });
  if (insertError) throw insertError;
  return partyRole;
}

async function ensureBuyerParty(
  db: Db,
  dealId: string,
  companyId: string,
): Promise<boolean> {
  const { data: existing, error: existingError } = await db
    .from('deal_parties')
    .select('id')
    .eq('deal_id', dealId)
    .eq('company_id', companyId)
    .eq('party_role', 'acquirer_shortlist')
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.length) return false;

  const { error: insertError } = await db.from('deal_parties').insert({
    deal_id: dealId,
    company_id: companyId,
    party_role: 'acquirer_shortlist',
  });
  if (insertError) throw insertError;
  return true;
}

async function ensureVerifiedDomain(
  db: Db,
  companyId: string,
  domain: string,
): Promise<void> {
  const { error } = await db.from('company_verified_domains').upsert(
    {
      company_id: companyId,
      domain,
      source: 'platform_operations_seed',
    },
    { onConflict: 'company_id,domain' },
  );
  if (error) throw error;
}

async function ensureDemoDocuments(
  db: Db,
  deal: { id: string; code: string },
): Promise<{ created: number; reused: number }> {
  const { data: md, error: mdError } = await db
    .from('deal_memberships')
    .select('user_id')
    .eq('deal_id', deal.id)
    .eq('deal_role', 'md')
    .limit(1)
    .maybeSingle();
  if (mdError) throw mdError;
  if (!md?.user_id) {
    throw new Error(
      `Deal ${deal.code} has no MD to attribute demo document uploads`,
    );
  }

  const storage = getDataRoomStorage();
  let created = 0;
  let reused = 0;

  for (const definition of DEMO_DOCUMENTS) {
    const { data: existing, error: lookupError } = await db
      .from('documents')
      .select(
        'room, classification, min_phase, storage_provider, storage_file_id',
      )
      .eq('deal_id', deal.id)
      .eq('name', definition.name)
      .limit(1)
      .maybeSingle();
    if (lookupError) throw lookupError;

    if (existing) {
      const matchesFixture =
        existing.room === DOCUMENT_ROOM.DEAL &&
        existing.classification === DOCUMENT_CLASSIFICATION.PUBLIC &&
        existing.min_phase === definition.minPhase &&
        existing.storage_provider === storage.provider &&
        Boolean(existing.storage_file_id);
      if (!matchesFixture) {
        throw new Error(
          `Existing document "${definition.name}" does not match the deterministic demo fixture`,
        );
      }
      reused += 1;
      continue;
    }

    const bytes = new TextEncoder().encode(definition.body);
    const stored = await storage.upload(
      deal.code,
      DOCUMENT_ROOM.DEAL,
      definition.name,
      'text/plain',
      bytes,
    );

    const { data: document, error: rpcError } = await db.rpc(
      'create_document_with_audit',
      {
        p_deal_id: deal.id,
        p_name: definition.name,
        p_room: DOCUMENT_ROOM.DEAL,
        p_classification: DOCUMENT_CLASSIFICATION.PUBLIC,
        p_min_phase: definition.minPhase,
        p_uploaded_by: md.user_id,
        p_storage_provider: stored.provider,
        p_storage_file_id: stored.fileId,
        p_size_bytes: stored.sizeBytes,
        p_content_type: 'text/plain',
      },
    );
    if (rpcError || !document) {
      await storage.remove(stored.fileId).catch(() => {});
      throw (
        rpcError ??
        new Error(`Could not record demo document "${definition.name}"`)
      );
    }
    created += 1;
  }

  return { created, reused };
}

async function main() {
  const { data: deal, error: dealError } = await admin
    .from('deals')
    .select('id, code, codename, tenant_id')
    .eq('code', dealCode)
    .maybeSingle();
  if (dealError) throw dealError;
  if (!deal) throw new Error(`No deal with code ${dealCode}`);

  const seller = await ensureCompany(
    admin,
    deal.tenant_id,
    sellerName,
    'target',
  );
  if (seller.type === 'bank') {
    throw new Error(
      `Seller fixture "${sellerName}" resolves to a bank company; refusing to attach it`,
    );
  }
  const sellerPartyRole = await ensureSellerParty(admin, deal.id, seller.id);
  await ensureVerifiedDomain(admin, seller.id, sellerDomain);

  const buyer = await ensureCompany(
    admin,
    deal.tenant_id,
    buyerName,
    'acquirer',
  );
  if (buyer.type === 'bank') {
    throw new Error(
      `Buyer fixture "${buyerName}" resolves to a bank company; refusing to attach it`,
    );
  }
  const buyerAttached = await ensureBuyerParty(admin, deal.id, buyer.id);
  const documents = await ensureDemoDocuments(admin, deal);

  console.log(
    `Prepared ${deal.code} (${deal.codename}) for the onboarding demo:`,
  );
  console.log(
    `- Seller: ${sellerName} (${sellerPartyRole}) with verified domain ${sellerDomain}${seller.created ? ' [created]' : ''}`,
  );
  console.log(
    `- Golden-path invite: ${sellerEmail} -> verified company match, Seller, phase 0`,
  );
  console.log(
    `- Buyer: ${buyerName} (acquirer_shortlist)${buyer.created ? ' [created]' : ''}${buyerAttached ? ' [attached]' : ''}`,
  );
  console.log(
    `- Deal Room: phase-0 and phase-2 demo documents (${documents.created} created, ${documents.reused} reused)`,
  );
  console.log(
    'Choose Company Director manually in Team when demonstrating delegation.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
