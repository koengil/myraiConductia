import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * #262, PR #300 round 3, A1, against a REAL database: when an address changes
 * hands and the earlier holder's source still holds stored items, the next
 * holder's opt-in archives that source (renamed <address>~xyz, paused,
 * ownerless) and starts a fresh one.
 *
 *   - the worker reads only the fresh source: the archived row is `paused`, so
 *     it is never selected, never handed to a reader, never checkpointed;
 *   - the new holder, signed in, sees none of the earlier holder's items
 *     through PostgREST and RLS, until a firm admin merges the archive into
 *     the live source (discovery_unify_mailbox_sources), after which they do.
 *
 * The SQL suites (supabase/tests/mailbox_allowlist.sql, discovery_rls.sql) pin
 * the archive, the merge and the guard's reasons; this pins the worker and the
 * signed-in read path.
 */

import { READER_MODE } from '@/lib/constants/discovery';
import type { ContentSource, SourceItemPage, SourceRow } from '@/lib/graph/reader';
import { runOnce } from '../../worker/classify';
import {
  createGuardedTenant,
  dropGuardedTenant,
  enableDiscoveryFlag,
  optInOwners,
  registerFixtureReader,
  type GuardedTenant,
  type GuardedTenantEnv,
} from './support/guardedTenant';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The mailbox source archive test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });
const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Archive-${RUN}-x9!` };

const ADDRESS = 'arch-owner@bank.example';
let tenant: GuardedTenant;
let restoreFlag: () => Promise<void>;
let archivedId = '';
let freshId = '';
let itemId = '';

/** An inner reader with nothing to read that records which sources it is asked for. */
function recordingEmptyReader(asked: SourceRow[]): ContentSource {
  const empty = (): AsyncIterable<SourceItemPage> => ({ async *[Symbol.asyncIterator]() {} });
  return {
    kind: 'mailbox',
    backfill(source) {
      asked.push(source);
      return empty();
    },
    delta(source) {
      asked.push(source);
      return empty();
    },
  };
}

beforeAll(async () => {
  restoreFlag = await enableDiscoveryFlag(db);
  tenant = await createGuardedTenant(env, 'arch', [ADDRESS]);
  await registerFixtureReader(env, tenant);

  // The earlier holder's mailbox: no owner, a checkpoint and one stored item.
  const source = await db
    .from('content_sources')
    .insert({
      tenant_id: tenant.id,
      kind: 'mailbox',
      address: ADDRESS,
      owner_user_id: null,
      provider: 'microsoft',
      delta_checkpoint: 'earlier-holder-checkpoint',
    })
    .select('id')
    .single();
  if (source.error) throw new Error(`orphan source failed: ${source.error.message}`);
  archivedId = source.data.id as string;
  const item = await db
    .from('source_items')
    .insert({ tenant_id: tenant.id, kind: 'message', subject: 'Earlier holder', content_hash: 'h', internet_message_id: `<arch-${RUN}@old>` })
    .select('id')
    .single();
  if (item.error) throw new Error(`item failed: ${item.error.message}`);
  itemId = item.data.id as string;
  const link = await db
    .from('source_item_sources')
    .insert({ source_item_id: itemId, content_source_id: archivedId, provider_item_id: 'p1' });
  if (link.error) throw new Error(`provenance failed: ${link.error.message}`);

  // The new holder's own opt-in, under their own session.
  await optInOwners(tenant);
  const fresh = await db
    .from('content_sources')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('address', ADDRESS)
    .single();
  if (fresh.error) throw new Error(`fresh source failed: ${fresh.error.message}`);
  freshId = fresh.data.id as string;
}, 120_000);

afterAll(async () => {
  if (tenant) await dropGuardedTenant(env, tenant);
  await restoreFlag?.();
});

describe('an orphaned source with items is archived, not inherited', () => {
  it('archived the old row and gave the new holder a fresh one', async () => {
    expect(freshId).not.toBe(archivedId);
    const { data } = await db
      .from('content_sources')
      .select('id, address, status, owner_user_id, delta_checkpoint, archived_at, archived_from_address')
      .eq('tenant_id', tenant.id)
      .order('created_at');
    const archived = data?.find((row) => row.id === archivedId);
    expect(archived).toMatchObject({ status: 'paused', owner_user_id: null, archived_from_address: ADDRESS });
    expect(archived?.address).toMatch(/^arch-owner@bank\.example~[a-z0-9]{3}$/);
    expect(archived?.archived_at).not.toBeNull();
    expect(data?.find((row) => row.id === freshId)).toMatchObject({
      address: ADDRESS,
      status: 'active',
      owner_user_id: tenant.ownerIds[0],
      delta_checkpoint: null,
      archived_at: null,
    });
  });

  it('the worker reads only the fresh source and never touches the archived one', async () => {
    const asked: SourceRow[] = [];
    const summary = await runOnce({
      tenantId: tenant.id,
      db,
      provider: READER_MODE.FIXTURE,
      readerFor: () => recordingEmptyReader(asked),
    });
    expect(summary).toMatchObject({ status: 'ok', sources: 1, refused: [] });
    expect(asked.map((source) => source.id)).toEqual([freshId]);
    const { data } = await db
      .from('content_sources')
      .select('delta_checkpoint, last_synced_at, last_error')
      .eq('id', archivedId)
      .single();
    expect(data).toEqual({ delta_checkpoint: 'earlier-holder-checkpoint', last_synced_at: null, last_error: null });
  });

  it('the new holder sees none of the earlier items until a firm admin merges them', async () => {
    const member = tenant.sessions[0];
    const admin = tenant.sessions[tenant.mailboxes.length];
    const before = await member.from('source_items').select('id');
    expect(before.error).toBeNull();
    expect(before.data).toEqual([]);

    // The member is not a firm admin: the merge is refused and moves nothing.
    const refused = await member.rpc('discovery_unify_mailbox_sources', { p_archived: archivedId, p_target: freshId });
    expect(refused.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    expect((await member.from('source_items').select('id')).data).toEqual([]);

    const merged = await admin.rpc('discovery_unify_mailbox_sources', { p_archived: archivedId, p_target: freshId });
    expect(merged.error).toBeNull();
    expect(merged.data).toMatchObject({ moved: 1, alreadyLinked: 0 });
    const after = await member.from('source_items').select('id');
    expect(after.data).toEqual([{ id: itemId }]);

    const again = await admin.rpc('discovery_unify_mailbox_sources', { p_archived: archivedId, p_target: freshId });
    expect(again.error).toMatchObject({ code: 'P0001', message: 'unify_already_unified' });
  });
});
