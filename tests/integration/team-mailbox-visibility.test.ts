import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * An admin-managed team inbox (#581), against a REAL database: who sees what discovery found in it.
 *
 *   admin connects deals@ -> the worker's Directory check is recorded -> fixture items are persisted
 *   (a candidate whose evidence is five team-only messages, one message the team inbox shares with
 *   Bob's own mailbox, and one message only Bob holds) -> the candidate list and the deal email are
 *   read as each persona -> the admin adds and removes people.
 *
 * What is real: the connect, check, add and remove RPCs, the candidate upsert, RLS and Postgres, the
 * candidate, promotion and deal-email routes. What is faked: how a handler obtains the signed-in
 * client (the cookie layer needs Next), and the Google Directory (the check is recorded through the
 * worker's own RPC, as the scripted verifier of tests/discovery/team-mailbox-check.test.ts would).
 * RLS is the only access decision, so every case below is a different session reading the same rows:
 *
 *   alice     a director who is not an admin: the inbox's member (the demo's Storm)
 *   bob       holds a personal copy of one team message and one message of his own; never a member
 *   colleague seated, no evidence, never a member
 *   admin     the firm admin who manages the members; reads no candidate content
 *
 * Then ~2k links on one candidate: the member's candidate list and deal email stay within a budget
 * (the helpers join the team tables per row, so this is where a missing index would show), and
 * a seated non-member reads nothing of that deal.
 *
 * KNOWN RESIDUE: the team tables are append-only for every role (no delete grant, even to the service
 * role), and audit_log is append-only too, so the registration, its members and the users who wrote
 * them survive cleanup (the harness suspends and unseats the users it cannot delete). The CI stack is
 * destroyed whole, as for the other suites that connect Google.
 */

import { createDiscoveryTenant, type Persona } from './helpers/discoveryTenant';
import { addDealMembers } from './support/guardedTenant';

const harness = createDiscoveryTenant('tv');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { POST as promoteRoute } from '@/app/api/v1/deals/from-discovery/route';
import { GET as candidateDetailRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/route';
import { GET as candidatesRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as dealEmailRoute } from '@/app/api/v1/discovery/deal-email/route';

const { db } = harness;

const RUN = Date.now().toString(36);
const TEAM_ADDRESS = 'deals@team.example';
const BOB_ADDRESS = 'alex.chen@bank.example'; // Bob's mailbox in the harness
const TEAM_ONLY = 5;
const SCALE_LINKS = 2000;
// A local stack answers these in well under a second each. The budget is generous (CI shares a core with the
// stack) and exists to catch a per-row plan that goes quadratic, not to benchmark.
const BUDGET_MS = 15_000;
const ENTRY_SEQ = 48; // LOI Review, step 44
const today = () => new Date().toISOString().slice(0, 10);

type Candidate = { id: string; name: string; evidenceCount: number; ownEvidenceCount: number };
type Row = {
  sourceItemId: string;
  sentDay: string | null;
  fromDomain: string | null;
  sender: string | null;
  subject: string | null;
  own: boolean;
};
type Listing = { status: number; items: Row[]; truncated: boolean };

async function candidatesAs(persona: Persona): Promise<{ list: Candidate[]; ms: number }> {
  harness.sessionFor(persona);
  const started = performance.now();
  const res = await candidatesRoute();
  const ms = performance.now() - started;
  console.info(`[budget] ${persona} candidate list: ${Math.round(ms)} ms (budget ${BUDGET_MS} ms)`);
  expect(res.status).toBe(200);
  return { list: ((await res.json()) as { candidates: Candidate[] }).candidates, ms };
}

async function candidateDetailAs(persona: Persona, candidateId: string): Promise<{ status: number; ms: number }> {
  harness.sessionFor(persona);
  const started = performance.now();
  const res = await candidateDetailRoute(new Request(`http://localhost/api/v1/discovery/candidates/${candidateId}`), {
    params: Promise.resolve({ candidateId }),
  });
  const ms = performance.now() - started;
  console.info(`[budget] ${persona} candidate detail: ${Math.round(ms)} ms (budget ${BUDGET_MS} ms)`);
  return { status: res.status, ms };
}

async function dealEmailAs(persona: Persona, code: string): Promise<Listing & { ms: number }> {
  harness.sessionFor(persona);
  const started = performance.now();
  const res = await dealEmailRoute(new Request(`http://localhost/api/v1/discovery/deal-email?deal=${encodeURIComponent(code)}`));
  const ms = performance.now() - started;
  console.info(`[budget] ${persona} deal email: ${Math.round(ms)} ms (budget ${BUDGET_MS} ms)`);
  const body = (await res.json()) as { items?: Row[]; truncated?: boolean };
  return { status: res.status, items: body.items ?? [], truncated: body.truncated ?? false, ms };
}

async function insertChunks(table: string, rows: Array<Record<string, unknown>>, size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
  }
}

/** Messages, their text, and one provenance row per holding source. Returns the item ids. */
async function seedItems(tag: string, count: number, sourceIds: string[]): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await insertChunks(
    'source_items',
    ids.map((id, i) => ({
      id,
      tenant_id: harness.tenantId,
      kind: 'message',
      subject: `${tag} message ${i}`,
      sent_at: new Date(Date.UTC(2026, 1, 1 + (i % 27))).toISOString(),
      internet_message_id: `<${tag}-${i}-${RUN}@integration.test>`,
      content_hash: `${tag}-${i}-${RUN}`,
    })),
  );
  await insertChunks('source_item_texts', ids.map((id, i) => ({ source_item_id: id, body_text: `${tag} body ${i}` })));
  await insertChunks(
    'source_item_sources',
    sourceIds.flatMap((sourceId, s) =>
      ids.map((id, i) => ({ source_item_id: id, content_source_id: sourceId, provider_item_id: `${tag}-${s}-${i}-${RUN}` })),
    ),
  );
  return ids;
}

async function upsertCandidate(key: string, name: string, itemIds: string[]): Promise<string> {
  const { error } = await db.rpc('discovery_upsert_candidates', {
    p_tenant_id: harness.tenantId,
    p_run_id: crypto.randomUUID(),
    p_groups: [
      {
        clusterKey: key,
        proposedName: name,
        codenameGuess: name,
        parties: [],
        firstSeenAt: '2026-02-01T00:00:00Z',
        lastSeenAt: '2026-02-28T00:00:00Z',
        confidence: 0.95,
        links: itemIds.map((id) => ({ sourceItemId: id, method: 'codename', confidence: 0.95 })),
      },
    ],
  });
  if (error) throw new Error(`candidate upsert failed: ${error.message}`);
  const { data, error: readError } = await db
    .from('deal_candidates')
    .select('id')
    .eq('tenant_id', harness.tenantId)
    .eq('cluster_key', key)
    .single();
  if (readError || !data) throw new Error(`candidate lookup failed: ${readError?.message}`);
  return data.id as string;
}

async function promote(persona: Persona, candidateId: string, codename: string): Promise<{ id: string; code: string }> {
  harness.sessionFor(persona);
  const res = await promoteRoute(
    new Request('http://localhost/api/v1/deals/from-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId,
        codename,
        targetName: 'Northwind Robotics',
        entryStepSeq: ENTRY_SEQ,
        conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: today() },
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { deal: { id: string; code: string } }).deal;
}

/** The admin's own session, as the card does it (the route is a thin wrapper over these RPCs). */
async function asAdmin<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await harness.sessionFor('admin').rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data as T;
}

const state = {
  teamMailboxId: '',
  teamSourceId: '',
  bobSourceId: '',
  teamOnly: [] as string[],
  shared: '',
  bobOnly: '',
  heron: '',
  heronDeal: { id: '', code: '' },
};

let previousFlag: { enabled: boolean } | null = null;

beforeAll(async () => {
  await harness.setup();
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'company_access_management').maybeSingle();
  previousFlag = data as { enabled: boolean } | null;
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'company_access_management', description: 'company access (integration)', enabled: true }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);

  // The firm's Google registration: the team inbox is a Google address on a domain of its own.
  const bank = await db.from('companies').select('id').eq('tenant_id', harness.tenantId).eq('type', 'bank').single();
  if (bank.error || !bank.data) throw new Error(`bank lookup failed: ${bank.error?.message}`);
  const registration = await db.from('google_reader_registrations').insert({
    tenant_id: harness.tenantId,
    workspace_domain: 'team.example',
    service_account_email: 'dwd-reader@proj-15.iam.gserviceaccount.com',
    client_id: '723456789012345680',
    directory_service_account_email: 'dir-reader@proj-15.iam.gserviceaccount.com',
    allowlist_group: 'conductia-ingest@team.example',
    firm_company_id: bank.data.id,
    status: 'active',
    consented_at: new Date().toISOString(),
  });
  if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);
  state.bobSourceId = await harness.sourceIdOf(BOB_ADDRESS);
});

afterAll(async () => {
  await db.from('google_reader_registrations').delete().eq('tenant_id', harness.tenantId);
  if (previousFlag) await db.from('feature_flags').update({ enabled: previousFlag.enabled }).eq('key', 'company_access_management');
  else await db.from('feature_flags').delete().eq('key', 'company_access_management');
  await harness.cleanup();
});

describe('A team inbox: connect, check, persist', () => {
  it('connects deals@ as the firm admin, and the allowlist holds it only once the Directory check is recorded', async () => {
    const out = await asAdmin<{ created: boolean; teamMailbox: { id: string; sourceId: string; checkStatus: string } }>(
      'discovery_connect_team_mailbox',
      { p_address: TEAM_ADDRESS, p_attestation_version: 1, p_backfill_since: null },
    );
    expect(out.created).toBe(true);
    expect(out.teamMailbox.checkStatus).toBe('pending');
    state.teamMailboxId = out.teamMailbox.id;
    state.teamSourceId = out.teamMailbox.sourceId;

    const before = await db.from('allowed_team_mailboxes').select('team_mailbox_id').eq('tenant_id', harness.tenantId);
    expect(before.error).toBeNull();
    expect(before.data).toEqual([]);

    const checked = await db.rpc('discovery_record_team_mailbox_check', {
      p_id: state.teamMailboxId,
      p_status: 'verified',
      p_reason: null,
      p_directory_user_id: `dir-${RUN}`,
    });
    expect(checked.error, checked.error?.message).toBeNull();
    const after = await db.from('allowed_team_mailboxes').select('team_mailbox_id, address').eq('tenant_id', harness.tenantId);
    expect(after.data).toEqual([{ team_mailbox_id: state.teamMailboxId, address: TEAM_ADDRESS }]);
  });

  it('persists the team items and a candidate they share with Bob\'s own mailbox', async () => {
    state.teamOnly = await seedItems('team', TEAM_ONLY, [state.teamSourceId]);
    [state.shared] = await seedItems('shared', 1, [state.teamSourceId, state.bobSourceId]);
    [state.bobOnly] = await seedItems('bob', 1, [state.bobSourceId]);
    state.heron = await upsertCandidate(`codename:heron-${RUN}`, 'Project Heron', [...state.teamOnly, state.shared, state.bobOnly]);
    const links = await db.from('evidence_links').select('source_item_id').eq('candidate_id', state.heron);
    expect(links.data).toHaveLength(TEAM_ONLY + 2);
    // Bob's personal mailbox gave him a visibility row; the team inbox has no member yet.
    const rows = await db.from('candidate_visibility').select('person_id, source_item_count').eq('candidate_id', state.heron);
    expect(rows.data).toEqual([{ person_id: harness.users.bob.id, source_item_count: 2 }]);
  });
});

describe('Who sees the candidate and its mail', () => {
  it('shows nobody but Bob anything before a member is added, and Bob only his own two messages', async () => {
    for (const persona of ['alice', 'colleague', 'admin'] as const) {
      expect((await candidatesAs(persona)).list, persona).toEqual([]);
    }
    const bob = (await candidatesAs('bob')).list;
    expect(bob).toHaveLength(1);
    expect(bob[0]).toMatchObject({ id: state.heron, evidenceCount: 2, ownEvidenceCount: 2 });
  });

  it('adds Alice: she sees the team evidence, the shared message and Bob\'s as metadata; Bob and the others see what they saw', async () => {
    await asAdmin('discovery_add_team_mailbox_member', { p_id: state.teamMailboxId, p_user: harness.users.alice.id });

    const alice = (await candidatesAs('alice')).list;
    expect(alice).toHaveLength(1);
    // Her own evidence is the inbox's messages (the five and the shared one); Bob's own message is a colleague's metadata.
    expect(alice[0]).toMatchObject({ id: state.heron, evidenceCount: TEAM_ONLY + 2, ownEvidenceCount: TEAM_ONLY + 1 });

    const bob = (await candidatesAs('bob')).list;
    expect(bob[0]).toMatchObject({ id: state.heron, evidenceCount: 2, ownEvidenceCount: 2 });
    for (const persona of ['colleague', 'admin'] as const) {
      expect((await candidatesAs(persona)).list, persona).toEqual([]);
    }
  });

  it('lets the member promote it with a phase, and seats a non-member and Bob on the deal', async () => {
    state.heronDeal = await promote('alice', state.heron, 'Project Heron');
    await addDealMembers(db, state.heronDeal.id, [harness.users.colleague.id, harness.users.bob.id], 'deal_team');
    const seats = (await db.from('deal_memberships').select('user_id').eq('deal_id', state.heronDeal.id)).data ?? [];
    expect(seats.map((s) => s.user_id).sort()).toEqual(
      [harness.users.alice.id, harness.users.colleague.id, harness.users.bob.id].sort(),
    );
  });

  it('gives the member every message, the team ones with their text; gives Bob only his two; gives the seated non-member and the admin nothing', async () => {
    const alice = await dealEmailAs('alice', state.heronDeal.code);
    expect(alice.status).toBe(200);
    expect(alice.items.map((i) => i.sourceItemId).sort()).toEqual(
      [...state.teamOnly, state.shared, state.bobOnly].sort(),
    );
    // Hers: the inbox's messages, text and all. Bob's own message is metadata only.
    for (const item of alice.items) {
      const team = state.teamOnly.includes(item.sourceItemId) || item.sourceItemId === state.shared;
      expect(item.own, item.sourceItemId).toBe(team);
      expect(item.subject === null, item.sourceItemId).toBe(!team);
    }

    const bob = await dealEmailAs('bob', state.heronDeal.code);
    expect(bob.items.map((i) => i.sourceItemId).sort()).toEqual([state.shared, state.bobOnly].sort());
    expect(bob.items.every((i) => i.own)).toBe(true);
    // No team-only subject or sender reaches Bob's payload, nor a row for a team-only message.
    const payload = JSON.stringify(bob);
    for (let i = 0; i < TEAM_ONLY; i++) expect(payload).not.toContain(`team message ${i}`);
    for (const id of state.teamOnly) expect(payload).not.toContain(id);

    expect(await dealEmailAs('colleague', state.heronDeal.code)).toMatchObject({ status: 200, items: [], truncated: false });
    expect(await dealEmailAs('admin', state.heronDeal.code)).toMatchObject({ status: 200, items: [], truncated: false });
  });

  it('takes it all away on Remove and gives it back on Add, with no job', async () => {
    await asAdmin('discovery_remove_team_mailbox_member', { p_id: state.teamMailboxId, p_user: harness.users.alice.id });
    // (The candidate is promoted, so no list shows it any more: the deal email is what the removal empties.)
    expect(await dealEmailAs('alice', state.heronDeal.code)).toMatchObject({ status: 200, items: [], truncated: false });
    // The removal did not touch the deal or Alice's seat on it, or what Bob sees.
    const seat = await db.from('deal_memberships').select('user_id').eq('deal_id', state.heronDeal.id).eq('user_id', harness.users.alice.id);
    expect(seat.data).toHaveLength(1);
    expect((await dealEmailAs('bob', state.heronDeal.code)).items).toHaveLength(2);

    await asAdmin('discovery_add_team_mailbox_member', { p_id: state.teamMailboxId, p_user: harness.users.alice.id });
    const back = await dealEmailAs('alice', state.heronDeal.code);
    expect(back.items).toHaveLength(TEAM_ONLY + 2);
  });

  it('ends the member\'s reading when they lose their seat, and a re-seat does not revive it', async () => {
    // Alice is the harness bank's director, and a bank with active members must keep one (company_has_director):
    // the colleague stands in while she is suspended.
    const stand = await db.from('users').update({ company_role: 'director' }).eq('id', harness.users.colleague.id);
    expect(stand.error).toBeNull();
    const { error } = await db.from('users').update({ status: 'suspended' }).eq('id', harness.users.alice.id);
    expect(error).toBeNull();
    const closed = await db
      .from('team_mailbox_members')
      .select('removed_reason')
      .eq('team_mailbox_id', state.teamMailboxId)
      .eq('user_id', harness.users.alice.id)
      .not('removed_at', 'is', null)
      .order('removed_at', { ascending: false })
      .limit(1);
    expect(closed.data).toEqual([{ removed_reason: 'seat_lost' }]);
    await db.from('users').update({ status: 'active' }).eq('id', harness.users.alice.id);
    await db.from('users').update({ company_role: 'member' }).eq('id', harness.users.colleague.id);
    expect((await dealEmailAs('alice', state.heronDeal.code)).items).toEqual([]);
    // The admin adds her again for what follows.
    await asAdmin('discovery_add_team_mailbox_member', { p_id: state.teamMailboxId, p_user: harness.users.alice.id });
    expect((await dealEmailAs('alice', state.heronDeal.code)).items).toHaveLength(TEAM_ONLY + 2);
  });
});

describe('About two thousand links', () => {
  let osprey = '';
  let ospreyDeal = { id: '', code: '' };

  it('lists a member\'s candidate and promotes it within the budget, and shows a non-member nothing of it', async () => {
    const items = await seedItems('scale', SCALE_LINKS, [state.teamSourceId]);
    osprey = await upsertCandidate(`codename:osprey-${RUN}`, 'Project Osprey', items);

    const alice = await candidatesAs('alice');
    expect(alice.list.map((c) => c.id)).toContain(osprey);
    expect(alice.ms, `member candidate list took ${Math.round(alice.ms)} ms`).toBeLessThan(BUDGET_MS);

    // Not Bob (his Heron evidence is a candidate of its own, promoted: not listed), not the colleague, not the admin.
    for (const persona of ['bob', 'colleague', 'admin'] as const) {
      const seen = await candidatesAs(persona);
      expect(seen.list.map((c) => c.id), persona).not.toContain(osprey);
      expect(seen.ms, `${persona} candidate list took ${Math.round(seen.ms)} ms`).toBeLessThan(BUDGET_MS);
    }

    // The detail asks two caller-bound definers about every linked item (the current events, 20261023130400, and
    // the team flag, 20261023130500), each judging app_can_see_item per item: measured here at ~2k links (audit S7).
    const detail = await candidateDetailAs('alice', osprey);
    expect(detail.status).toBe(200);
    expect(detail.ms, `member candidate detail took ${Math.round(detail.ms)} ms`).toBeLessThan(BUDGET_MS);

    ospreyDeal = await promote('alice', osprey, 'Project Osprey');
    await addDealMembers(db, ospreyDeal.id, [harness.users.colleague.id, harness.users.bob.id], 'deal_team');
  });

  it('lists the deal email for the member within the budget (capped at the page), and nothing for a seated non-member', async () => {
    const alice = await dealEmailAs('alice', ospreyDeal.code);
    expect(alice.status).toBe(200);
    expect(alice.items.length).toBeGreaterThan(0);
    expect(alice.truncated).toBe(true);
    expect(alice.ms, `member deal email took ${Math.round(alice.ms)} ms`).toBeLessThan(BUDGET_MS);
    expect(alice.items.every((i) => i.own)).toBe(true);

    for (const persona of ['bob', 'colleague'] as const) {
      const other = await dealEmailAs(persona, ospreyDeal.code);
      expect(other, persona).toMatchObject({ status: 200, items: [], truncated: false });
      expect(other.ms, `${persona} deal email took ${Math.round(other.ms)} ms`).toBeLessThan(BUDGET_MS);
    }
  });
});
