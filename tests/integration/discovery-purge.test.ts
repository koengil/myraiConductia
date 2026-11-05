import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * #461 against a REAL database: every way a banker's consent ends deletes the
 * mail stored from their mailbox, and what a colleague's mailbox also holds
 * stays with theirs.
 *
 *   demo corpus -> runOnce (fixture readers) -> three bankers' mailboxes, with shared threads
 *   1. Morgan withdraws through DELETE /api/v1/discovery/mailbox-consent; the message index the read
 *      wrote goes with her mailbox, and Storm's stays
 *   2. Alex loses his seat through DELETE /api/v1/companies/{id}/members/{userId}
 *   3. A late page's orphan is collected by the tick's backstop, with the flags off
 *   4. Storm leaves the provider group: the tick records that it saw her there, then
 *      the absence, and withdraws only once the absence is older than the 72-hour grace
 *      (an address never seen in the group is not withdrawn)
 *
 * What is real: the worker's tick, the routes, the triggers, RLS, Postgres. What
 * is faked: how a handler obtains the signed-in client, the provider group (the
 * fixture mirror), the job queue, and the late page (its effect is inserted).
 */

import { createDiscoveryTenant } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('purge');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { DELETE as removeMember } from '@/app/api/v1/companies/[companyId]/members/[userId]/route';
import { DELETE as withdraw } from '@/app/api/v1/discovery/mailbox-consent/route';
import { READER_MODE } from '@/lib/constants/discovery';
import { createFixtureAllowlistMirror } from '@/lib/mailboxAccess';
import { createWorkerHandlers } from '../../worker/classify';

const { db, tenantId, users } = harness;
const STORM = 'storm.duncan@bank.example';
const WORKER_FLAG = 'discovery_worker_enabled';
let previousWorker: { enabled: boolean } | null = null;

async function setWorkerFlag(enabled: boolean): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: WORKER_FLAG, description: 'discovery worker (integration)', enabled }, { onConflict: 'key' });
  if (error) throw new Error(`worker flag failed: ${error.message}`);
}

/** Every stored message's holders (mailbox source ids), and every candidate's evidence items. */
async function snapshot() {
  const { data: sources } = await db.from('content_sources').select('id').eq('tenant_id', tenantId);
  const { data: prov } = await db
    .from('source_item_sources')
    .select('source_item_id, content_source_id')
    .in('content_source_id', (sources ?? []).map((s) => s.id as string));
  const holders = new Map<string, Set<string>>();
  for (const row of prov ?? []) {
    const set = holders.get(row.source_item_id as string) ?? new Set<string>();
    set.add(row.content_source_id as string);
    holders.set(row.source_item_id as string, set);
  }
  const { data: candidates } = await db.from('deal_candidates').select('id').eq('tenant_id', tenantId);
  const { data: links } = await db
    .from('evidence_links')
    .select('candidate_id, source_item_id')
    .in('candidate_id', (candidates ?? []).map((c) => c.id as string));
  const evidence = new Map<string, string[]>();
  for (const link of links ?? []) {
    evidence.set(link.candidate_id as string, [...(evidence.get(link.candidate_id as string) ?? []), link.source_item_id as string]);
  }
  return { holders, evidence };
}

/** What the source alone holds, what it shares, and the candidates resting only on what it alone holds. */
async function shareOf(sourceId: string) {
  const { holders, evidence } = await snapshot();
  const sole = [...holders].filter(([, set]) => set.size === 1 && set.has(sourceId)).map(([id]) => id);
  const shared = [...holders].filter(([, set]) => set.size > 1 && set.has(sourceId)).map(([id]) => id);
  const doomed = [...evidence].filter(([, items]) => items.every((id) => sole.includes(id))).map(([id]) => id);
  const kept = [...evidence].map(([id]) => id).filter((id) => !doomed.includes(id));
  return { sole, shared, doomed, kept };
}

async function count(table: string, column: string, ids: string[]): Promise<number> {
  const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true }).in(column, ids);
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return n ?? 0;
}

async function purgeRow(sourceId: string) {
  const { data } = await db
    .from('audit_log')
    .select('actor_id, actor_type, service_identity, detail')
    .eq('tenant_id', tenantId)
    .eq('action', 'discovery.mailbox_purged')
    .eq('detail->>sourceId', sourceId);
  expect(data).toHaveLength(1);
  return data![0] as { actor_id: string | null; actor_type: string; service_identity: string | null; detail: Record<string, unknown> };
}

const tick = (mirror = createFixtureAllowlistMirror(db)) =>
  createWorkerHandlers({ db, boss: { send: vi.fn(async () => null) }, provider: READER_MODE.FIXTURE, mirror }).tick();

beforeAll(async () => {
  await harness.setup();
  const { data } = await db.from('feature_flags').select('enabled').eq('key', WORKER_FLAG).maybeSingle();
  previousWorker = data as { enabled: boolean } | null;
  await harness.seedDemo();
});

afterAll(async () => {
  if (previousWorker) await setWorkerFlag(previousWorker.enabled);
  else await db.from('feature_flags').delete().eq('key', WORKER_FLAG);
  await harness.cleanup();
});

describe('a banker whose consent ends loses the mail stored from their mailbox (#461)', () => {
  it('Morgan withdraws through the route: her sole-held mail goes, shared mail stays with Storm, and the body says what went', async () => {
    const morgan = await harness.sourceIdOf('morgan.vale@bank.example');
    const storm = await harness.sourceIdOf(STORM);
    const { sole, shared, doomed, kept } = await shareOf(morgan);
    expect(sole.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);
    expect(doomed.length).toBeGreaterThan(0);
    const stormHeld = await count('source_item_sources', 'content_source_id', [storm]);
    // The read indexed every message it processed, routed or not, one row per mailbox (#461 slice 5).
    const morganIndexed = await count('discovery_message_index', 'content_source_id', [morgan]);
    const stormIndexed = await count('discovery_message_index', 'content_source_id', [storm]);
    expect(morganIndexed).toBeGreaterThanOrEqual(sole.length + shared.length);
    expect(stormIndexed).toBeGreaterThan(0);

    harness.sessionFor('colleague');
    const res = await withdraw();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      consented: false,
      purged: { items: sole.length, candidates: doomed.length, indexRows: morganIndexed },
    });
    expect(Object.keys(body.purged)).not.toContain('runId');

    expect(await count('content_sources', 'id', [morgan])).toBe(0);
    expect(await count('source_items', 'id', sole)).toBe(0);
    expect(await count('source_item_texts', 'source_item_id', sole)).toBe(0);
    expect(await count('source_items', 'id', shared)).toBe(shared.length);
    expect(await count('source_item_sources', 'content_source_id', [storm])).toBe(stormHeld);
    expect(await count('deal_candidates', 'id', doomed)).toBe(0);
    expect(await count('deal_candidates', 'id', kept)).toBe(kept.length);
    expect(await count('discovery_message_index', 'content_source_id', [morgan])).toBe(0);
    expect(await count('discovery_message_index', 'content_source_id', [storm])).toBe(stormIndexed);

    const row = await purgeRow(morgan);
    expect(row).toMatchObject({ actor_id: users.colleague.id, actor_type: 'user', detail: { reason: 'withdrawn', items: sole.length } });
  });

  it('Alex loses his seat through the members route: the same purge, reason seat_lost', async () => {
    const alex = await harness.sourceIdOf('alex.chen@bank.example');
    const { sole } = await shareOf(alex);
    const { data: director } = await db.from('users').select('company_id').eq('id', users.alice.id).single();

    harness.sessionFor('alice');
    const res = await removeMember(new Request('http://localhost/', { method: 'DELETE' }), {
      params: Promise.resolve({ companyId: director!.company_id as string, userId: users.bob.id }),
    });
    expect(res.status).toBe(200);

    expect(await count('content_sources', 'id', [alex])).toBe(0);
    expect(await count('source_items', 'id', sole)).toBe(0);
    const row = await purgeRow(alex);
    expect(row).toMatchObject({ actor_type: 'service', service_identity: 'mailbox-consent', detail: { reason: 'seat_lost' } });
  });

  it('collects a late page\'s orphan on the next tick, with the reader flags off', async () => {
    // The effect of a page read while its source was purged: the item was written, its provenance refused.
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const { data: item, error } = await db
      .from('source_items')
      .insert({ tenant_id: tenantId, kind: 'message', subject: 'Project Late: teaser', internet_message_id: `<late-${tenantId}@bank.example>`,
                content_hash: 'h-late', sent_at: old, created_at: old })
      .select('id')
      .single();
    if (error) throw new Error(`late item failed: ${error.message}`);
    await db.from('source_item_texts').insert({ source_item_id: item.id, body_text: 'late body' });

    await harness.setFlag(false);
    try {
      await expect(tick()).resolves.toEqual({ queued: 0 });
    } finally {
      await harness.setFlag(true);
    }
    expect(await count('source_items', 'id', [item.id as string])).toBe(0);
    const { data: audit } = await db
      .from('audit_log')
      .select('service_identity, detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.content_collected');
    expect(audit).toEqual([expect.objectContaining({ service_identity: 'discovery-worker', detail: expect.objectContaining({ items: 1 }) })]);
  });

  it('Storm leaves the provider group: only an address seen in the group, then missing past the 72-hour grace, is held, then withdrawn on release', async () => {
    await setWorkerFlag(true);
    const storm = await harness.sourceIdOf(STORM);
    const mirror = createFixtureAllowlistMirror(db, { drop: [STORM] });
    const absence = () =>
      db
        .from('mailbox_group_absence')
        .select('provider, first_seen_in_group, missing_since')
        .eq('tenant_id', tenantId)
        .eq('address', STORM);
    const open = () => db.from('mailbox_consents').select('id').eq('tenant_id', tenantId).eq('address', STORM).is('withdrawn_at', null);

    // She has consented and is not in the group yet: no sighting, so there is nothing to withdraw her for. (The demo
    // seed's reader pass already saw her in the group; clearing that is the state of a banker who has just consented.)
    await db.from('mailbox_group_absence').delete().eq('tenant_id', tenantId);
    await tick(mirror);
    expect((await absence()).data).toEqual([]);

    // The group gains her: a sighting. Then it loses her: the absence follows the sighting.
    await tick();
    expect((await absence()).data).toEqual([expect.objectContaining({ provider: 'microsoft', missing_since: null })]);
    await tick(mirror);
    const [recorded] = (await absence()).data as Array<{ first_seen_in_group: string; missing_since: string }>;
    expect(Date.parse(recorded.missing_since)).toBeGreaterThan(Date.parse(recorded.first_seen_in_group));
    expect((await open()).data).toHaveLength(1);

    // Three days later, still missing on a fresh check.
    const since = new Date(Date.now() - 73 * 3_600_000).toISOString();
    const seen = new Date(Date.now() - 100 * 3_600_000).toISOString();
    await db.from('mailbox_group_absence').update({ first_seen_in_group: seen, missing_since: since }).eq('tenant_id', tenantId);
    await tick(mirror);

    // The pilot breaker (owner, 2026-10-17): the tick holds her withdrawal until the operator confirms it.
    expect((await open()).data).toHaveLength(1);
    const { data: held } = await db
      .from('audit_log')
      .select('detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.group_removal_held');
    expect(held).toEqual([{ detail: expect.objectContaining({ due: 1, maxShare: 0, minDue: 1 }) }]);
    const release = await db.rpc('discovery_withdraw_group_removed', { p_max_share: 1 });
    expect(release.error).toBeNull();
    expect(release.data).toMatchObject({ withdrawn: 1 });

    expect((await open()).data).toEqual([]);
    expect((await absence()).data).toEqual([]);
    expect(await count('content_sources', 'id', [storm])).toBe(0);
    expect((await purgeRow(storm)).detail).toMatchObject({ reason: 'group_removed' });
    // Every mailbox is gone, so is every stored message and every candidate.
    const { count: messages } = await db
      .from('source_items')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('kind', 'message');
    expect(messages).toBe(0);
    const { count: candidates } = await db.from('deal_candidates').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    expect(candidates).toBe(0);
  });
});
