// Demo book seed: LOCAL-ONLY demo data, fictional companies and people.
//
// Signs Storm Duncan (md.intelibank@dev.com) into a realistic book so the
// Conductor Center, rail, mail, audit, leads and AI costs can be judged:
//
//   - 12 live mandates owned by Storm (MD seat), spread across all five
//     phases, each created through the real create_deal_gate0 RPC (rail rows
//     with phase_index/display_order, memberships, grant/create/attest/notify
//     audit rows), with a target close date, fee and schedule status written
//     the way the Book PATCH writes them (one `update` audit row per field).
//     Steps are completed through deal_step_save, the step route's RPC, with
//     the route's audit rows (step_work, complete_step, advance) and its
//     notifications; three deals carry a later step completed out of order.
//   - Project Sextant, Morgan Vale's mandate with Storm in a deal-team seat:
//     Morgan assigns Storm two steps (the only honest "Step assigned to you",
//     since only a deal's MD assigns).
//   - Project Summit (SUMMIT-2026-003, from seed:users) multiplayer: steps
//     assigned across Storm, Alex Chen and Morgan Vale, draft work saved by
//     Alex and Morgan, one later step completed out of order by Morgan.
//   - Skill runs with two or more versions on two steps (Fjord's Teaser,
//     Summit's SWOT): execution rows as the skill-runs route records them and
//     revisions through record_skill_run_revision. Ignatious is not
//     configured locally, so the mounted skill names are demo values.
//   - Needs-you notifications for Storm: step assigned (Sextant), compliance
//     hold (Ember), NDA pending (Granite, written by the platform as a service
//     actor), access requests (Jordan Blake, Observer) through the access
//     request path; a legacy held message (Ember) and a queued send (Granite)
//     with their screen/send audit rows and the CCO's queued-send notice; a
//     model-gateway audit row on Granite.
//   - Leads: every mandate's target registered as a lead (type client) before
//     the deal names it, plus three prospects, each with a stakeholder and a
//     relationship (CRM people through upsertCrmPerson).
//   - Recorded AI spend per person across deals (ai_usage, back-dated).
//
// Discovery proposals are not written here: they come from the mail reader
// pipeline, and this script stays out of mailbox-derived tables. Run
// `npm run seed:discovery -- --google-replay --corpus demo` for Storm's
// proposed deals (Kestrel, Harbor, Falcon, Osprey).
//
// Rows with no producer in the app (the CCO-placed compliance hold, the NDA
// reminder's service row, the model's second-opinion row) carry
// `demo: true` in their audit detail, so they never read as genuine events.
//
// Idempotent: every write is guarded by a lookup (deals by owner + code name,
// steps by status/assignee/work, notifications, access requests and messages
// by their keys, skill runs and spend by deterministic ids), so a second run
// writes no deals, steps, audit rows or notifications. audit_log is WORM and
// hash-chained: audit rows are written only alongside the change they record.
//
// Rerun only on an untouched book: after someone has used the UI, a rerun
// fights their changes. To reset, `supabase db reset` then the full run order:
// npm run seed && npm run seed:flags:enable && npm run seed:demo-book &&
// npm run seed:discovery -- --google-replay --corpus demo
//
// Refuses to run unless NEXT_PUBLIC_SUPABASE_URL is a local stack.
// Run after `npm run seed` (users, flags):  npm run seed:demo-book

import { createHash } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { listApproverIds, displayNameFor } from '../src/lib/api/v1/accessRequests';
import { upsertCrmPerson } from '../src/lib/api/v1/crmPeople';
import { screenMessage } from '../src/lib/compliance/screen';
import {
  ACCESS_DESTINATION,
  ACCESS_DESTINATION_DEFS,
  ACCESS_REQUEST_STATUS,
  approverInboxHref,
  type AccessDestination,
} from '../src/lib/constants/accessRequests';
import { AUDIT_ACTION, AUDIT_ACTOR_TYPE, MODEL_GATEWAY_SERVICE_IDENTITY } from '../src/lib/constants/audit';
import { COMPANY_TYPE } from '../src/lib/constants/companies';
import { RAIL_CENSUS_VERSION, SKILL_RUN_SOURCE, STEP_STATUS } from '../src/lib/constants/dealSteps';
import { NOTIFICATION_EVENT } from '../src/lib/constants/notifications';
import { OUTBOX_STATUS, RISK_BAND } from '../src/lib/constants/outbox';
import { TABLE } from '../src/lib/constants/tables';
import { seedDataroomsForDeal } from '../src/lib/dataroom/steps';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { costForUsage } from '../src/lib/ai/pricing';
import { notifyAccessRequested } from '../src/lib/notifications/accessNotifications';
import {
  notifyStepAssigned,
  notifyStepCompleted,
} from '../src/lib/notifications/dealStepNotifications';
import { notifyQueuedSend } from '../src/lib/notifications/mailReviewNotifications';
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep, railSeedRows, stepBySeq } from '../src/lib/rail/dealRail';
import { manualStepDef, validateManualWork } from '../src/lib/rail/manualStepDefs';
import { countBy, digestOf, editsDigest } from '../src/lib/skillRun/revisions';
import {
  COLLEAGUE_DEAL,
  DEMO_DEALS,
  DEMO_SKILL_RUNS,
  DEMO_SPEND,
  HELD_MAIL,
  PROSPECT_LEADS,
  QUEUED_MAIL,
  STEP_SELECT,
  STEP_TEXT,
  SUMMIT_ASSIGNMENTS,
  SUMMIT_BOOK,
  SUMMIT_CODE,
  SUMMIT_DRAFTS,
  SUMMIT_OUT_OF_ORDER,
  type DemoDealDef,
  type DemoLeadDef,
  type DemoSlug,
} from './demo-book-data';
import { assertLocalSupabase } from './lib/localOnly';
import { seedEmail } from './seed-data';

type Db = SupabaseClient;
type Person = { id: string; slug: DemoSlug; name: string; companyId: string | null };
type Deal = { id: string; code: string; codename: string; mdSlug: DemoSlug };
type StepRow = {
  id: string;
  step_id: string;
  seq: number;
  status: string;
  assigned_to: string | null;
  work: Record<string, unknown> | null;
  updated_at: string;
};

const DAY_MS = 86_400_000;
const STEP_COLUMNS = 'id, step_id, seq, status, assigned_to, work, updated_at';
const ALL_STEPS = orderedSteps();

const counts: Record<string, number> = {};
const bump = (key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/** A stable uuid from a demo key, so reruns find what the first run wrote. */
function demoUuid(key: string): string {
  const h = createHash('sha256').update(`conductia-demo-book:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} not found`);
  return value;
}

function stepTitle(stepId: string): string {
  return ALL_STEPS.find((s) => s.id === stepId)?.title ?? stepId;
}

function fill(text: string, ctx: { target: string; codename: string }): string {
  return text.replaceAll('{target}', ctx.target).replaceAll('{codename}', ctx.codename);
}

// ── People ──────────────────────────────────────────────────────────────────

async function loadPeople(db: Db): Promise<Map<DemoSlug, Person>> {
  const slugs: DemoSlug[] = ['md', 'deal-team', 'legal', 'ib-director', 'cco', 'read-only', 'admin'];
  const { data, error } = await db
    .from(TABLE.USERS)
    .select('id, email, display_name, full_name, company_id')
    .in('email', slugs.map(seedEmail));
  if (error) throw error;
  const people = new Map<DemoSlug, Person>();
  for (const slug of slugs) {
    const row = (data ?? []).find((u) => u.email === seedEmail(slug));
    if (!row) throw new Error(`Seed user ${seedEmail(slug)} is missing. Run npm run seed first.`);
    people.set(slug, {
      id: row.id as string,
      slug,
      name: (row.display_name as string | null) ?? (row.full_name as string),
      companyId: (row.company_id as string | null) ?? null,
    });
  }
  return people;
}

// ── Leads ───────────────────────────────────────────────────────────────────

/** The lead registration path (POST /api/v1/companies): a client-type
 *  company registered by the bank, audited as lead_registered. */
async function ensureLead(db: Db, def: DemoLeadDef, registrar: Person, bankId: string): Promise<string> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('type', COMPANY_TYPE.CLIENT)
    .eq('registered_by_company_id', bankId)
    .ilike('name', def.name)
    .limit(1);
  if (error) throw error;
  let companyId = data?.[0]?.id as string | undefined;
  if (!companyId) {
    const { data: created, error: createError } = await db
      .from(TABLE.COMPANIES)
      .insert({ tenant_id: DEV_TENANT_ID, name: def.name, type: COMPANY_TYPE.CLIENT, registered_by_company_id: bankId })
      .select('id, name, type')
      .single();
    if (createError) throw createError;
    companyId = created.id as string;
    const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert({
      actor_id: registrar.id,
      action: AUDIT_ACTION.CREATE,
      detail: { reason: 'lead_registered', company_id: companyId, name: created.name, type: created.type },
    });
    if (auditError) throw auditError;
    bump('leads registered');
  }

  // Stakeholder and relationship, as the lead map routes write them.
  const s = def.stakeholder;
  const { data: haveStakeholder } = await db
    .from(TABLE.LEAD_STAKEHOLDERS)
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', s.name)
    .limit(1);
  if (!haveStakeholder?.length) {
    const personId = await upsertCrmPerson(db, {
      tenantId: DEV_TENANT_ID,
      registeredByCompanyId: bankId,
      name: s.name,
      email: s.email,
      title: s.title,
      org: def.name,
    });
    const { error: sError } = await db.from(TABLE.LEAD_STAKEHOLDERS).insert({
      tenant_id: DEV_TENANT_ID,
      company_id: companyId,
      person_id: personId,
      name: s.name,
      title: s.title,
      org: def.name,
      role_in_decision: s.role,
      equity_pct: s.equityPct,
      motivation: s.motivation,
      stance: s.stance,
      board_seat: s.boardSeat,
      investor: false,
      likely_objections: null,
    });
    if (sError) throw sError;
    bump('lead stakeholders');
  }

  const r = def.relationship;
  const { data: haveRelationship } = await db
    .from(TABLE.LEAD_RELATIONSHIPS)
    .select('id')
    .eq('company_id', companyId)
    .ilike('person_name', r.name)
    .limit(1);
  if (!haveRelationship?.length) {
    const personId = await upsertCrmPerson(db, {
      tenantId: DEV_TENANT_ID,
      registeredByCompanyId: bankId,
      name: r.name,
      email: r.email,
      title: r.title,
      org: r.personCompany,
    });
    const { error: rError } = await db.from(TABLE.LEAD_RELATIONSHIPS).insert({
      tenant_id: DEV_TENANT_ID,
      company_id: companyId,
      person_id: personId,
      person_name: r.name,
      title: r.title,
      person_company: r.personCompany,
      contact_info: r.email,
      relationship_type: r.type,
      strength: r.strength,
      source: r.source,
      confidence: r.strength,
      last_verified: null,
      owner: registrar.name,
      basis: r.basis,
    });
    if (rError) throw rError;
    bump('lead relationships');
  }
  return companyId;
}

// ── Deals ───────────────────────────────────────────────────────────────────

async function findDeal(db: Db, codename: string, ownerId: string): Promise<{ id: string; code: string } | null> {
  const { data, error } = await db
    .from(TABLE.DEALS)
    .select('id, code')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('mandate_owner_id', ownerId)
    .ilike('codename', codename)
    .limit(1);
  if (error) throw error;
  return (data?.[0] as { id: string; code: string } | undefined) ?? null;
}

/** The deal create path (POST /api/v1/deals): create_deal_gate0 with the MVP
 *  rail rows, then the deal's datarooms. Reused when it already exists. */
async function ensureDeal(
  db: Db,
  def: DemoDealDef,
  people: Map<DemoSlug, Person>,
  bankId: string,
  leadId: string,
): Promise<Deal> {
  const owner = must(people.get(def.ownerSlug), def.ownerSlug);
  const existing = await findDeal(db, def.codename, owner.id);
  if (existing) return { ...existing, codename: def.codename, mdSlug: def.ownerSlug };

  const entry = must(stepBySeq(def.entrySeq, MVP_DEAL_RAIL), `entry seq ${def.entrySeq}`);
  const { data, error } = await db.rpc('create_deal_gate0', {
    p_tenant_id: DEV_TENANT_ID,
    p_actor_id: owner.id,
    p_bank_id: bankId,
    p_codename: def.codename,
    p_target_name: null,
    p_target_company_id: leadId,
    p_codename_theme: null,
    p_entry_step_seq: entry.seq,
    p_entry_phase: phaseForStep(entry.id, MVP_DEAL_RAIL)?.index ?? 1,
    p_members: def.members.map((m) => ({ userId: must(people.get(m.slug), m.slug).id, dealRole: m.dealRole })),
    p_screening: { verdict: 'compliant', reasons: [] },
    p_steps: railSeedRows(MVP_DEAL_RAIL),
    p_census_version: RAIL_CENSUS_VERSION,
    p_conflicts: def.conflicts,
  });
  if (error) throw error;
  const deal = (data as { deal: { id: string; code: string } }).deal;
  await seedDataroomsForDeal(db, deal.id);
  bump('deals created');
  console.log(`Created ${def.codename} (${deal.code}).`);
  return { id: deal.id, code: deal.code, codename: def.codename, mdSlug: def.ownerSlug };
}

/** The Book PATCH: write only the fields that differ, one `update` audit row each. */
async function ensureBookFields(
  db: Db,
  deal: Deal,
  actor: Person,
  book: { closeDate: string; feeUsd: number; scheduleStatus: string },
): Promise<void> {
  const { data, error } = await db
    .from(TABLE.DEALS)
    .select('target_close_date, fee_usd, schedule_status')
    .eq('id', deal.id)
    .single();
  if (error) throw error;
  const wanted: Record<string, string | number> = {
    target_close_date: book.closeDate,
    fee_usd: book.feeUsd,
    schedule_status: book.scheduleStatus,
  };
  const before = data as Record<string, unknown>;
  const writes = Object.entries(wanted).filter(([column, value]) =>
    column === 'fee_usd' ? Number(before[column] ?? -1) !== value : before[column] !== value,
  );
  if (writes.length === 0) return;
  const { error: updateError } = await db.from(TABLE.DEALS).update(Object.fromEntries(writes)).eq('id', deal.id);
  if (updateError) throw updateError;
  const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert(
    writes.map(([field, to]) => ({
      actor_id: actor.id,
      action: AUDIT_ACTION.UPDATE,
      deal_id: deal.id,
      detail: { field, from: before[field] == null ? null : field === 'fee_usd' ? Number(before[field]) : before[field], to },
    })),
  );
  if (auditError) throw auditError;
  bump('book fields set', writes.length);
}

// ── Steps (the step route's writes, through deal_step_save) ───────────────────

async function loadStep(db: Db, dealId: string, seq: number): Promise<StepRow> {
  const stepId = must(stepBySeq(seq, MVP_DEAL_RAIL), `rail seq ${seq}`).id;
  const { data, error } = await db
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq('deal_id', dealId)
    .eq('step_id', stepId)
    .single();
  if (error) throw error;
  return data as StepRow;
}

async function saveStep(
  db: Db,
  deal: Deal,
  step: StepRow,
  actor: Person,
  patch: Record<string, unknown>,
  audits: Array<{ action: string; detail: Record<string, unknown> }>,
  advance: boolean,
): Promise<void> {
  const { error } = await db.rpc('deal_step_save', {
    p_deal_id: deal.id,
    p_step_id: step.id,
    p_actor_id: actor.id,
    p_patch: { ...patch, updated_at: new Date().toISOString() },
    p_expected_updated_at: step.updated_at,
    p_audits: audits,
    p_advance: advance,
  });
  if (error) throw new Error(`deal_step_save ${deal.codename} ${step.step_id}: ${error.message}`);
}

/** PATCH {assignTo}: MD only; notifies the assignee unless self-assigned. */
async function assignStep(db: Db, deal: Deal, seq: number, md: Person, to: Person): Promise<void> {
  const step = await loadStep(db, deal.id, seq);
  if (step.assigned_to === to.id) return;
  const title = stepTitle(step.step_id);
  await saveStep(
    db,
    deal,
    step,
    md,
    { assigned_to: to.id, assigned_by: md.id, assigned_at: new Date().toISOString() },
    [{ action: AUDIT_ACTION.ASSIGN_STEP, detail: { stepId: step.step_id, stepTitle: title, assignee: to.id } }],
    false,
  );
  bump('steps assigned');
  if (to.id !== md.id) {
    await notifyStepAssigned(db, {
      tenantId: DEV_TENANT_ID,
      dealId: deal.id,
      actorId: md.id,
      assigneeId: to.id,
      dealCode: deal.code,
      codename: deal.codename,
      stepId: step.step_id,
      stepTitle: title,
      actorName: md.name,
    });
    bump('notifications: step_assigned');
  }
}

/** Required manual-step answers the route validates before a completion. */
function completionWork(stepId: string, ctx: { target: string; codename: string }): Record<string, unknown> {
  const def = manualStepDef(stepId);
  if (!def) return {};
  if (def.uploadRequired) throw new Error(`${stepId} needs a dataroom upload to complete; pick another step`);
  const work: Record<string, unknown> = {};
  for (const field of def.fields) {
    if (!field.required) continue;
    if (field.type === 'checkbox') work[field.id] = true;
    else if (field.type === 'select') work[field.id] = STEP_SELECT[field.id] ?? field.options?.[0];
    else work[field.id] = fill(STEP_TEXT[field.id] ?? `${field.label}: recorded for {codename}.`, ctx);
  }
  const problem = validateManualWork(def, work);
  if (problem) throw new Error(`${stepId}: ${problem}`);
  return work;
}

/** PATCH {work, complete: true}: work merged, completed, rail advanced when it
 *  is the current step; the MD hears about it when someone else completes. */
async function completeStep(
  db: Db,
  deal: Deal,
  seq: number,
  actor: Person,
  md: Person,
  ctx: { target: string; codename: string },
  expect: 'current' | 'later',
): Promise<void> {
  const step = await loadStep(db, deal.id, seq);
  if (step.status === STEP_STATUS.COMPLETE) return;
  if (expect === 'current' && step.status !== STEP_STATUS.CURRENT) {
    throw new Error(`${deal.codename}: seq ${seq} is ${step.status}, expected current (fixture order)`);
  }
  if (expect === 'later' && step.status !== STEP_STATUS.PENDING) {
    throw new Error(`${deal.codename}: seq ${seq} is ${step.status}, expected a pending later step`);
  }
  if (actor.id !== md.id) await assignStep(db, deal, seq, md, actor);
  const fresh = await loadStep(db, deal.id, seq);
  const title = stepTitle(fresh.step_id);
  const work = completionWork(fresh.step_id, ctx);
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const patch: Record<string, unknown> = {
    status: STEP_STATUS.COMPLETE,
    completed_by: actor.id,
    completed_at: new Date().toISOString(),
    completion_note: null,
  };
  if (Object.keys(work).length > 0) {
    patch.work = { ...(fresh.work ?? {}), ...work };
    audits.push({ action: AUDIT_ACTION.STEP_WORK, detail: { stepId: fresh.step_id, fields: Object.keys(work) } });
  }
  audits.push({ action: AUDIT_ACTION.COMPLETE_STEP, detail: { stepId: fresh.step_id, stepTitle: title, seq: fresh.seq } });
  await saveStep(db, deal, fresh, actor, patch, audits, true);
  bump(expect === 'later' ? 'steps completed out of order' : 'steps completed');
  if (actor.id !== md.id) {
    await notifyStepCompleted(db, {
      tenantId: DEV_TENANT_ID,
      dealId: deal.id,
      actorId: actor.id,
      recipientId: md.id,
      dealCode: deal.code,
      codename: deal.codename,
      stepId: fresh.step_id,
      stepTitle: title,
      completedBy: actor.name,
    });
    bump('notifications: step_completed');
  }
}

/** PATCH {work}: a draft save, no completion. Skipped when already saved. */
async function saveDraft(db: Db, deal: Deal, seq: number, actor: Person, work: Record<string, unknown>): Promise<void> {
  const step = await loadStep(db, deal.id, seq);
  const current = step.work ?? {};
  if (Object.entries(work).every(([k, v]) => current[k] === v)) return;
  await saveStep(
    db,
    deal,
    step,
    actor,
    { work: { ...current, ...work } },
    [{ action: AUDIT_ACTION.STEP_WORK, detail: { stepId: step.step_id, fields: Object.keys(work) } }],
    false,
  );
  bump('draft saves');
}

async function currentSeq(db: Db, dealId: string): Promise<number> {
  const { data, error } = await db.from(TABLE.DEALS).select('current_step_seq').eq('id', dealId).single();
  if (error) throw error;
  return data.current_step_seq as number;
}

async function walkDeal(db: Db, def: DemoDealDef, deal: Deal, people: Map<DemoSlug, Person>): Promise<void> {
  const md = must(people.get(def.ownerSlug), def.ownerSlug);
  const ctx = { target: def.lead.name, codename: def.codename };
  for (const act of def.complete) {
    await completeStep(db, deal, act.seq, must(people.get(act.by ?? def.ownerSlug), 'actor'), md, ctx, 'current');
  }
  for (const act of def.outOfOrder ?? []) {
    await completeStep(db, deal, act.seq, must(people.get(act.by ?? def.ownerSlug), 'actor'), md, ctx, 'later');
  }
  if (def.assignCurrentTo) {
    await assignStep(db, deal, await currentSeq(db, deal.id), md, must(people.get(def.assignCurrentTo), 'assignee'));
  }
  for (const a of def.assign ?? []) {
    await assignStep(db, deal, a.seq, md, must(people.get(a.to), a.to));
  }
}

// ── Notifications Storm acts on ───────────────────────────────────────────────

async function hasNotification(db: Db, dealId: string | null, recipientId: string, eventType: string): Promise<boolean> {
  let q = db.from(TABLE.NOTIFICATIONS).select('id').eq('recipient_id', recipientId).eq('event_type', eventType);
  q = dealId ? q.eq('deal_id', dealId) : q.is('deal_id', null);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

/** A compliance hold on Ember attributed to the CCO, mirrored in audit_log
 *  the way createDealNotification does. No app path produces this event yet,
 *  so the audit detail carries the demo marker. */
async function ensureComplianceHold(db: Db, deal: Deal, storm: Person, cco: Person): Promise<void> {
  if (await hasNotification(db, deal.id, storm.id, NOTIFICATION_EVENT.COMPLIANCE_HOLD)) return;
  const { error } = await db.from(TABLE.NOTIFICATIONS).insert({
    tenant_id: DEV_TENANT_ID,
    deal_id: deal.id,
    recipient_id: storm.id,
    event_type: NOTIFICATION_EVENT.COMPLIANCE_HOLD,
    payload: {
      code: deal.code,
      codename: deal.codename,
      actor: cco.name,
      stepTitle: 'Valuation email held for compliance review',
      href: `/projects/${deal.id}/mail?folder=held`,
    },
  });
  if (error) throw error;
  const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert({
    actor_id: cco.id,
    action: AUDIT_ACTION.NOTIFY,
    deal_id: deal.id,
    detail: { recipient: storm.id, event: NOTIFICATION_EVENT.COMPLIANCE_HOLD, demo: true },
  });
  if (auditError) throw auditError;
  bump('notifications: compliance_hold');
}

/** NDA pending on Granite's Buyer NDA step, sent by the platform (a service
 *  actor, so the audit row carries service_identity, not a person). */
async function ensureNdaPending(db: Db, deal: Deal, storm: Person): Promise<void> {
  if (await hasNotification(db, deal.id, storm.id, NOTIFICATION_EVENT.NDA_PENDING)) return;
  const step = must(stepBySeq(42, MVP_DEAL_RAIL), 'seq 42');
  const { error } = await db.from(TABLE.NOTIFICATIONS).insert({
    tenant_id: DEV_TENANT_ID,
    deal_id: deal.id,
    recipient_id: storm.id,
    event_type: NOTIFICATION_EVENT.NDA_PENDING,
    payload: {
      code: deal.code,
      codename: deal.codename,
      stepId: step.id,
      stepTitle: 'Buyer NDA: 3 bidders have not countersigned',
    },
  });
  if (error) throw error;
  const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert({
    actor_id: null,
    actor_type: AUDIT_ACTOR_TYPE.SERVICE,
    service_identity: 'conductia',
    action: AUDIT_ACTION.NOTIFY,
    deal_id: deal.id,
    detail: { recipient: storm.id, event: NOTIFICATION_EVENT.NDA_PENDING, service: 'nda-tracker', demo: true },
  });
  if (auditError) throw auditError;
  bump('notifications: nda_pending');
  bump('service audit rows');
}

/** POST /api/v1/access-requests as the requester: one pending request per
 *  destination, every approver (Storm among the directors) notified. */
async function ensureAccessRequest(db: Db, requester: Person, destination: AccessDestination): Promise<void> {
  const companyId = must(requester.companyId, `${requester.slug} company`);
  const dest = ACCESS_DESTINATION_DEFS[destination];
  const { data: existing, error } = await db
    .from(TABLE.ACCESS_REQUESTS)
    .select('id')
    .eq('company_id', companyId)
    .eq('requester_id', requester.id)
    .eq('destination', dest.id)
    .eq('status', ACCESS_REQUEST_STATUS.PENDING)
    .maybeSingle();
  if (error) throw error;
  if (existing) return;
  const { data: created, error: createError } = await db
    .from(TABLE.ACCESS_REQUESTS)
    .insert({
      company_id: companyId,
      requester_id: requester.id,
      destination: dest.id,
      permission_key: dest.permission,
      status: ACCESS_REQUEST_STATUS.PENDING,
    })
    .select('id')
    .single();
  if (createError) throw createError;
  const approverIds = (await listApproverIds(db, companyId)).filter((id) => id !== requester.id);
  await notifyAccessRequested(db, {
    tenantId: DEV_TENANT_ID,
    approverIds,
    requesterName: displayNameFor({ display_name: requester.name, full_name: requester.name }),
    destinationLabel: dest.label,
    href: approverInboxHref(companyId),
    requestId: created.id as string,
    companyId,
  });
  bump('access requests');
  bump('notifications: access_requested', approverIds.length);
}

// ── Mail that reached supervision ───────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function findMessage(db: Db, senderId: string, key: string): Promise<string | null> {
  const { data, error } = await db
    .from(TABLE.OUTBOUND_MESSAGES)
    .select('id')
    .eq('sender_id', senderId)
    .eq('client_request_id', key)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

/** A legacy held message (status 'held'): screened, routed to the supervisory
 *  queue, nothing sent. The outbox no longer produces these; old rows keep
 *  their review flow, which is what the Held folder shows. */
async function ensureHeldMessage(db: Db, deal: Deal, sender: Person): Promise<void> {
  if (await findMessage(db, sender.id, HELD_MAIL.key)) return;
  const screened = screenMessage(HELD_MAIL.body);
  if (screened.verdict !== 'hold') throw new Error(`Held mail fixture screened ${screened.verdict}, expected hold`);
  const { data, error } = await db
    .from(TABLE.OUTBOUND_MESSAGES)
    .insert({
      tenant_id: DEV_TENANT_ID,
      deal_id: deal.id,
      sender_id: sender.id,
      to_emails: HELD_MAIL.to,
      subject: HELD_MAIL.subject,
      body: HELD_MAIL.body,
      verdict: screened.verdict,
      reasons: screened.reasons,
      rewrite: screened.rewrite ?? null,
      llm_checked: false,
      status: OUTBOX_STATUS.HELD,
      recipient_boundary: 'external',
      client_request_id: HELD_MAIL.key,
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert({
    actor_id: sender.id,
    action: AUDIT_ACTION.SCREEN,
    deal_id: deal.id,
    detail: {
      mode: 'full',
      recipientBoundary: 'external',
      verdict: screened.verdict,
      reasons: screened.reasons,
      llmChecked: false,
      messageId: data.id,
      sha256: sha256(HELD_MAIL.body),
    },
  });
  if (auditError) throw auditError;
  bump('outbound: held');
}

/** The current send path: risk issues, sent as-is, Queued band, the CCO and
 *  admin notified after the send (#94). Plus the model's second opinion as
 *  its own model-gateway audit row. */
async function ensureQueuedSend(db: Db, deal: Deal, sender: Person): Promise<void> {
  if (await findMessage(db, sender.id, QUEUED_MAIL.key)) return;
  const screened = screenMessage(QUEUED_MAIL.body);
  if (screened.verdict === 'compliant') throw new Error('Queued mail fixture screened compliant, expected a risk issue');
  const shaHex = sha256(QUEUED_MAIL.body);
  const { error: screenError } = await db.from(TABLE.AUDIT_LOG).insert({
    actor_id: sender.id,
    action: AUDIT_ACTION.SCREEN,
    deal_id: deal.id,
    detail: {
      mode: 'full',
      recipientBoundary: 'external',
      verdict: screened.verdict,
      reasons: screened.reasons,
      llmChecked: false,
      sentAsIs: true,
      riskBand: RISK_BAND.QUEUED,
      sha256: shaHex,
    },
  });
  if (screenError) throw screenError;
  const providerMessageId = `demo-${QUEUED_MAIL.key}`;
  const { data, error } = await db
    .from(TABLE.OUTBOUND_MESSAGES)
    .insert({
      tenant_id: DEV_TENANT_ID,
      deal_id: deal.id,
      sender_id: sender.id,
      to_emails: QUEUED_MAIL.to,
      subject: QUEUED_MAIL.subject,
      body: QUEUED_MAIL.body,
      verdict: screened.verdict,
      reasons: screened.reasons,
      rewrite: screened.rewrite ?? null,
      llm_checked: false,
      status: OUTBOX_STATUS.SENT,
      risk_band: RISK_BAND.QUEUED,
      recipient_boundary: 'external',
      provider: 'noop',
      provider_message_id: providerMessageId,
      client_request_id: QUEUED_MAIL.key,
    })
    .select('id')
    .single();
  if (error) throw error;
  const messageId = data.id as string;
  const { error: sendError } = await db.from(TABLE.AUDIT_LOG).insert([
    {
      actor_id: sender.id,
      action: AUDIT_ACTION.SEND,
      deal_id: deal.id,
      detail: {
        messageId,
        provider: 'noop',
        providerMessageId,
        recipients: QUEUED_MAIL.to.length,
        recipientBoundary: 'external',
        simulated: true,
        sentAsIs: true,
      },
    },
    {
      actor_id: null,
      actor_type: AUDIT_ACTOR_TYPE.MODEL,
      service_identity: MODEL_GATEWAY_SERVICE_IDENTITY,
      action: AUDIT_ACTION.SCREEN,
      deal_id: deal.id,
      detail: { mode: 'second_opinion', messageId, outcome: 'escalated', model: 'claude-haiku-4-5', sha256: shaHex, demo: true },
    },
  ]);
  if (sendError) throw sendError;
  await notifyQueuedSend(db, { tenantId: DEV_TENANT_ID, senderId: sender.id, messageId, dealId: deal.id });
  bump('outbound: queued send');
  bump('model audit rows');
}

// ── Skill runs with versions ─────────────────────────────────────────────────

async function ensureSkillRun(
  db: Db,
  def: (typeof DEMO_SKILL_RUNS)[number],
  deal: Deal,
  people: Map<DemoSlug, Person>,
): Promise<void> {
  const step = await loadStep(db, deal.id, def.seq);
  const title = stepTitle(step.step_id);
  const runner = must(people.get(def.by), def.by);
  const digest = digestOf(`${def.mount.name}@${def.mount.version}`);
  const reference = { kind: 'mount', name: def.mount.name, version: def.mount.version, digest };
  const rootId = demoUuid(`${def.key}:root`);
  const startedAt = new Date(Date.now() - 5 * DAY_MS).toISOString();

  const { data: haveRoot } = await db.from(TABLE.DEAL_STEP_SKILL_RUNS).select('id').eq('id', rootId).maybeSingle();
  if (!haveRoot) {
    const { error } = await db.from(TABLE.DEAL_STEP_SKILL_RUNS).insert({
      id: rootId,
      deal_id: deal.id,
      deal_step_id: step.id,
      actor_id: runner.id,
      skill_id: null,
      version_id: null,
      mount_name: def.mount.name,
      mount_version: def.mount.version,
      digest,
      model: def.model,
      clamped_from: null,
      source: SKILL_RUN_SOURCE.EXECUTION,
      input: def.instructions,
      inputs: {},
      outcome: 'succeeded',
      result_text: def.result,
      error_message: null,
      provider_run_id: `demo-${def.key}`,
      cost_usd: def.costUsd,
      started_at: startedAt,
    });
    if (error) throw error;
    const { error: auditError } = await db.from(TABLE.AUDIT_LOG).insert({
      actor_id: runner.id,
      action: AUDIT_ACTION.CREATE,
      deal_id: deal.id,
      detail: {
        kind: 'skill_run',
        stepKey: step.step_id,
        title,
        dealStepId: step.id,
        runId: rootId,
        reference,
        model: def.model,
        clampedFrom: null,
        outcome: 'succeeded',
      },
    });
    if (auditError) throw auditError;
    bump('skill runs');
  }
  await ensureSpendRow(db, {
    source: 'skill_run',
    externalId: rootId,
    dealId: deal.id,
    actorId: runner.id,
    task: step.step_id,
    model: def.model,
    costUsd: def.costUsd,
    at: startedAt,
  });

  let parent = { id: rootId, text: def.result };
  for (const [index, rev] of def.revisions.entries()) {
    const revisionId = demoUuid(`${def.key}:rev${index + 1}`);
    const start = parent.text.indexOf(rev.passage);
    if (start < 0) throw new Error(`${def.key} revision ${index + 1}: passage not in the parent text`);
    const end = start + rev.passage.length;
    const text = parent.text.slice(0, start) + rev.replacement + parent.text.slice(end);
    const actor = must(people.get(rev.by), rev.by);
    const at = new Date(Date.now() - (4 - index) * DAY_MS).toISOString();
    const { data: haveRev } = await db.from(TABLE.DEAL_STEP_SKILL_RUNS).select('id').eq('id', revisionId).maybeSingle();
    if (!haveRev) {
      const editId = demoUuid(`${def.key}:rev${index + 1}:edit`);
      const request = [{ kind: 'comment' as const, start, end, comment: rev.comment }];
      const inputs = {
        kind: 'edits',
        edits: [
          {
            id: editId,
            kind: 'comment',
            start,
            end,
            comment: rev.comment,
            status: 'applied',
            resultStart: start,
            resultEnd: start + rev.replacement.length,
          },
        ],
        skillMounted: true,
      };
      const base = {
        kind: 'skill_run_revision',
        stepKey: step.step_id,
        title,
        dealStepId: step.id,
        rootRunId: rootId,
        parentRunId: parent.id,
      };
      const { error: startedError } = await db.from(TABLE.AUDIT_LOG).insert({
        actor_id: actor.id,
        action: AUDIT_ACTION.CREATE,
        deal_id: deal.id,
        detail: { ...base, phase: 'started', revisionId, edits: countBy(['comment']), editsDigest: editsDigest(request) },
      });
      if (startedError) throw startedError;
      const { error } = await db.rpc('record_skill_run_revision', {
        p_run: {
          id: revisionId,
          deal_id: deal.id,
          deal_step_id: step.id,
          actor_id: actor.id,
          source: SKILL_RUN_SOURCE.REVISION,
          parent_run_id: parent.id,
          root_run_id: rootId,
          skill_id: null,
          version_id: null,
          mount_name: def.mount.name,
          mount_version: def.mount.version,
          digest,
          inputs,
          outcome: 'succeeded',
          result_text: text,
          error_message: null,
          model: def.model,
          cost_usd: rev.costUsd,
          provider_run_id: `demo-${def.key}-rev${index + 1}`,
          started_at: at,
        },
        p_audit: {
          ...base,
          phase: 'recorded',
          revisionId,
          revisionKind: 'edits',
          outcome: 'succeeded',
          edits: countBy(['applied']),
          model: def.model,
          resultDigest: digestOf(text),
        },
      });
      if (error) throw error;
      bump('skill run revisions');
    }
    await ensureSpendRow(db, {
      source: 'skill_revision',
      externalId: revisionId,
      dealId: deal.id,
      actorId: actor.id,
      task: step.step_id,
      model: def.model,
      costUsd: rev.costUsd,
      at,
    });
    parent = { id: revisionId, text };
  }
}

// ── AI spend ledger ──────────────────────────────────────────────────────────

/** The ledger row recordAiUsage writes, keyed (source, external_id) so a
 *  rerun inserts nothing; created_at back-dated so the page shows a month. */
async function ensureSpendRow(
  db: Db,
  row: {
    source: string;
    externalId: string;
    dealId: string | null;
    companyId?: string | null;
    actorId: string;
    task: string;
    model: string;
    costUsd?: number;
    usage?: { inputTokens: number; outputTokens: number };
    at: string;
  },
): Promise<void> {
  const cost =
    typeof row.costUsd === 'number'
      ? row.costUsd
      : row.usage
        ? costForUsage(row.model, { ...row.usage, cacheReadTokens: 0, cacheWriteTokens: 0 })
        : null;
  const { data, error } = await db
    .from(TABLE.AI_USAGE)
    .upsert(
      {
        tenant_id: DEV_TENANT_ID,
        deal_id: row.dealId,
        company_id: row.companyId ?? null,
        actor_id: row.actorId,
        source: row.source,
        task: row.task,
        model: row.model,
        input_tokens: row.usage?.inputTokens ?? null,
        output_tokens: row.usage?.outputTokens ?? null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        cost_usd: cost,
        external_id: row.externalId,
        created_at: row.at,
      },
      { onConflict: 'source,external_id', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw error;
  if (data?.length) bump('ai spend rows');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  assertLocalSupabase(url, process.env.NEXT_PUBLIC_APP_ENV);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY must be set');
  const db = createClient(url!, key, { auth: { persistSession: false } });

  const people = await loadPeople(db);
  const storm = must(people.get('md'), 'md');
  const bankId = must(storm.companyId, 'Storm company');

  // Leads first: a mandate names its registered lead as the target.
  const deals = new Map<string, Deal>();
  const leadIds = new Map<string, string>();
  for (const def of [...DEMO_DEALS, COLLEAGUE_DEAL]) {
    const registrar = must(people.get(def.ownerSlug), def.ownerSlug);
    const leadId = await ensureLead(db, def.lead, registrar, bankId);
    leadIds.set(def.lead.name, leadId);
    const deal = await ensureDeal(db, def, people, bankId, leadId);
    deals.set(def.codename, deal);
    await ensureBookFields(db, deal, registrar, def.book);
    await walkDeal(db, def, deal, people);
  }
  for (const def of PROSPECT_LEADS) leadIds.set(def.name, await ensureLead(db, def, storm, bankId));

  // Summit multiplayer.
  const { data: summitRow, error: summitError } = await db
    .from(TABLE.DEALS)
    .select('id, code, codename')
    .eq('code', SUMMIT_CODE)
    .maybeSingle();
  if (summitError) throw summitError;
  if (!summitRow) throw new Error(`${SUMMIT_CODE} is missing. Run npm run seed first.`);
  const summit: Deal = { id: summitRow.id as string, code: summitRow.code as string, codename: summitRow.codename as string, mdSlug: 'md' };
  await ensureBookFields(db, summit, storm, SUMMIT_BOOK);
  for (const a of SUMMIT_ASSIGNMENTS) await assignStep(db, summit, a.seq, storm, must(people.get(a.to), a.to));
  for (const d of SUMMIT_DRAFTS) await saveDraft(db, summit, d.seq, must(people.get(d.by), d.by), d.work);
  await completeStep(
    db,
    summit,
    SUMMIT_OUT_OF_ORDER.seq,
    must(people.get(SUMMIT_OUT_OF_ORDER.by ?? 'md'), 'actor'),
    storm,
    { target: 'Databricks', codename: summit.codename },
    'later',
  );

  const dealFor = (ref: { codename: string } | { code: string }): Deal =>
    'code' in ref ? summit : must(deals.get(ref.codename), ref.codename);

  // Skill runs with versions.
  for (const def of DEMO_SKILL_RUNS) await ensureSkillRun(db, def, dealFor(def.deal), people);

  // Notifications that put work on Storm's desk.
  const cco = must(people.get('cco'), 'cco');
  await ensureComplianceHold(db, must(deals.get(HELD_MAIL.deal), HELD_MAIL.deal), storm, cco);
  await ensureNdaPending(db, must(deals.get(QUEUED_MAIL.deal), QUEUED_MAIL.deal), storm);
  await ensureAccessRequest(db, must(people.get('legal'), 'legal'), ACCESS_DESTINATION.LEADS);
  await ensureAccessRequest(db, must(people.get('read-only'), 'read-only'), ACCESS_DESTINATION.RAIL_TEMPLATES);

  // Mail that reached supervision.
  await ensureHeldMessage(db, must(deals.get(HELD_MAIL.deal), HELD_MAIL.deal), storm);
  await ensureQueuedSend(db, must(deals.get(QUEUED_MAIL.deal), QUEUED_MAIL.deal), storm);

  // Recorded AI spend per person.
  for (const s of DEMO_SPEND) {
    await ensureSpendRow(db, {
      source: s.source,
      externalId: `demo-book:${s.key}`,
      dealId: s.deal ? dealFor(s.deal).id : null,
      companyId: s.lead ? must(leadIds.get(s.lead), s.lead) : null,
      actorId: must(people.get(s.by), s.by).id,
      task: s.task,
      model: s.model,
      usage: { inputTokens: s.inputTokens, outputTokens: s.outputTokens },
      at: new Date(Date.now() - s.daysAgo * DAY_MS).toISOString(),
    });
  }

  // Summary.
  const { count: stormDeals } = await db
    .from(TABLE.DEAL_MEMBERSHIPS)
    .select('deal_id', { count: 'exact', head: true })
    .eq('user_id', storm.id);
  const { count: stormUnread } = await db
    .from(TABLE.NOTIFICATIONS)
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', storm.id)
    .is('read_at', null)
    .in('event_type', [
      NOTIFICATION_EVENT.STEP_ASSIGNED,
      NOTIFICATION_EVENT.COMPLIANCE_HOLD,
      NOTIFICATION_EVENT.NDA_PENDING,
      NOTIFICATION_EVENT.ACCESS_REQUESTED,
    ]);
  const wrote = Object.entries(counts);
  console.log(wrote.length ? `\nWrote: ${wrote.map(([k, v]) => `${k} ${v}`).join(', ')}.` : '\nNothing to write: the demo book is already in place.');
  console.log(`Storm sits on ${stormDeals ?? 0} deals with ${stormUnread ?? 0} unread needs-you notifications.`);
  console.log('Discovery proposals come from: npm run seed:discovery -- --google-replay --corpus demo');
  console.log(`Sign in as ${seedEmail('md')}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
