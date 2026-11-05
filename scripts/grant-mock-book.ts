import { createClient } from '@supabase/supabase-js';
import { MOCK_DEALS, MOCK_BOOK_MD_SLUG } from '../src/lib/mock/scale';
import { DEAL_ROLE } from '../src/lib/constants/roles';
import { AUDIT_ACTION } from '../src/lib/constants/audit';
import { seedEmail } from './seed-data';

// Grants an existing INTERNAL user a seat on every mock-book deal (#190), so
// they see the same Book (fees, dates, tasks, phases) as the dedicated
// book-md owner. Idempotent: existing seats are kept.
//
// Known limits of a granted seat (vs the owner):
//   - the book is SHARED: advancing the rail is visible to everyone, and a
//     deal_team seat can advance but not regress (MD-only);
//   - the Deal Console's Complete/Assign stay owner-scoped;
//   - the seeded OUTBOUND mail volume is sender-scoped to the owner — a
//     grantee sees the inbound side only.
//
// Usage: npm run grant:mock-book -- someone@bank.dev

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Usage: npm run grant:mock-book -- <existing-user-email>');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Exact match — emails are stored lowercase, and a LIKE pattern would let
  // '_'/'%' in operator input select the wrong user.
  const userByEmail = async (e: string) => {
    const { data, error } = await db
      .from('users')
      .select('id, is_external')
      .eq('email', e)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; is_external: boolean | null } | null;
  };
  const grantee = await userByEmail(email);
  if (!grantee) throw new Error(`User ${email} not found — create them first (seed:users or sign-up).`);
  // Phase gates exist for externals; the mock book is internal demo data and
  // a high-phase external seat would be an irreversible disclosure widening.
  if (grantee.is_external) throw new Error(`${email} is external — the mock book is internal-only.`);
  const owner = await userByEmail(seedEmail(MOCK_BOOK_MD_SLUG));
  if (!owner) throw new Error('Mock owner not found — run seed:mock-scale first.');

  // Identity is lower(codename); match in JS so casing drift cannot silently
  // shrink the granted book.
  const wanted = new Set(MOCK_DEALS.map((d) => d.codename.toLowerCase()));
  const { data: ownerDeals, error: dealsError } = await db
    .from('deals')
    .select('id, codename')
    .eq('mandate_owner_id', owner.id);
  if (dealsError) throw dealsError;
  const deals = (ownerDeals ?? []).filter((d) => wanted.has((d.codename as string).toLowerCase()));
  if (!deals.length) throw new Error('No mock deals found — run seed:mock-scale first.');
  if (deals.length < wanted.size) {
    console.warn(`warning: only ${deals.length}/${wanted.size} mock deals found; the granted book will be partial.`);
  }

  const { data: roleRow, error: roleError } = await db
    .from('roles')
    .select('id')
    .eq('slug', DEAL_ROLE.DEAL_TEAM)
    .single();
  if (roleError) throw roleError;

  let granted = 0;
  for (const deal of deals) {
    const { data: existing, error: existsError } = await db
      .from('deal_memberships')
      .select('id')
      .eq('deal_id', deal.id)
      .eq('user_id', grantee.id)
      .maybeSingle();
    if (existsError) throw existsError;
    if (existing) continue;

    // Internal seats are phase 0 by definition (phase gates external users
    // only — proposalFeasibility coerces this anyway); added_by keeps the
    // seat visible to the revoke-by-adder sweep and removable by its adder.
    const { data: seat, error: insertError } = await db
      .from('deal_memberships')
      .insert({
        deal_id: deal.id,
        user_id: grantee.id,
        role_id: roleRow.id,
        deal_role: DEAL_ROLE.DEAL_TEAM,
        phase: 0,
        added_by: owner.id,
      })
      .select('id')
      .single();
    if (insertError) throw insertError;

    // Evidence like any platform grant: the GRANTER is the actor, the
    // beneficiary is in the detail. Seat + audit must land together — if the
    // audit write fails, the seat is rolled back rather than left silent.
    const { error: auditError } = await db.from('audit_log').insert({
      actor_id: owner.id,
      action: AUDIT_ACTION.GRANT,
      deal_id: deal.id,
      detail: { deal_role: DEAL_ROLE.DEAL_TEAM, user_id: grantee.id, via: 'grant-mock-book script' },
    });
    if (auditError) {
      await db.from('deal_memberships').delete().eq('id', seat.id);
      throw auditError;
    }
    granted += 1;
    console.log(`granted ${deal.codename}`);
  }
  console.log(`Done: ${granted} new seat(s), ${deals.length - granted} already present. ${email} now sees the mock book.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
