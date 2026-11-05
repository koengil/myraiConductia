/**
 * Read-only preflight for the onboarding live demo.
 *
 *   DEAL_CODE=SUMMIT-2026-003 \
 *   INVITEE_EMAIL=martin.casado@futureproofing.dev \
 *   npm run demo:check-onboarding
 *
 * The command reports readiness without printing credentials or changing data.
 */
import { createClient } from '@supabase/supabase-js';
import { isBoxConfigured } from '../src/lib/box/types';
import { graphConfigured } from '../src/lib/email/graph';
import { resolveStorageProvider } from '../src/lib/storage';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const dealCode = process.env.DEAL_CODE?.trim();
const inviteeEmail = process.env.INVITEE_EMAIL?.trim().toLowerCase();
const presenterEmail = (
  process.env.PRESENTER_EMAIL || 'admin.intelibank@dev.com'
).trim().toLowerCase();
const sellerName = process.env.SELLER_NAME?.trim() || 'FutureProofing';
const sellerDomain = normalizeDomain(
  process.env.SELLER_DOMAIN || 'futureproofing.dev',
);
const buyerName = process.env.BUYER_NAME?.trim() || 'Vista Equity Partners';

if (!url || !secretKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (.env.local).',
  );
}
if (!dealCode) {
  throw new Error('DEAL_CODE is required.');
}
if (!inviteeEmail) {
  throw new Error('INVITEE_EMAIL is required.');
}

const admin = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Level = 'PASS' | 'WARN' | 'FAIL';
type Result = { level: Level; label: string; detail: string };
const results: Result[] = [];

const REQUIRED_FLAGS = [
  'platform_onboarding',
  'company_access_management',
  'setup_walkthroughs',
] as const;

const DEMO_DOCUMENTS = [
  { name: 'FutureProofing Process Letter.txt', minPhase: 0 },
  { name: 'FutureProofing Financial Overview.txt', minPhase: 2 },
] as const;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

function record(level: Level, label: string, detail: string): void {
  results.push({ level, label, detail });
}

async function checkTable(
  table: string,
  column: string,
  label: string,
): Promise<void> {
  const { error } = await admin.from(table).select(column).limit(1);
  record(
    error ? 'FAIL' : 'PASS',
    label,
    error ? `migration is missing or unreadable: ${error.message}` : 'available',
  );
}

async function main(): Promise<void> {
  console.log('Onboarding demo preflight (read-only)');
  console.log(`Deal: ${dealCode}`);
  console.log(`Presenter: ${presenterEmail}`);
  console.log(`Invitee: ${inviteeEmail}`);
  console.log('');

  const { data: flagRows, error: flagsError } = await admin
    .from('feature_flags')
    .select('key, enabled')
    .in('key', [...REQUIRED_FLAGS, 'mail_channel']);

  const flags = new Map<string, boolean>(
    (flagRows ?? []).map((row) => [String(row.key), row.enabled === true]),
  );
  if (flagsError) {
    record('FAIL', 'Feature flags', flagsError.message);
  } else {
    for (const key of REQUIRED_FLAGS) {
      record(
        flags.get(key) ? 'PASS' : 'FAIL',
        `Flag ${key}`,
        flags.get(key) ? 'enabled' : 'missing or disabled',
      );
    }
    record(
      flags.get('mail_channel') ? 'PASS' : 'WARN',
      'Flag mail_channel',
      flags.get('mail_channel')
        ? 'enabled'
        : 'disabled; skip the Microsoft 365 connection beat',
    );
  }

  await checkTable('users', 'preferred_deal_role', 'Preferred deal-role schema');
  await checkTable('company_roles', 'id', 'Company access schema');
  await checkTable(
    'setup_walkthrough_progress',
    'user_id',
    'Setup walkthrough schema',
  );

  const { data: deal, error: dealError } = await admin
    .from('deals')
    .select('id, code, codename, tenant_id')
    .eq('code', dealCode)
    .maybeSingle();

  if (dealError || !deal) {
    record(
      'FAIL',
      'Demo deal',
      dealError?.message ?? `no deal found for ${dealCode}`,
    );
  } else {
    record('PASS', 'Demo deal', `${deal.code} (${deal.codename})`);

    const { data: presenter, error: presenterError } = await admin
      .from('users')
      .select('firm_role, status, tenant_id, is_external')
      .eq('email', presenterEmail)
      .maybeSingle();
    const presenterReady =
      !presenterError &&
      presenter?.firm_role === 'admin' &&
      presenter.status === 'active' &&
      presenter.is_external !== true &&
      presenter.tenant_id === deal.tenant_id;
    record(
      presenterReady ? 'PASS' : 'FAIL',
      'Presenter authority',
      presenterError?.message ??
        (presenterReady
          ? 'active same-tenant firm admin; may bootstrap the external director'
          : `${presenterEmail} must be an active same-tenant firm admin`),
    );

    const { data: md, error: mdError } = await admin
      .from('deal_memberships')
      .select('user_id')
      .eq('deal_id', deal.id)
      .eq('deal_role', 'md')
      .limit(1)
      .maybeSingle();
    record(
      mdError || !md ? 'FAIL' : 'PASS',
      'Deal MD',
      mdError?.message ?? (md ? 'present' : 'missing'),
    );

    const { data: sellerRows, error: sellerError } = await admin
      .from('companies')
      .select('id, name, type')
      .eq('tenant_id', deal.tenant_id)
      .ilike('name', sellerName)
      .limit(1);
    const seller = sellerRows?.[0];
    if (sellerError || !seller) {
      record(
        'FAIL',
        'Seller fixture',
        sellerError?.message ?? `${sellerName} is not prepared`,
      );
    } else {
      const [
        { data: sellerParty, error: partyError },
        { data: domain, error: domainError },
        { data: sellerMembers, error: sellerMembersError },
      ] =
        await Promise.all([
          admin
            .from('deal_parties')
            .select('party_role')
            .eq('deal_id', deal.id)
            .eq('company_id', seller.id)
            .in('party_role', ['target', 'co_seller'])
            .limit(1)
            .maybeSingle(),
          admin
            .from('company_verified_domains')
            .select('domain')
            .eq('company_id', seller.id)
            .eq('domain', sellerDomain)
            .maybeSingle(),
          admin
            .from('users')
            .select('company_role')
            .eq('company_id', seller.id)
            .eq('status', 'active'),
        ]);
      record(
        partyError || !sellerParty ? 'FAIL' : 'PASS',
        'Seller party',
        partyError?.message ?? sellerParty?.party_role ?? 'missing',
      );
      record(
        domainError || !domain ? 'FAIL' : 'PASS',
        'Verified seller domain',
        domainError?.message ?? domain?.domain ?? 'missing',
      );
      const sellerHasDirector = sellerMembers?.some(
        (member) => member.company_role === 'director',
      );
      const sellerRootReady =
        !sellerMembersError &&
        (sellerMembers?.length === 0 || sellerHasDirector === true);
      record(
        sellerRootReady ? 'PASS' : 'FAIL',
        'Seller company root',
        sellerMembersError?.message ??
          (sellerMembers?.length === 0
            ? 'unclaimed; first invitation must be Director and sent by the firm admin'
            : sellerHasDirector
              ? 'active director present'
              : 'active members exist without an active director'),
      );
    }

    const { data: buyerRows, error: buyerError } = await admin
      .from('companies')
      .select('id, name')
      .eq('tenant_id', deal.tenant_id)
      .ilike('name', buyerName)
      .limit(1);
    const buyer = buyerRows?.[0];
    if (buyerError || !buyer) {
      record(
        'FAIL',
        'Buyer fixture',
        buyerError?.message ?? `${buyerName} is not prepared`,
      );
    } else {
      const { data: buyerParty, error: buyerPartyError } = await admin
        .from('deal_parties')
        .select('id')
        .eq('deal_id', deal.id)
        .eq('company_id', buyer.id)
        .eq('party_role', 'acquirer_shortlist')
        .maybeSingle();
      record(
        buyerPartyError || !buyerParty ? 'FAIL' : 'PASS',
        'Buyer shortlist party',
        buyerPartyError?.message ?? (buyerParty ? buyerName : 'missing'),
      );
    }

    const { data: documents, error: documentsError } = await admin
      .from('documents')
      .select('name, room, classification, min_phase, storage_provider')
      .eq('deal_id', deal.id)
      .in(
        'name',
        DEMO_DOCUMENTS.map((document) => document.name),
      );
    if (documentsError) {
      record('FAIL', 'Demo documents', documentsError.message);
    } else {
      for (const expected of DEMO_DOCUMENTS) {
        const actual = documents?.find((document) => document.name === expected.name);
        const valid =
          actual?.room === 'deal' &&
          actual.classification === 1 &&
          actual.min_phase === expected.minPhase &&
          Boolean(actual.storage_provider);
        record(
          valid ? 'PASS' : 'FAIL',
          expected.name,
          valid
            ? `Deal Room, phase ${expected.minPhase}, ${actual.storage_provider}`
            : `expected Deal Room, classification 1, phase ${expected.minPhase}`,
        );
      }
    }
  }

  const [{ data: pendingInvite, error: inviteError }, { data: existingUser, error: userError }] =
    await Promise.all([
      admin
        .from('invites')
        .select('id, delivery_status')
        .eq('email', inviteeEmail)
        .eq('status', 'pending')
        .maybeSingle(),
      admin.from('users').select('id, status').eq('email', inviteeEmail).maybeSingle(),
    ]);

  if (inviteError || userError) {
    record('FAIL', 'Invitee state', inviteError?.message ?? userError?.message ?? 'unreadable');
  } else if (pendingInvite || existingUser) {
    record(
      'WARN',
      'Invitee state',
      `not fresh${pendingInvite ? `; pending invite is ${pendingInvite.delivery_status}` : ''}. Run demo:reset-invitee before presenting`,
    );
  } else {
    record('PASS', 'Invitee state', 'fresh email, ready for invitation');
  }

  const boxConfigured = isBoxConfigured();
  const boxActive = boxConfigured && resolveStorageProvider() === 'box';
  record(
    boxActive ? 'PASS' : 'WARN',
    'Box data room',
    boxActive
      ? 'configured and active'
      : boxConfigured
        ? 'configured but not active'
        : 'not configured; use the documented storage fallback',
  );

  const microsoftReady = flags.get('mail_channel') === true && graphConfigured();
  record(
    microsoftReady ? 'PASS' : 'WARN',
    'Microsoft 365',
    microsoftReady
      ? 'server configuration is ready'
      : 'not ready; show the honest readiness state and skip live OAuth',
  );

  record(
    process.env.RESEND_API_KEY && process.env.RESEND_FROM ? 'PASS' : 'WARN',
    'Invite email delivery',
    process.env.RESEND_API_KEY && process.env.RESEND_FROM
      ? 'provider and sender are configured'
      : 'RESEND_API_KEY or RESEND_FROM is missing',
  );

  for (const result of results) {
    console.log(`[${result.level}] ${result.label}: ${result.detail}`);
  }

  const failures = results.filter((result) => result.level === 'FAIL').length;
  const warnings = results.filter((result) => result.level === 'WARN').length;
  const passes = results.filter((result) => result.level === 'PASS').length;
  console.log('');
  console.log(`Summary: ${passes} passed, ${warnings} warned, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
