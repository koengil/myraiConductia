import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Deal discovery, phase 7 (corrections), against a REAL database:
 *
 *   demo corpus -> runOnce -> runExtractOnce (the model double) -> POST
 *   /api/v1/discovery/candidates/{id}/{rename,reject,step,merge,split,reassign} as each user,
 *   then re-seed and re-run, and read the candidate back under RLS.
 *
 * What is real: the classification worker, the extract loop, the Supabase store,
 * the four route handlers, the correction RPCs, the upsert, RLS, Postgres. What
 * is faked: the model (a test-owned double) and how a handler obtains the
 * signed-in client (the cookie layer needs Next). company_access_management is
 * switched on for the file, so deal-create authority is real: Alice (a director)
 * holds it, the colleague and Bob (members) do not.
 *
 * The order of the cases is the story: merge Harbor into Kestrel, set Kestrel's
 * step, rename it, let late mail arrive, reject Osprey, and every time show
 * that a re-run leaves the decision in place.
 */

import { createDiscoveryTenant, DEMO_LATE_MAIL_DIRECTORY, type Persona } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('cr');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { GET as listRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as detailRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/route';
import { POST as mergeRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/merge/route';
import { POST as reassignRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/reassign/route';
import { POST as rejectRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/reject/route';
import { POST as renameRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/rename/route';
import { POST as splitRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/split/route';
import { POST as stationRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/station/route';
import { runExtractOnce } from '@/lib/discovery/extract/run';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import type { ModelTransport } from '@/lib/modelGateway/transports';
import { DEMO_REPLY_TABLE } from '../helpers/demoReplyTable';
import { modelReplyDouble } from '../helpers/modelReplyDouble';

const { db, tenantId } = harness;
// The harness tenant is not synthetic, so the gate replays for it only on loopback: pass the local stack's URL alone.
const GATE_ENV = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL };
const store = supabaseExtractStore(db);

type Candidate = { id: string; name: string; evidenceCount: number };
type Route = 'rename' | 'reject' | 'station' | 'merge' | 'split' | 'reassign';
const ROUTES = {
  rename: renameRoute,
  reject: rejectRoute,
  station: stationRoute,
  merge: mergeRoute,
  split: splitRoute,
  reassign: reassignRoute,
};

async function list(persona: Persona): Promise<Candidate[]> {
  harness.sessionFor(persona);
  const res = await listRoute();
  expect(res.status).toBe(200);
  return (await res.json()).candidates as Candidate[];
}

async function detail(persona: Persona, id: string) {
  harness.sessionFor(persona);
  const res = await detailRoute(new Request('http://localhost/'), { params: Promise.resolve({ candidateId: id }) });
  return { status: res.status, body: await res.json() };
}

async function act(persona: Persona, route: Route, id: string, body: Record<string, unknown>) {
  harness.sessionFor(persona);
  const res = await ROUTES[route](
    new Request(`http://localhost/api/v1/discovery/candidates/${id}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ candidateId: id }) },
  );
  return { status: res.status, body: await res.json() };
}

async function idOf(persona: Persona, name: string): Promise<string> {
  const found = (await list(persona)).find((c) => c.name === name);
  if (!found) throw new Error(`${persona} does not see ${name}`);
  return found.id;
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

/** Read every mailbox from the start again and classify it, as a scheduled re-run would. */
async function rerun(dir?: string) {
  await harness.rewindSources();
  return harness.seedDemo(dir);
}

const linkCount = async (candidateId: string) =>
  (await db.from('evidence_links').select('*', { count: 'exact', head: true }).eq('candidate_id', candidateId)).count ?? 0;

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

describe('corrections survive a re-run', () => {
  let kestrel = '';
  let harbor = '';
  let osprey = '';
  let kestrelLinksBefore = 0;

  it('classifies and extracts the demo corpus', async () => {
    await harness.seedDemo();
    const summary = await extract();
    expect(summary).toMatchObject({ invalid: 0, failed: 0 });
    kestrel = await idOf('alice', 'Project Kestrel');
    harbor = await idOf('alice', 'Project Harbor');
    osprey = await idOf('alice', 'Project Osprey');
    kestrelLinksBefore = await linkCount(kestrel);
    expect(await linkCount(harbor)).toBe(3);
  });

  it('refuses every action to a colleague who sees Kestrel but holds no deal-create authority (403)', async () => {
    expect(await idOf('colleague', 'Project Kestrel')).toBe(kestrel);
    const refused = { status: 403, body: { error: 'Needs deal-create authority' } };
    expect(await act('colleague', 'rename', kestrel, { name: 'Nope' })).toEqual(refused);
    expect(await act('colleague', 'reject', kestrel, { reason: 'Nope' })).toEqual(refused);
    expect(await act('colleague', 'station', kestrel, { stepId: 'p4-s48', reason: 'Nope' })).toEqual(refused);
    expect(await act('colleague', 'merge', kestrel, { survivorId: osprey, reason: 'Nope' })).toEqual(refused);
    const { body } = await detail('colleague', kestrel);
    expect(body.candidate.canAct).toEqual({ ok: false, reason: 'no_authority' });
    expect(body.candidate.decisions).toEqual([]);
    expect(body.candidate.name).toBe('Project Kestrel');
  });

  it('answers 404 to Bob, who holds no deal mail, and to the firm admin', async () => {
    const notFound = { status: 404, body: { error: 'Proposed deal not found' } };
    expect(await act('bob', 'rename', kestrel, { name: 'Nope' })).toEqual(notFound);
    expect(await act('bob', 'merge', harbor, { survivorId: kestrel, reason: 'Nope' })).toEqual(notFound);
    expect(await act('admin', 'reject', kestrel, { reason: 'Nope' })).toEqual(notFound);
    expect(await act('alice', 'rename', '00000000-0000-4000-8000-000000000000', { name: 'Nope' })).toEqual(notFound);
  });

  it('merges Harbor into Kestrel: the list drops Harbor, Kestrel keeps its name and gains its evidence', async () => {
    const res = await act('alice', 'merge', harbor, { survivorId: kestrel, reason: 'Harbor is the Kestrel process' });
    expect(res.status).toBe(200);
    expect(res.body.correctionId).toEqual(expect.any(String));

    const names = (await list('alice')).map((c) => c.name);
    expect(names).not.toContain('Project Harbor');
    expect(names).toContain('Project Kestrel');
    expect(await linkCount(kestrel)).toBe(kestrelLinksBefore + 3);
    expect(await linkCount(harbor)).toBe(3); // the originals stay

    const harborDetail = (await detail('alice', harbor)).body.candidate;
    expect(harborDetail.state).toBe('merged_into');
    expect(harborDetail.mergedInto).toEqual({ id: kestrel, name: 'Project Kestrel' });
    expect(harborDetail.canAct).toEqual({ ok: false, reason: 'candidate_state' });
    expect(harborDetail.decisions).toHaveLength(1);
    expect(harborDetail.decisions[0]).toMatchObject({
      action: 'merge',
      own: true,
      reason: 'Harbor is the Kestrel process',
      before: { state: 'proposed', name: 'Project Harbor' },
      after: { survivorId: kestrel, survivorName: 'Project Kestrel' },
    });
    // Kestrel's own history shows the merge into it.
    const kestrelDetail = (await detail('alice', kestrel)).body.candidate;
    expect(kestrelDetail.decisions.map((d: { action: string }) => d.action)).toEqual(['merge']);
    expect(kestrelDetail.canAct).toEqual({ ok: true });
  });

  it('refuses to merge a merged candidate again, or into a merged one (409), and a bad body (400)', async () => {
    expect((await act('alice', 'merge', harbor, { survivorId: kestrel, reason: 'Again' })).status).toBe(409);
    expect((await act('alice', 'merge', osprey, { survivorId: harbor, reason: 'Into a merged one' })).status).toBe(409);
    expect((await act('alice', 'merge', kestrel, { survivorId: kestrel, reason: 'Itself' })).status).toBe(400);
    expect((await act('alice', 'merge', osprey, { survivorId: kestrel })).status).toBe(400);
  });

  it('recomputes Kestrel after the merge, and a re-run lands Harbor\'s mail on it without renaming it', async () => {
    const summary = await extract();
    expect(summary.sent).toBe(0); // nothing new to read; the outbox asked for the recompute
    expect((await detail('alice', kestrel)).body.candidate.station).toMatchObject({ stepId: 'p4-s48', station: 44 });

    const before = await linkCount(kestrel);
    await rerun();
    expect(await linkCount(kestrel)).toBe(before); // no duplicates
    expect((await list('alice')).map((c) => c.name)).not.toContain('Project Harbor');
    expect((await detail('alice', kestrel)).body.candidate.name).toBe('Project Kestrel');

    // Harbor's mail reaching Kestrel is the re-run's doing, not only the merge's: remove one link and re-run.
    const { data: copied } = await db.from('evidence_links').select('id, source_item_id').eq('candidate_id', harbor).limit(1);
    const item = copied![0].source_item_id as string;
    const gone = await db.from('evidence_links').delete().eq('candidate_id', kestrel).eq('source_item_id', item);
    expect(gone.error).toBeNull();
    expect(await linkCount(kestrel)).toBe(before - 1);
    await rerun();
    expect(await linkCount(kestrel)).toBe(before);
    expect(await linkCount(harbor)).toBe(3);
    expect((await detail('alice', kestrel)).body.candidate.name).toBe('Project Kestrel');
  });

  it('sets a step with a reason: it survives a re-run and the assessment carries overridden', async () => {
    expect((await act('alice', 'station', kestrel, { stepId: 'p5-s51' })).status).toBe(400); // a reason is required
    expect((await act('alice', 'station', kestrel, { stepId: 'p9-s99', reason: 'Why' })).status).toBe(400); // not on the rail
    const res = await act('alice', 'station', kestrel, { stepId: 'p5-s51', reason: 'Signing confirmed by phone' });
    expect(res.status).toBe(200);

    let c = (await detail('alice', kestrel)).body.candidate;
    expect(c.override).toEqual({ stepId: 'p5-s51', station: 47, title: 'Signing / Announcement Prep', reason: 'Signing confirmed by phone' });

    const summary = await extract();
    expect(summary.assessed).toBeGreaterThanOrEqual(1);
    c = (await detail('alice', kestrel)).body.candidate;
    expect(c.station).toMatchObject({ stepId: 'p4-s48', station: 44 }); // the evidence's own suggestion stays
    expect(c.station.flags).toContain('overridden');

    await rerun();
    await extract();
    c = (await detail('alice', kestrel)).body.candidate;
    expect(c.override).toMatchObject({ stepId: 'p5-s51', station: 47 });
    expect(c.station.flags).toContain('overridden');

    const history = c.decisions.filter((d: { action: string }) => d.action === 'set_station');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      own: true,
      reason: 'Signing confirmed by phone',
      before: { stepId: null, suggestedStepId: 'p4-s48' },
      after: { stepId: 'p5-s51' },
    });
  });

  it('renames Kestrel, which pins it: late mail still lands on it and the name holds', async () => {
    const before = await linkCount(kestrel);
    const res = await act('alice', 'rename', kestrel, { name: 'Project Kestrel Prime' });
    expect(res.status).toBe(200);
    expect((await list('alice')).map((c) => c.name)).toContain('Project Kestrel Prime');

    // Two late Kestrel mails (an SPA draft and the signing) arrive in Storm's mailbox.
    await rerun(DEMO_LATE_MAIL_DIRECTORY);
    expect(await linkCount(kestrel)).toBe(before + 2);
    const c = (await detail('alice', kestrel)).body.candidate;
    expect(c.name).toBe('Project Kestrel Prime');
    expect((await list('alice')).find((x) => x.id === kestrel)?.evidenceCount).toBe(before + 2);
    const rename = c.decisions.find((d: { action: string }) => d.action === 'rename');
    expect(rename).toMatchObject({ before: { name: 'Project Kestrel' }, after: { name: 'Project Kestrel Prime' } });
    // Decisions read oldest first: merge, step, rename.
    expect(c.decisions.map((d: { action: string }) => d.action)).toEqual(['merge', 'set_station', 'rename']);
  });

  it('rejects Osprey: it leaves the list and a re-run neither relists it nor adds evidence', async () => {
    expect((await act('alice', 'reject', osprey, {})).status).toBe(400); // a reason is required
    const before = await linkCount(osprey);
    const res = await act('alice', 'reject', osprey, { reason: 'Closed in 2025, not a live process' });
    expect(res.status).toBe(200);
    expect((await list('alice')).map((c) => c.name)).not.toContain('Project Osprey');
    const c = (await detail('alice', osprey)).body.candidate;
    expect(c.state).toBe('rejected');
    expect(c.canAct).toEqual({ ok: false, reason: 'candidate_state' });
    expect((await act('alice', 'reject', osprey, { reason: 'Again' })).status).toBe(409);

    await rerun();
    expect((await list('alice')).map((x) => x.name)).not.toContain('Project Osprey');
    expect(await linkCount(osprey)).toBe(before);
    expect((await detail('alice', osprey)).body.candidate.state).toBe('rejected');
  });

  it('records every correction once, audited by the user with ids only, and never editable', async () => {
    const { data: rows } = await db.from('corrections').select('id, action, actor_id').eq('tenant_id', tenantId);
    expect((rows ?? []).map((r) => r.action).sort()).toEqual(['merge', 'reject', 'rename', 'set_station']);
    expect((rows ?? []).every((r) => r.actor_id === harness.users.alice.id)).toBe(true);

    const { data: audit } = await db
      .from('audit_log')
      .select('actor_type, actor_id, detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.correction');
    expect(audit).toHaveLength(4);
    for (const row of audit ?? []) {
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(harness.users.alice.id);
      expect(JSON.stringify(row.detail)).not.toMatch(/kestrel|harbor|osprey|prime/i);
    }

    const edit = await db.from('corrections').update({ reason: 'edited' }).eq('tenant_id', tenantId);
    expect(edit.error).not.toBeNull();
    const del = await db.from('corrections').delete().eq('tenant_id', tenantId);
    expect(del.error).not.toBeNull();
  });
});

/*
 * Phase 8: split some of Kestrel's emails onto a new proposed deal, and move one
 * back. Runs after the story above, on the candidate it left (renamed, with its
 * evidence), so it does not disturb that story's counts.
 */
describe('split and reassign survive a re-run', () => {
  type Item = { linkId: string; sourceItemId: string; subject: string; own: boolean };
  let kestrel = '';
  let annex = '';
  let moved: Item[] = [];
  let kestrelBefore = 0;

  const itemsOf = async (persona: Persona, id: string): Promise<Item[]> =>
    (await detail(persona, id)).body.candidate.items as Item[];

  it('offers Alice the live emails of Kestrel, and refuses a colleague (403) and Bob (404)', async () => {
    kestrel = await idOf('alice', 'Project Kestrel Prime');
    const items = await itemsOf('alice', kestrel);
    kestrelBefore = items.length;
    expect(items.length).toBeGreaterThanOrEqual(4);
    moved = items.filter((i) => i.own).slice(0, 2);
    expect(moved).toHaveLength(2);

    const ids = moved.map((i) => i.sourceItemId);
    expect(await act('colleague', 'split', kestrel, { itemIds: ids, name: 'Nope', reason: 'Nope' })).toEqual({
      status: 403,
      body: { error: 'Needs deal-create authority' },
    });
    expect((await act('colleague', 'reassign', kestrel, { linkId: moved[0].linkId, targetCandidateId: '00000000-0000-4000-8000-000000000000', reason: 'Nope' })).status).toBe(403);
    expect((await act('bob', 'split', kestrel, { itemIds: ids, name: 'Nope', reason: 'Nope' })).status).toBe(404);
  });

  it("refuses a bad split: no reason, no emails, every email, an email that is not Kestrel's", async () => {
    const ids = moved.map((i) => i.sourceItemId);
    expect((await act('alice', 'split', kestrel, { itemIds: ids, name: 'Annex' })).status).toBe(400);
    expect((await act('alice', 'split', kestrel, { itemIds: [], name: 'Annex', reason: 'Why' })).status).toBe(400);
    const all = (await itemsOf('alice', kestrel)).map((i) => i.sourceItemId);
    const everything = await act('alice', 'split', kestrel, { itemIds: all, name: 'Annex', reason: 'Why' });
    expect(everything).toEqual({ status: 400, body: { error: 'Leave at least one email on this proposed deal' } });
    // An email Alice can open, held by another proposed deal, is not live on Kestrel: 409.
    const other = (await list('alice')).find((c) => c.id !== kestrel);
    expect(other).toBeDefined();
    const elsewhere = (await itemsOf('alice', other!.id)).filter((i) => i.own && !all.includes(i.sourceItemId));
    expect(elsewhere.length).toBeGreaterThan(0);
    expect((await act('alice', 'split', kestrel, { itemIds: [elsewhere[0].sourceItemId], name: 'Annex', reason: 'Why' })).status).toBe(409);
    // An email she cannot open at all (here, one that does not exist) is not visible: 404, never a hint it is elsewhere.
    const stranger = '00000000-0000-4000-8000-000000000000';
    expect((await act('alice', 'split', kestrel, { itemIds: [stranger], name: 'Annex', reason: 'Why' })).status).toBe(404);
    expect((await list('alice')).map((c) => c.name)).not.toContain('Project Kestrel Annex');
  });

  it('splits two emails onto a new proposed deal: Kestrel loses them, the new deal holds them', async () => {
    const res = await act('alice', 'split', kestrel, {
      itemIds: moved.map((i) => i.sourceItemId),
      name: 'Project Kestrel Annex',
      reason: 'Two different processes',
    });
    expect(res.status).toBe(200);

    annex = await idOf('alice', 'Project Kestrel Annex');
    const annexDetail = (await detail('alice', annex)).body.candidate;
    expect(annexDetail.state).toBe('proposed');
    expect(annexDetail.canAct).toEqual({ ok: true });
    expect((annexDetail.items as Item[]).map((i) => i.sourceItemId).sort()).toEqual(moved.map((i) => i.sourceItemId).sort());
    expect(annexDetail.decisions).toHaveLength(1);
    expect(annexDetail.decisions[0]).toMatchObject({
      action: 'split',
      own: true,
      reason: 'Two different processes',
      before: { name: 'Project Kestrel Prime' },
      after: { newCandidateId: annex, newName: 'Project Kestrel Annex', itemCount: 2 },
    });

    const kestrelDetail = (await detail('alice', kestrel)).body.candidate;
    expect(kestrelDetail.items).toHaveLength(kestrelBefore - 2);
    expect(kestrelDetail.evidenceCount).toBe(kestrelBefore - 2);
    expect(kestrelDetail.decisions.map((d: { action: string }) => d.action)).toContain('split');

    const { data: cluster } = await db.from('deal_candidates').select('cluster_key, pinned').eq('id', annex).single();
    expect(cluster).toMatchObject({ pinned: true });
    expect(String(cluster?.cluster_key)).toMatch(/^correction:/);
  });

  it('keeps the split after a re-run and a recompute', async () => {
    const summary = await extract();
    expect(summary).toMatchObject({ invalid: 0, failed: 0 });
    await rerun();
    await extract();

    const kestrelItems = await itemsOf('alice', kestrel);
    expect(kestrelItems).toHaveLength(kestrelBefore - 2);
    for (const item of moved) expect(kestrelItems.map((i) => i.sourceItemId)).not.toContain(item.sourceItemId);
    expect(await itemsOf('alice', annex)).toHaveLength(2);
    expect((await detail('alice', annex)).body.candidate.name).toBe('Project Kestrel Annex');
    expect((await list('alice')).map((c) => c.name)).toContain('Project Kestrel Annex');
    expect((await list('alice')).find((c) => c.id === kestrel)?.evidenceCount).toBe(kestrelBefore - 2);
    // The worker's routing did not put a rejected link back, nor make a second one.
    const { data: kestrelLinks } = await db
      .from('evidence_links')
      .select('source_item_id, state')
      .eq('candidate_id', kestrel)
      .in('source_item_id', moved.map((i) => i.sourceItemId));
    expect((kestrelLinks ?? []).map((l) => l.state)).toEqual(['rejected', 'rejected']);
  });

  it('moves one email back to Kestrel, and a re-run leaves it there', async () => {
    const first = (await itemsOf('alice', annex)).find((i) => i.sourceItemId === moved[0].sourceItemId);
    expect(first).toBeDefined();
    // A link that is not the path candidate's is not found; a missing reason is a bad request.
    expect((await act('alice', 'reassign', kestrel, { linkId: first!.linkId, targetCandidateId: annex, reason: 'Why' })).status).toBe(404);
    expect((await act('alice', 'reassign', annex, { linkId: first!.linkId, targetCandidateId: kestrel })).status).toBe(400);
    const res = await act('alice', 'reassign', annex, {
      linkId: first!.linkId,
      targetCandidateId: kestrel,
      reason: 'This one is about Kestrel after all',
    });
    expect(res.status).toBe(200);

    const check = async () => {
      expect(await itemsOf('alice', annex)).toHaveLength(1);
      const kestrelItems = await itemsOf('alice', kestrel);
      expect(kestrelItems).toHaveLength(kestrelBefore - 1);
      expect(kestrelItems.map((i) => i.sourceItemId)).toContain(moved[0].sourceItemId);
    };
    await check();
    await extract();
    await rerun();
    await check();

    const annexDetail = (await detail('alice', annex)).body.candidate;
    expect(annexDetail.decisions.map((d: { action: string }) => d.action)).toEqual(['split', 'reassign']);
    expect(annexDetail.decisions[1]).toMatchObject({
      own: true,
      reason: 'This one is about Kestrel after all',
      after: { targetCandidateId: kestrel, targetName: 'Project Kestrel Prime' },
    });
    expect((await detail('alice', kestrel)).body.candidate.decisions.map((d: { action: string }) => d.action)).toContain('reassign');
  });

  it('audits both by the user with ids only', async () => {
    const { data: audit } = await db
      .from('audit_log')
      .select('actor_type, actor_id, detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.correction');
    const split = (audit ?? []).filter((r) => (r.detail as { action: string }).action === 'split');
    const reassign = (audit ?? []).filter((r) => (r.detail as { action: string }).action === 'reassign');
    expect(split).toHaveLength(1);
    expect(reassign).toHaveLength(1);
    for (const row of [...split, ...reassign]) {
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(harness.users.alice.id);
      expect(JSON.stringify(row.detail)).not.toMatch(/kestrel|annex|prime/i);
    }
  });
});
