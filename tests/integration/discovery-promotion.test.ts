import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Deal discovery, phase 9 (promotion and the rail marker), against a REAL database:
 *
 *   demo corpus -> runOnce -> runExtractOnce (the model double) -> POST
 *   /api/v1/deals/from-discovery as Alice (Gate 0 through discovery_promote_candidate)
 *   -> the late mail (DISCOVERY_FIXTURE_DIR = the late superset) -> runOnce ->
 *   runExtractOnce -> GET /api/v1/discovery/suggestions -> PATCH /progress.
 *
 * What is real: the classification worker, the extract loop, the Supabase store,
 * the route handlers, the promotion definer and Gate 0's core, the upsert, RLS,
 * Postgres. What is faked: the model (a test-owned double; T2's recordings do not
 * exist yet) and how a handler obtains the signed-in client (the cookie layer
 * needs Next). company_access_management is switched on for the file, so
 * deal-create authority is real: Alice (a director) holds it, the colleague and
 * Bob (members) do not. No Box call is made: the promotion route never provisions
 * a data room.
 */

import { createDiscoveryTenant, DEMO_LATE_MAIL_DIRECTORY, type Persona } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('pm');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { PATCH as progressRoute } from '@/app/api/v1/deals/[dealId]/progress/route';
import { POST as promoteRoute } from '@/app/api/v1/deals/from-discovery/route';
import { GET as listRoute } from '@/app/api/v1/discovery/candidates/route';
import { POST as dismissRoute } from '@/app/api/v1/discovery/suggestions/dismiss/route';
import { GET as suggestionsRoute } from '@/app/api/v1/discovery/suggestions/route';
import { runExtractOnce } from '@/lib/discovery/extract/run';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import { MVP_DEAL_RAIL, railSeedRows } from '@/lib/rail/dealRail';
import type { ModelTransport } from '@/lib/modelGateway/transports';
import { DEMO_REPLY_TABLE } from '../helpers/demoReplyTable';
import { modelReplyDouble } from '../helpers/modelReplyDouble';

const { db, tenantId } = harness;
// The harness tenant is not synthetic, so the gate replays for it only on loopback: pass the local stack's URL alone.
const GATE_ENV = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL };
const store = supabaseExtractStore(db);

const SEEDED = railSeedRows(MVP_DEAL_RAIL);
const ENTRY_SEQ = 48; // LOI Review, step 44
const today = () => new Date().toISOString().slice(0, 10);

type Candidate = { id: string; name: string };

async function list(persona: Persona): Promise<Candidate[]> {
  harness.sessionFor(persona);
  const res = await listRoute();
  expect(res.status).toBe(200);
  return (await res.json()).candidates as Candidate[];
}

async function idOf(persona: Persona, name: string): Promise<string> {
  const found = (await list(persona)).find((c) => c.name === name);
  if (!found) throw new Error(`${persona} does not see ${name}`);
  return found.id;
}

async function promote(persona: Persona, candidateId: string, extra: Record<string, unknown> = {}) {
  harness.sessionFor(persona);
  const res = await promoteRoute(
    new Request('http://localhost/api/v1/deals/from-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId,
        codename: 'Project Kestrel',
        targetName: 'Northwind Robotics',
        entryStepSeq: ENTRY_SEQ,
        conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: today() },
        ...extra,
      }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function suggestion(persona: Persona, code: string) {
  harness.sessionFor(persona);
  const res = await suggestionsRoute(new Request(`http://localhost/api/v1/discovery/suggestions?deal=${code}`));
  expect(res.status).toBe(200);
  return (await res.json()).suggestion as null | {
    assessmentId: string;
    stepId: string;
    reason: string;
    evidenceCount: number;
    dismissed: boolean;
    flags: string[];
  };
}

async function dismiss(persona: Persona, body: Record<string, unknown>) {
  harness.sessionFor(persona);
  const res = await dismissRoute(
    new Request('http://localhost/api/v1/discovery/suggestions/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function moveRail(persona: Persona, code: string, currentStepSeq: number) {
  harness.sessionFor(persona);
  const res = await progressRoute(
    new Request(`http://localhost/api/v1/deals/${code}/progress`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStepSeq }),
    }),
    { params: Promise.resolve({ dealId: code }) },
  );
  return { status: res.status, body: await res.json() };
}

/** The model double answers by Message-ID; the store addresses items by uuid, so translate. */
async function doubleByUuid(): Promise<ModelTransport & { sent: string[] }> {
  const { data, error } = await db.from('source_items').select('id, internet_message_id').eq('tenant_id', tenantId);
  if (error) throw new Error(`item lookup failed: ${error.message}`);
  const messageIdOf = new Map((data ?? []).map((r) => [r.id as string, r.internet_message_id as string]));
  const inner = modelReplyDouble(DEMO_REPLY_TABLE);
  return {
    kind: 'recorded',
    get sent() {
      return inner.sent;
    },
    send: (req) =>
      inner.send(
        req.purpose === 'milestone_extract'
          ? { ...req, sourceItemId: messageIdOf.get(req.sourceItemId) ?? req.sourceItemId }
          : req,
      ),
  };
}

const extract = async () => runExtractOnce({ tenantId, transport: await doubleByUuid(), store, env: GATE_ENV });

const linkCount = async (candidateId: string) =>
  (await db.from('evidence_links').select('*', { count: 'exact', head: true }).eq('candidate_id', candidateId)).count ?? 0;

/** The deals a promotion made: every deal of the tenant but the fixture deal that seats the mailbox owners. */
const promotedDeals = async () =>
  (await db.from('deals').select('id').eq('tenant_id', tenantId).neq('id', harness.fixtureDealId)).data;

let previousFlag: { enabled: boolean } | null = null;

beforeAll(async () => {
  await harness.setup();
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'company_access_management').maybeSingle();
  previousFlag = data as { enabled: boolean } | null;
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'company_access_management', description: 'company access (integration)', enabled: true }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
});

afterAll(async () => {
  if (previousFlag) await db.from('feature_flags').update({ enabled: previousFlag.enabled }).eq('key', 'company_access_management');
  else await db.from('feature_flags').delete().eq('key', 'company_access_management');
  await harness.cleanup();
});

describe('promotion opens the mandate, and the rail marker follows late mail', () => {
  let kestrel = '';
  let osprey = '';
  let deal = { id: '', code: '' };

  it('classifies and extracts the demo corpus: Kestrel suggests step 44', async () => {
    await harness.seedDemo();
    expect(await extract()).toMatchObject({ invalid: 0, failed: 0 });
    kestrel = await idOf('alice', 'Project Kestrel');
    osprey = await idOf('alice', 'Project Osprey');
    const { data } = await db.from('stage_assessments').select('step_id, station').eq('candidate_id', kestrel);
    expect(data).toEqual([{ step_id: 'p4-s48', station: 44 }]);
  });

  it('refuses the colleague (403: sees the candidate, cannot create deals) and Bob (404: sees nothing)', async () => {
    expect((await idOf('colleague', 'Project Kestrel'))).toBe(kestrel);
    expect(await promote('colleague', kestrel)).toEqual({ status: 403, body: { error: 'Not permitted to create deals' } });
    expect(await promote('bob', kestrel)).toEqual({ status: 404, body: { error: 'Proposed deal not found' } });
    expect(await promote('admin', kestrel)).toEqual({ status: 404, body: { error: 'Proposed deal not found' } });
    expect(await promotedDeals()).toEqual([]);
  });

  it('refuses a direct call to the promotion RPC from a signed-in session, whoever it names', async () => {
    const alice = harness.sessionFor('alice');
    const { error } = await alice.rpc('discovery_promote_candidate', {
      p_actor_id: harness.users.alice.id,
      p_tenant_id: tenantId,
      p_bank_id: '00000000-0000-4000-8000-000000000000',
      p_candidate_id: kestrel,
      p_codename: 'Project Kestrel',
      p_target_name: 'Northwind Robotics',
      p_entry_step_seq: ENTRY_SEQ,
      p_entry_phase: 4,
      p_entry_status: 'active',
      p_members: [],
      p_screening: { verdict: 'compliant', reasons: [] },
      p_steps: SEEDED,
      p_census_version: 'x',
      p_conflicts: { approvedBy: 'x', approvedOn: today() },
    });
    expect(error?.code).toBe('42501');
    expect(await promotedDeals()).toEqual([]);
  });

  it('promotes Kestrel as Alice: a live deal at step 44 with 61 steps, the candidate confirmed', async () => {
    const res = await promote('alice', kestrel);
    expect(res.status).toBe(201);
    deal = { id: res.body.deal.id, code: res.body.deal.code };
    expect(res.body.screening.verdict).toBe('compliant');

    const row = (
      await db
        .from('deals')
        .select('codename, status, lifecycle_category, current_step_seq, entry_step_seq, mandate_owner_id, conflicts_approved_by')
        .eq('id', deal.id)
        .single()
    ).data;
    expect(row).toEqual({
      codename: 'Project Kestrel',
      status: 'active',
      lifecycle_category: 'live',
      current_step_seq: ENTRY_SEQ,
      entry_step_seq: ENTRY_SEQ,
      mandate_owner_id: harness.users.alice.id,
      conflicts_approved_by: 'Avery Lindqvist',
    });

    const steps = (await db.from('deal_steps').select('seq, status').eq('deal_id', deal.id)).data ?? [];
    expect(steps).toHaveLength(61);
    expect(steps.filter((s) => s.status === 'skipped_entry').map((s) => s.seq).sort((a, b) => a - b)).toEqual(
      SEEDED.filter((s) => s.seq < ENTRY_SEQ).map((s) => s.seq).sort((a, b) => a - b),
    );
    expect(steps.filter((s) => s.status === 'current').map((s) => s.seq)).toEqual([ENTRY_SEQ]);

    const candidate = (await db.from('deal_candidates').select('discovery_state, promoted_deal_id').eq('id', kestrel).single()).data;
    expect(candidate).toEqual({ discovery_state: 'confirmed', promoted_deal_id: deal.id });
    expect((await list('alice')).map((c) => c.name)).not.toContain('Project Kestrel'); // it is a mandate now

    const seats = (await db.from('deal_memberships').select('user_id, deal_role').eq('deal_id', deal.id)).data ?? [];
    expect(seats).toEqual([{ user_id: harness.users.alice.id, deal_role: 'md' }]);
    // Gate 0's own rows, plus the promotion's.
    const audit = (await db.from('audit_log').select('action, actor_id, detail').eq('deal_id', deal.id)).data ?? [];
    expect(audit.filter((a) => a.action === 'create')).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'attest')).toHaveLength(1);
    const promoted = audit.filter((a) => a.action === 'discovery.candidate_promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0].actor_id).toBe(harness.users.alice.id);
    expect(promoted[0].detail).toMatchObject({ candidateId: kestrel, dealId: deal.id, suggestedStepId: 'p4-s48', chosenStepSeq: ENTRY_SEQ });
    expect(JSON.stringify(promoted[0].detail)).not.toMatch(/kestrel|northwind/i);
    const corrections = (await db.from('corrections').select('action, deal_id').eq('candidate_id', kestrel)).data ?? [];
    expect(corrections).toEqual([{ action: 'promote', deal_id: deal.id }]);
    const assessments = (await db.from('stage_assessments').select('deal_id').eq('candidate_id', kestrel)).data ?? [];
    expect(assessments.every((a) => a.deal_id === deal.id)).toBe(true);
  });

  it('refuses a second promotion (409) and a live code name on another candidate (409)', async () => {
    expect(await promote('alice', kestrel)).toEqual({ status: 409, body: { error: 'This proposed deal is already a mandate' } });
    expect(await promote('alice', osprey)).toEqual({ status: 409, body: { error: 'Code name is already in use on a live deal' } });
    expect((await db.from('deal_candidates').select('discovery_state').eq('id', osprey).single()).data).toEqual({ discovery_state: 'proposed' });
  });

  it('reads the step the cursor is on before any late mail, which the rail marker hides', async () => {
    const s = await suggestion('alice', deal.code);
    expect(s).toMatchObject({ stepId: 'p4-s48', dismissed: false, flags: [] });
  });

  it("does not attach mail from a mailbox whose owner is not seated on the deal (Q21), and does attach the MD's", async () => {
    const candidate = (await db.from('deal_candidates').select('cluster_key, proposed_name').eq('id', kestrel).single()).data!;
    const itemFor = async (persona: 'alice' | 'bob', tag: string) => {
      const source = await harness.sourceIdOf(persona === 'alice' ? 'storm.duncan@bank.example' : 'alex.chen@bank.example');
      const { data } = await db
        .from('source_items')
        .insert({
          tenant_id: tenantId, kind: 'message', subject: tag, sent_at: '2026-10-01T10:00:00Z',
          internet_message_id: `<${tag}@integration.example>`, content_hash: `h-${tag}`,
        })
        .select('id')
        .single();
      const id = data!.id as string;
      await db.from('source_item_texts').insert({ source_item_id: id, body_text: `${tag} body` });
      await db.from('source_item_sources').insert({ source_item_id: id, content_source_id: source, provider_item_id: `p-${tag}` });
      return id;
    };
    const bobs = await itemFor('bob', 'unseated-owner');
    const alices = await itemFor('alice', 'seated-owner');
    const group = (items: string[]) => [
      {
        clusterKey: candidate.cluster_key, proposedName: candidate.proposed_name, codenameGuess: candidate.proposed_name,
        parties: [], firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z', confidence: 0.9,
        links: items.map((sourceItemId) => ({ sourceItemId, method: 'codename', confidence: 0.9 })),
      },
    ];
    const { error } = await db.rpc('discovery_upsert_candidates', { p_tenant_id: tenantId, p_run_id: crypto.randomUUID(), p_groups: group([bobs, alices]) });
    expect(error).toBeNull();
    const linked = async (item: string) =>
      (await db.from('evidence_links').select('*', { count: 'exact', head: true }).eq('candidate_id', kestrel).eq('source_item_id', item)).count;
    expect(await linked(bobs)).toBe(0);
    expect(await linked(alices)).toBe(1);
    await db.from('evidence_links').delete().eq('candidate_id', kestrel).eq('source_item_id', alices);
  });

  it('follows late mail: the SPA is signed, and the suggestions route says step 47 to Alice only', async () => {
    const before = await linkCount(kestrel);
    await harness.rewindSources();
    await harness.seedDemo(DEMO_LATE_MAIL_DIRECTORY);
    expect(await linkCount(kestrel)).toBe(before + 2);
    const summary = await extract();
    expect(summary).toMatchObject({ invalid: 0, failed: 0 });
    expect(summary.assessed).toBeGreaterThanOrEqual(1);

    const s = await suggestion('alice', deal.code);
    expect(s).toMatchObject({
      stepId: 'p5-s51',
      dismissed: false,
      flags: [],
      reason: 'Signing / Announcement Prep because signing on Oct 28, 2026 (1 email)',
      evidenceCount: 1,
    });
    // Someone who is neither seated on the deal nor an overseer reads nothing.
    expect(await suggestion('bob', deal.code)).toBeNull();
    expect(await suggestion('colleague', deal.code)).toBeNull();
    // A firm admin oversees the deal and reads the step, never a message.
    const admin = await suggestion('admin', deal.code);
    expect(admin?.stepId).toBe('p5-s51');
    expect(JSON.stringify(admin)).not.toMatch(/subject|body|@/);
    // The cursor has not moved by itself.
    expect((await db.from('deals').select('current_step_seq').eq('id', deal.id).single()).data).toEqual({ current_step_seq: ENTRY_SEQ });
  });

  it('lets only the MD dismiss, with a reason, and shows the marker again for a newer assessment', async () => {
    const s = (await suggestion('alice', deal.code))!;
    // A deal team member who holds no evidence reads the suggestion but cannot dismiss it.
    const dealTeam = (await db.from('roles').select('id').eq('slug', 'deal_team').single()).data!.id as string;
    const seat = await db
      .from('deal_memberships')
      .insert({ deal_id: deal.id, user_id: harness.users.bob.id, role_id: dealTeam, deal_role: 'deal_team' });
    expect(seat.error).toBeNull();
    expect((await suggestion('bob', deal.code))?.stepId).toBe('p5-s51');

    const body = { dealCode: deal.code, assessmentId: s.assessmentId, reason: 'Signing slipped to November' };
    expect(await dismiss('bob', body)).toEqual({ status: 403, body: { error: 'Only the deal MD can dismiss this suggestion' } });
    expect((await dismiss('alice', { ...body, reason: ' ' })).status).toBe(400);
    expect((await dismiss('alice', { ...body, dealCode: 'NOPE-2026-000' })).status).toBe(404);
    expect((await dismiss('alice', { ...body, assessmentId: crypto.randomUUID() })).status).toBe(404);
    expect((await suggestion('alice', deal.code))?.dismissed).toBe(false);

    const ok = await dismiss('alice', body);
    expect(ok.status).toBe(200);
    expect((await suggestion('alice', deal.code))?.dismissed).toBe(true);
    // The seated member sees that it was dismissed, but not the candidate's other decisions.
    expect((await suggestion('bob', deal.code))?.dismissed).toBe(true);
    harness.sessionFor('bob');
    const visible = (await harness.activeSession().from('corrections').select('action').eq('candidate_id', kestrel)).data ?? [];
    expect(visible.map((c) => c.action).sort()).toEqual(['dismiss_suggestion', 'promote']);

    const audit = (await db.from('audit_log').select('actor_id, detail').eq('deal_id', deal.id).eq('action', 'discovery.correction')).data ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(harness.users.alice.id);
    expect(audit[0].detail).toMatchObject({ action: 'dismiss_suggestion', candidateId: kestrel });

    // A newer assessment (changed evidence) shows the marker again.
    const newer = await db.rpc('discovery_record_assessment', {
      p_tenant_id: tenantId,
      p_candidate_id: kestrel,
      p_assessment: {
        stepId: 'p5-s52', station: 48, lifecycle: 'live', reason: 'Announcement because announced on 29 Oct 2026 (1 email)',
        evidenceEventIds: [], confidence: 0.9, flags: [], engineVersion: 'stage-engine/v1',
      },
      p_trigger: 'extraction',
    });
    expect(newer.error).toBeNull();
    expect(await suggestion('alice', deal.code)).toMatchObject({ stepId: 'p5-s52', dismissed: false });
  });

  it('accepts the suggestion through the progress route: the cursor moves to seq 51 with an advance audit', async () => {
    const moved = await moveRail('alice', deal.code, 51);
    expect(moved).toEqual({ status: 200, body: { deal: { code: deal.code, currentStepSeq: 51 } } });
    expect((await db.from('deals').select('current_step_seq').eq('id', deal.id).single()).data).toEqual({ current_step_seq: 51 });
    const { data } = await db.from('audit_log').select('actor_id, detail').eq('deal_id', deal.id).eq('action', 'advance');
    expect((data ?? []).map((a) => a.detail)).toContainEqual(expect.objectContaining({ to: 51 }));
    expect((data ?? []).some((a) => a.actor_id === harness.users.alice.id)).toBe(true);
  });
});
