// Mock-at-scale seeder (#190, Jess's Aug 17 ask): a banker's full book —
// 12 deals (8 live + 4 pitches at varied rail stages) under a dedicated MD
// account, plus a few dozen mail messages per deal — so the sidebar and the
// Book view preview (#191) can be judged at real volume.
//
// Design constraints (all deliberate):
//   - Deals are created through the REAL create_deal_gate0 RPC — full rail
//     state, memberships, and audit rows, exactly like the product path
//     (entry phase computed with the product's own formula).
//   - The mock book belongs to a dedicated user (book-md.intelibank@dev.com);
//     lookups are SCOPED to that owner, so a teammate's real deal that
//     happens to share a codename is never touched.
//   - No 'held' messages are seeded, and the CCO 'deal_created' notifications
//     the RPC fans out are removed each run: a mock must never inflate a live
//     instrument. (The RPC's 'notify' audit rows are WORM and stay — owned.)
//   - Message evidence rows (blocked/rejected) derive their verdict, reasons
//     and rewrite from the real screenMessage(), never hand-written copy.
//   - Screen/send/reject audit rows are written ONLY when a deal is created
//     (audit_log is WORM; re-runs reset messages with new ids, so audit
//     detail ids are historical after the first run — volume stays honest).
//   - Idempotent + self-repairing: existing mock deals are reused (never
//     deleted) and their entry stage, membership phase, step statuses AND
//     target close date, fee, schedule status and lifecycle category are
//     RECONCILED to the fixtures on every run (a value set by hand on a mock
//     deal is reverted);
//     messages are reset per run.
//   - Requires migrations 20260826120000_deal_target_close_date,
//     20260828150000_deal_fee_schedule_status and
//     20260828170000_deal_lifecycle_category to have run — the seed writes
//     deals.target_close_date, fee_usd, schedule_status and lifecycle_category.
//     `--wipe-mail` clears the mock mail (and notifications) and stops.
//
// Usage:  npm run seed:mock-scale [-- --wipe-mail]

import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { AUDIT_ACTION } from '../src/lib/constants/audit';
import { COMPANY_ROLE } from '../src/lib/constants/roles';
import { RAIL_CENSUS_VERSION } from '../src/lib/constants/dealSteps';
import { OUTBOX_STATUS } from '../src/lib/constants/outbox';
import { TABLE } from '../src/lib/constants/tables';
import { screenMessage } from '../src/lib/compliance/screen';
import {
  DEAL_RAIL,
  orderedSteps,
  phaseForStep,
  stepIdForSeq,
} from '../src/lib/rail/dealRail';
import { seedEmail } from './seed-data';
import {
  MOCK_BLOCKED_BODY,
  MOCK_BODIES,
  MOCK_BOOK_MD_SLUG,
  MOCK_CONTACT_FIRST_NAMES,
  MOCK_DEALS,
  MOCK_REJECTED_BODY,
  MOCK_REJECTED_NOTE,
  MOCK_SUBJECTS,
  pick,
  type MockDealDef,
} from '../src/lib/mock/scale';
import { createProvisionedUser } from '../src/lib/auth/provisioning';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createClient<any, 'public', any>>;

const HOUR_MS = 3_600_000;

/** Product formula for the entry phase (deals/route.ts) — 1-based. */
function entryPhaseFor(entrySeq: number): number {
  return phaseForStep(stepIdForSeq(entrySeq))?.index ?? 1;
}

async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const { data, error } = await db
    .from(TABLE.USERS)
    .select('id')
    .eq('email', email)
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.id as string | undefined) ?? null;
}

/** Lookup via public.users (indexed, no listUsers pagination cliff) with the
 *  same reconcile-on-exist behavior as seed-users.ts's ensureAuthUser. */
async function ensureBookMd(db: Db, password: string): Promise<string> {
  const email = seedEmail(MOCK_BOOK_MD_SLUG);
  const metadata = {
    tenant_id: DEV_TENANT_ID,
    full_name: 'Jordan Banks',
    display_name: 'Jordan Banks',
    department: null,
    is_external: false,
    firm_role: null,
  };

  const existingId = await findUserIdByEmail(db, email);
  if (existingId) {
    const { error } = await db.auth.admin.updateUserById(existingId, {
      password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
    return existingId;
  }

  const user = await createProvisionedUser(db, {
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
    profile: metadata,
  });
  return user.id;
}

/** create_deal_gate0 requires company:deals:create on the bank (bug bash
 *  Finding 14, PR #138). Seat book-md as a director of the bank: an access root
 *  (holds every key) and the director the company invariant demands. Idempotent. */
async function seatBookMdAsDirector(db: Db, actorId: string, bankId: string): Promise<void> {
  const { error } = await db
    .from(TABLE.USERS)
    .update({ company_id: bankId, company_role: 'director', is_external: false, status: 'active' })
    .eq('id', actorId);
  if (error) throw error;
}

async function bankCompanyId(db: Db): Promise<string> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .ilike('name', 'Futureproofing Capital')
    .limit(1);
  if (error) throw error;
  const id = data?.[0]?.id as string | undefined;
  if (!id) throw new Error('Bank company not found — run `npm run seed:users` first.');
  return id;
}

/** Owner-scoped, case-insensitive (the DB uniqueness is on lower(codename)):
 *  only a deal MANDATED TO book-md can ever be adopted as a mock. */
async function findMockDeal(
  db: Db,
  codename: string,
  ownerId: string,
): Promise<{ id: string; entrySeq: number } | null> {
  const { data, error } = await db
    .from(TABLE.DEALS)
    .select('id, entry_step_seq')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('mandate_owner_id', ownerId)
    .ilike('codename', codename)
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row ? { id: row.id as string, entrySeq: (row.entry_step_seq as number) ?? 1 } : null;
}

async function createMockDeal(
  db: Db,
  def: MockDealDef,
  actorId: string,
  bankId: string,
  entrySeq: number,
): Promise<string> {
  const steps = orderedSteps(DEAL_RAIL).map((s) => ({ stepId: s.id, seq: s.seq }));
  const { data, error } = await db.rpc('create_deal_gate0', {
    p_tenant_id: DEV_TENANT_ID,
    p_actor_id: actorId,
    p_bank_id: bankId,
    p_codename: def.codename,
    p_target_name: def.targetName,
    p_target_company_id: null,
    p_codename_theme: null,
    p_entry_step_seq: entrySeq,
    p_entry_phase: entryPhaseFor(entrySeq),
    p_members: [],
    p_screening: { verdict: 'compliant', reasons: [] },
    p_steps: steps,
    p_census_version: RAIL_CENSUS_VERSION,
    p_conflicts: { approvedBy: 'Storm Duncan', approvedOn: '2026-08-17' },
  });
  if (error) throw error;
  return (data as { deal: { id: string } }).deal.id;
}

/** Bring a reused deal back to the fixture's stage: deals cursor, the mock
 *  MD's membership phase, and every step status re-derived from the entry
 *  seq — so editing MOCK_DEALS and re-running is the repair path. */
async function reconcileMockDeal(
  db: Db,
  dealId: string,
  actorId: string,
  entrySeq: number,
  book: { closeDate: string; feeUsd: number; scheduleStatus: string; category: string },
): Promise<void> {
  const { error: dealError } = await db
    .from(TABLE.DEALS)
    .update({
      entry_step_seq: entrySeq,
      current_step_seq: entrySeq,
      target_close_date: book.closeDate,
      fee_usd: book.feeUsd,
      schedule_status: book.scheduleStatus,
      lifecycle_category: book.category,
    })
    .eq('id', dealId);
  if (dealError) throw dealError;

  const { error: memberError } = await db
    .from(TABLE.DEAL_MEMBERSHIPS)
    .update({ phase: entryPhaseFor(entrySeq) })
    .eq('deal_id', dealId)
    .eq('user_id', actorId);
  if (memberError) throw memberError;

  // Same status derivation as the RPC: pre-entry skipped_entry, entry
  // current, the rest pending.
  const stepsUpdate = (status: string) =>
    db.from(TABLE.DEAL_STEPS).update({ status }).eq('deal_id', dealId);
  const { error: preError } = await stepsUpdate('skipped_entry').lt('seq', entrySeq);
  if (preError) throw preError;
  const { error: curError } = await stepsUpdate('current').eq('seq', entrySeq);
  if (curError) throw curError;
  const { error: postError } = await stepsUpdate('pending').gt('seq', entrySeq);
  if (postError) throw postError;
}

function contactEmail(def: MockDealDef, index: number): string {
  const domain = `${def.targetName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`;
  return `${pick(MOCK_CONTACT_FIRST_NAMES, index)}@${domain}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type Row = Record<string, unknown>;

/** Outbound created_at ladder — shared so inbound replies can anchor AFTER
 *  the original they reference. */
function outboundCreatedAt(now: number, index: number): string {
  return new Date(now - (index + 1) * 5 * HOUR_MS).toISOString();
}

function outboundRows(
  def: MockDealDef,
  dealId: string,
  senderId: string,
  reviewerId: string | null,
  now: number,
): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < def.outboundCount; i += 1) {
    // Deterministic status mix: mostly sent, a few blocked/rejected evidence
    // rows on live deals (pitches stay all-sent). Never 'held' (see header).
    const blocked = def.category === 'live' && i % 9 === 4;
    const rejected = def.category === 'live' && i % 11 === 7;
    const createdAt = outboundCreatedAt(now, i);
    const base = {
      tenant_id: DEV_TENANT_ID,
      deal_id: dealId,
      sender_id: senderId,
      to_emails: [contactEmail(def, i)],
      cc_emails: i % 4 === 0 ? [contactEmail(def, i + 1)] : [],
      bcc_emails: [],
      subject: pick(MOCK_SUBJECTS, i),
      body_html: null,
      attachments: [],
      llm_checked: i % 6 !== 5,
      created_at: createdAt,
    };
    if (blocked) {
      // The evidence row is EXACTLY what the deterministic screener produces.
      const screened = screenMessage(MOCK_BLOCKED_BODY);
      rows.push({
        ...base,
        body: MOCK_BLOCKED_BODY,
        verdict: screened.verdict,
        status: OUTBOX_STATUS.BLOCKED,
        reasons: screened.reasons,
        rewrite: screened.rewrite ?? null,
        provider: null,
      });
    } else if (rejected) {
      const screened = screenMessage(MOCK_REJECTED_BODY);
      rows.push({
        ...base,
        body: MOCK_REJECTED_BODY,
        verdict: screened.verdict,
        status: OUTBOX_STATUS.REJECTED,
        reasons: screened.reasons,
        rewrite: screened.rewrite ?? null,
        provider: null,
        reviewed_by: reviewerId,
        reviewed_at: createdAt,
        review_note: MOCK_REJECTED_NOTE,
      });
    } else {
      rows.push({
        ...base,
        body: pick(MOCK_BODIES, i),
        verdict: 'compliant',
        status: OUTBOX_STATUS.SENT,
        reasons: [],
        rewrite: null,
        provider: 'noop',
        provider_message_id: `mock-${def.codename.toLowerCase()}-${i}`,
      });
    }
  }
  return rows;
}

function inboundRows(def: MockDealDef, dealId: string, now: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < def.inboundCount; i += 1) {
    // The reply references outbound index i+2 (same subject offset) and lands
    // a positive delta AFTER it — a reply never predates its original.
    const originalAt = Date.parse(outboundCreatedAt(now, i + 2));
    const receivedAt = new Date(originalAt + 2 * HOUR_MS).toISOString();
    rows.push({
      tenant_id: DEV_TENANT_ID,
      deal_id: dealId,
      from_email: contactEmail(def, i + 3),
      to_email: `${def.codename.toLowerCase()}@conductia.dev`,
      cc_emails: [],
      subject: `Re: ${pick(MOCK_SUBJECTS, i + 2)}`,
      body: pick(MOCK_BODIES, i + 5),
      body_html: null,
      attachments: [],
      provider: 'noop',
      received_at: receivedAt,
      read_at: i % 3 === 0 ? null : new Date(originalAt + 4 * HOUR_MS).toISOString(),
    });
  }
  return rows;
}

/** Product-shaped audit evidence for the seeded messages (first create only —
 *  see header). Mirrors outbox/route.ts detail shapes. */
function auditRowsFor(messages: Array<{ id: string; row: Row }>, actorId: string, dealId: string): Row[] {
  const rows: Row[] = [];
  for (const { id, row } of messages) {
    const body = row.body as string;
    rows.push({
      actor_id: actorId,
      action: AUDIT_ACTION.SCREEN,
      deal_id: dealId,
      detail: {
        mode: 'full',
        verdict: row.verdict,
        reasons: row.reasons,
        llmChecked: row.llm_checked,
        sha256: sha256(body),
      },
      ts: row.created_at,
    });
    if (row.status === OUTBOX_STATUS.SENT) {
      rows.push({
        actor_id: actorId,
        action: AUDIT_ACTION.SEND,
        deal_id: dealId,
        detail: {
          messageId: id,
          provider: 'noop',
          providerMessageId: row.provider_message_id,
          recipients: (row.to_emails as string[]).length,
          simulated: true,
        },
        ts: row.created_at,
      });
    } else if (row.status === OUTBOX_STATUS.REJECTED) {
      rows.push({
        actor_id: (row.reviewed_by as string | null) ?? actorId,
        action: AUDIT_ACTION.REJECT,
        deal_id: dealId,
        detail: { messageId: id, note: row.review_note },
        ts: row.created_at,
      });
    }
  }
  return rows;
}

/** Whether the deal already carries mock screen evidence — audit is written
 *  once per deal (WORM: re-runs must not accumulate rows). */
async function hasScreenAudit(db: Db, dealId: string): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE.AUDIT_LOG)
    .select('id')
    .eq('deal_id', dealId)
    .eq('action', AUDIT_ACTION.SCREEN)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.[0]?.id);
}

async function resetDealMail(db: Db, dealId: string): Promise<void> {
  const { error: outErr } = await db.from(TABLE.OUTBOUND_MESSAGES).delete().eq('deal_id', dealId);
  if (outErr) throw outErr;
  const { error: inErr } = await db.from(TABLE.INBOUND_MESSAGES).delete().eq('deal_id', dealId);
  if (inErr) throw inErr;
}

/** The RPC fans a 'deal_created' notification to every tenant CCO — for a
 *  mock deal that is live-instrument inflation; remove it each run. */
async function clearMockNotifications(db: Db, dealId: string): Promise<void> {
  const { error } = await db
    .from(TABLE.NOTIFICATIONS)
    .delete()
    .eq('deal_id', dealId)
    .eq('event_type', 'deal_created');
  if (error) throw error;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required');

  const db = createClient(url, key, { auth: { persistSession: false } });
  const wipeMailOnly = process.argv.includes('--wipe-mail');

  // Wipe mode never creates anything — it only needs the owner id to scope.
  let actorId: string | null = await findUserIdByEmail(db, seedEmail(MOCK_BOOK_MD_SLUG));
  if (!wipeMailOnly) {
    if (!password) throw new Error('SEED_PASSWORD is required');
    actorId = await ensureBookMd(db, password);
  }
  if (!actorId) {
    console.log('No book-md user — nothing to wipe.');
    return;
  }

  const now = Date.now();
  let created = 0;
  let reused = 0;
  let reconciled = 0;
  let outbound = 0;
  let inbound = 0;

  let bankId: string | null = null;
  const reviewerId = await findUserIdByEmail(db, seedEmail('cco'));

  for (const def of MOCK_DEALS) {
    const maxSeq = orderedSteps(DEAL_RAIL).at(-1)?.seq ?? 1;
    const entrySeq = Math.min(def.entryStepSeq, maxSeq);

    const existing = await findMockDeal(db, def.codename, actorId);
    let dealId: string;
    let isNew = false;
    if (existing) {
      dealId = existing.id;
      reused += 1;
      if (!wipeMailOnly) {
        if (existing.entrySeq !== entrySeq) {
          console.log(`Reconciling ${def.codename}: entry seq ${existing.entrySeq} -> ${entrySeq}`);
          reconciled += 1;
        }
        await reconcileMockDeal(db, dealId, actorId, entrySeq, def);
      }
    } else if (!wipeMailOnly) {
      bankId = bankId ?? (await bankCompanyId(db));
      await seatBookMdAsDirector(db, actorId, bankId);
      dealId = await createMockDeal(db, def, actorId, bankId, entrySeq);
      // Close date, fee, schedule and category graduated to real columns (#191): the
      // fixture's values are written once at creation so the mock book
      // shows real data.
      const { error: closeError } = await db
        .from(TABLE.DEALS)
        .update({
          target_close_date: def.closeDate,
          fee_usd: def.feeUsd,
          schedule_status: def.scheduleStatus,
          lifecycle_category: def.category,
        })
        .eq('id', dealId);
      if (closeError) throw closeError;
      created += 1;
      isNew = true;
    } else {
      continue;
    }

    await resetDealMail(db, dealId);
    await clearMockNotifications(db, dealId);
    if (wipeMailOnly) continue;

    const out = outboundRows(def, dealId, actorId, reviewerId, now);
    const { data: insertedOut, error: outErr } = await db
      .from(TABLE.OUTBOUND_MESSAGES)
      .insert(out)
      .select('id');
    if (outErr) throw outErr;
    outbound += out.length;

    if (insertedOut && (isNew || !(await hasScreenAudit(db, dealId)))) {
      const paired = insertedOut.map((r: { id: string }, idx: number) => ({ id: r.id, row: out[idx] }));
      const audit = auditRowsFor(paired, actorId, dealId);
      const { error: auditErr } = await db.from(TABLE.AUDIT_LOG).insert(audit);
      if (auditErr) throw auditErr;
    }

    const inb = inboundRows(def, dealId, now);
    const { error: inErr } = await db.from(TABLE.INBOUND_MESSAGES).insert(inb);
    if (inErr) throw inErr;
    inbound += inb.length;
  }

  if (wipeMailOnly) {
    console.log(`Mock mail wiped for ${reused} existing mock deal(s). Deals stay (audit_log is WORM).`);
    return;
  }
  console.log(
    `Mock book ready: ${created} created, ${reused} reused (${reconciled} stage-reconciled), ` +
      `${outbound} outbound + ${inbound} inbound messages.`,
  );
  console.log(`Sign in as ${seedEmail(MOCK_BOOK_MD_SLUG)} to see the full book.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
