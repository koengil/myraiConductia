import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * The Deal Folder's Deal email list (#340), against a REAL database:
 *
 *   demo corpus -> runOnce -> POST /api/v1/deals/from-discovery as Alice (Kestrel at
 *   step 44) -> GET /api/v1/discovery/deal-email as each persona.
 *
 * What is real: the classification worker, the Supabase store, the route handlers, the
 * promotion definer, RLS and Postgres. What is faked: how a handler obtains the signed-in
 * client (the cookie layer needs Next). RLS is the only access decision, so every case
 * below is a different session reading the same deal:
 *
 *   alice     the owner: her mailbox holds every Kestrel message, so every row is hers
 *   colleague seated, owns some of the Kestrel mail: a mix, row by row (shared mail is
 *             hers, Storm-only mail is metadata only)
 *   bob       seated, but cannot see the candidate: nothing
 *   cco       an overseer who owns no mailbox: every row metadata only
 *   colleague before being seated on the deal: nothing (deals_select)
 *
 * "Own" is asserted against service-role source_item_sources ownership, not against a
 * blanket null check.
 */

import { createDiscoveryTenant, type Persona } from './helpers/discoveryTenant';
import { addDealMembers } from './support/guardedTenant';

const harness = createDiscoveryTenant('de');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { POST as promoteRoute } from '@/app/api/v1/deals/from-discovery/route';
import { GET as candidatesRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as dealEmailRoute } from '@/app/api/v1/discovery/deal-email/route';
import { GET as dealThreadRoute } from '@/app/api/v1/discovery/deal-email/thread/route';

const { db } = harness;

const ENTRY_SEQ = 48; // LOI Review, step 44
const today = () => new Date().toISOString().slice(0, 10);

type Row = {
  sourceItemId: string;
  sentDay: string | null;
  fromDomain: string | null;
  sender: string | null;
  subject: string | null;
  own: boolean;
};
type Listing = { status: number; items: Row[]; truncated: boolean };

async function dealEmail(persona: Persona, code: string): Promise<Listing> {
  harness.sessionFor(persona);
  const res = await dealEmailRoute(new Request(`http://localhost/api/v1/discovery/deal-email?deal=${encodeURIComponent(code)}`));
  const body = (await res.json()) as { items?: Row[]; truncated?: boolean };
  return { status: res.status, items: body.items ?? [], truncated: body.truncated ?? false };
}

type ThreadMessage = { sourceItemId: string; subject: string; body: string; internetMessageId: string | null };

async function dealThread(persona: Persona, code: string, item: string): Promise<{ status: number; messages: ThreadMessage[] }> {
  harness.sessionFor(persona);
  const res = await dealThreadRoute(
    new Request(`http://localhost/api/v1/discovery/deal-email/thread?deal=${encodeURIComponent(code)}&item=${item}`),
  );
  const body = (await res.json()) as { messages?: ThreadMessage[] };
  return { status: res.status, messages: body.messages ?? [] };
}

/** The users whose mailboxes hold each item, from the service-role provenance (content_sources.owner_user_id). */
async function ownersByItem(itemIds: string[]): Promise<Map<string, Set<string>>> {
  const { data, error } = await db
    .from('source_item_sources')
    .select('source_item_id, content_sources(owner_user_id)')
    .in('source_item_id', itemIds);
  if (error) throw new Error(`provenance lookup failed: ${error.message}`);
  const owners = new Map<string, Set<string>>();
  for (const row of (data ?? []) as unknown as Array<{ source_item_id: string; content_sources: { owner_user_id: string | null } | null }>) {
    const set = owners.get(row.source_item_id) ?? new Set<string>();
    if (row.content_sources?.owner_user_id) set.add(row.content_sources.owner_user_id);
    owners.set(row.source_item_id, set);
  }
  return owners;
}

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

describe('Deal email: RLS decides what each reader sees of a promoted deal', () => {
  let deal = { id: '', code: '' };
  let kestrelItems: string[] = [];

  it('promotes Kestrel at step 44 as Alice, who alone is seated on the new deal', async () => {
    await harness.seedDemo();
    harness.sessionFor('alice');
    const list = await candidatesRoute();
    const kestrel = ((await list.json()).candidates as Array<{ id: string; name: string }>).find((c) => c.name === 'Project Kestrel');
    if (!kestrel) throw new Error('alice does not see Project Kestrel');

    const res = await promoteRoute(
      new Request('http://localhost/api/v1/deals/from-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId: kestrel.id,
          codename: 'Project Kestrel',
          targetName: 'Northwind Robotics',
          entryStepSeq: ENTRY_SEQ,
          conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: today() },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    deal = { id: body.deal.id, code: body.deal.code };

    const links = (await db.from('evidence_links').select('source_item_id').eq('candidate_id', kestrel.id).neq('state', 'rejected')).data ?? [];
    kestrelItems = links.map((l) => l.source_item_id as string);
    expect(kestrelItems.length).toBeGreaterThan(0);
  });

  it('shows a colleague who is not seated on the deal nothing, not even that it exists', async () => {
    expect(await dealEmail('colleague', deal.code)).toEqual({ status: 200, items: [], truncated: false });
    expect(await dealEmail('colleague', 'NO-SUCH-DEAL-000')).toEqual({ status: 200, items: [], truncated: false });
  });

  it('seats the colleague and Bob on the promoted deal', async () => {
    await addDealMembers(db, deal.id, [harness.users.colleague.id, harness.users.bob.id], 'deal_team');
    const seats = (await db.from('deal_memberships').select('user_id').eq('deal_id', deal.id)).data ?? [];
    expect(seats.map((s) => s.user_id).sort()).toEqual(
      [harness.users.alice.id, harness.users.colleague.id, harness.users.bob.id].sort(),
    );
  });

  it('lists every linked message to the owner, newest first, with sender and subject', async () => {
    const listing = await dealEmail('alice', deal.code);
    expect(listing.status).toBe(200);
    expect(listing.truncated).toBe(false);
    // Only messages, each once, and exactly the candidate's live links.
    expect(listing.items.map((i) => i.sourceItemId).sort()).toEqual([...new Set(kestrelItems)].sort());
    const owners = await ownersByItem(listing.items.map((i) => i.sourceItemId));
    for (const item of listing.items) {
      const mine = owners.get(item.sourceItemId)?.has(harness.users.alice.id) ?? false;
      expect(item.own, item.sourceItemId).toBe(mine);
      if (mine) {
        expect(item.subject, item.sourceItemId).toEqual(expect.any(String));
        expect(item.sender, item.sourceItemId).toEqual(expect.any(String));
      } else {
        expect(item.subject).toBeNull();
        expect(item.sender).toBeNull();
      }
      expect(item.sentDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.fromDomain).toEqual(expect.any(String));
    }
    expect(listing.items.some((i) => i.own)).toBe(true);
    const days = listing.items.map((i) => i.sentDay ?? '');
    expect(days).toEqual([...days].sort().reverse());
  });

  it("gives the seated colleague a mix, row by row: the mail her mailbox holds is hers, Storm's alone is metadata only", async () => {
    const aliceView = await dealEmail('alice', deal.code);
    const listing = await dealEmail('colleague', deal.code);
    expect(listing.status).toBe(200);
    expect(listing.items.length).toBeGreaterThan(0);
    // What she may see is no more than what the owner sees.
    const aliceIds = new Set(aliceView.items.map((i) => i.sourceItemId));
    for (const item of listing.items) expect(aliceIds.has(item.sourceItemId)).toBe(true);

    const owners = await ownersByItem(listing.items.map((i) => i.sourceItemId));
    for (const item of listing.items) {
      const mine = owners.get(item.sourceItemId)?.has(harness.users.colleague.id) ?? false;
      expect(item.own, item.sourceItemId).toBe(mine);
      expect(item.subject === null, item.sourceItemId).toBe(!mine);
      expect(item.sender === null, item.sourceItemId).toBe(!mine);
    }
    expect(listing.items.some((i) => i.own)).toBe(true); // the shared Kestrel mail
    expect(listing.items.some((i) => !i.own)).toBe(true); // Storm-only mail: metadata only
    // A redacted row still says when and from which domain.
    for (const item of listing.items.filter((i) => !i.own)) {
      expect(item.sentDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.fromDomain).toEqual(expect.any(String));
    }
    // The subjects of mail she does not own appear nowhere in her payload.
    const hidden = aliceView.items.filter((a) => a.own && !listing.items.find((c) => c.sourceItemId === a.sourceItemId)?.own);
    expect(hidden.length).toBeGreaterThan(0);
    // Subjects can repeat across messages ("Project Kestrel: NDA" on two), so only a subject she holds on no
    // row of her own proves a leak by its text; the per-row check above covers the rest.
    const ownSubjects = new Set(listing.items.filter((i) => i.own).map((i) => i.subject));
    const payload = JSON.stringify(listing);
    for (const row of hidden.filter((h) => !ownSubjects.has(h.subject))) expect(payload).not.toContain(row.subject as string);
  });

  it('shows Bob, who is seated but cannot see the candidate, nothing', async () => {
    expect(await dealEmail('bob', deal.code)).toEqual({ status: 200, items: [], truncated: false });
  });

  it('shows the CCO, an overseer who owns no mailbox, every row as metadata only', async () => {
    const aliceView = await dealEmail('alice', deal.code);
    const listing = await dealEmail('cco', deal.code);
    expect(listing.status).toBe(200);
    expect(listing.items.map((i) => i.sourceItemId)).toEqual(aliceView.items.map((i) => i.sourceItemId));
    for (const item of listing.items) {
      expect(item).toMatchObject({ own: false, subject: null, sender: null });
      expect(item.sentDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.fromDomain).toEqual(expect.any(String));
    }
    const payload = JSON.stringify(listing);
    for (const row of aliceView.items.filter((a) => a.subject)) expect(payload).not.toContain(row.subject as string);
  });

  it('shows a firm admin nothing: oversight of the deal does not extend to its mail', async () => {
    expect(await dealEmail('admin', deal.code)).toEqual({ status: 200, items: [], truncated: false });
  });

  describe('the thread pane (#339)', () => {
    /** The conversation each item belongs to, from the service role. */
    async function conversations(itemIds: string[]): Promise<Map<string, string | null>> {
      const { data, error } = await db.from('source_items').select('id, conversation_id').in('id', itemIds);
      if (error) throw new Error(`conversation lookup failed: ${error.message}`);
      return new Map((data ?? []).map((r) => [r.id as string, (r.conversation_id as string | null) ?? null]));
    }

    it("opens an owner's thread: only her own deal-linked messages of that conversation, each with a body", async () => {
      const listing = await dealEmail('alice', deal.code);
      const opened = listing.items.find((i) => i.own);
      if (!opened) throw new Error('alice owns no row');
      const thread = await dealThread('alice', deal.code, opened.sourceItemId);
      expect(thread.status).toBe(200);
      const ids = thread.messages.map((m) => m.sourceItemId);
      expect(ids).toContain(opened.sourceItemId);
      const owners = await ownersByItem(ids);
      const conv = await conversations([opened.sourceItemId, ...ids]);
      for (const message of thread.messages) {
        expect(kestrelItems, message.sourceItemId).toContain(message.sourceItemId);
        expect(owners.get(message.sourceItemId)?.has(harness.users.alice.id), message.sourceItemId).toBe(true);
        expect(conv.get(message.sourceItemId)).toBe(conv.get(opened.sourceItemId));
        expect(message.body.length, message.sourceItemId).toBeGreaterThan(0);
      }
    });

    it("answers the colleague 404 for a message only Storm's mailbox holds, and her own thread with her mail only", async () => {
      const listing = await dealEmail('colleague', deal.code);
      const notHers = listing.items.find((i) => !i.own);
      const hers = listing.items.find((i) => i.own);
      if (!notHers || !hers) throw new Error('expected a mix for the colleague');
      expect((await dealThread('colleague', deal.code, notHers.sourceItemId)).status).toBe(404);

      const thread = await dealThread('colleague', deal.code, hers.sourceItemId);
      expect(thread.status).toBe(200);
      const owners = await ownersByItem(thread.messages.map((m) => m.sourceItemId));
      for (const message of thread.messages) {
        expect(owners.get(message.sourceItemId)?.has(harness.users.colleague.id), message.sourceItemId).toBe(true);
      }
    });

    it('answers Bob, the CCO and a firm admin the same 404 for a message Alice owns, and anyone 404 off the deal', async () => {
      const opened = (await dealEmail('alice', deal.code)).items.find((i) => i.own);
      if (!opened) throw new Error('alice owns no row');
      for (const persona of ['bob', 'cco', 'admin'] as const) {
        expect(await dealThread(persona, deal.code, opened.sourceItemId), persona).toEqual({ status: 404, messages: [] });
      }
      expect(await dealThread('alice', 'NO-SUCH-DEAL-000', opened.sourceItemId)).toEqual({ status: 404, messages: [] });
    });
  });
});
