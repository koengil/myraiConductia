import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * #262, PR #300 round 4 (Codex 3), against a REAL database: a worker that passed the guard for the earlier holder
 * of an address can still be writing its page after the new holder's opt-in has archived the source. The database
 * refuses the page's provenance link for the archived source (source_archived), and the worker reports that source
 * as skipped for the pass, completing the rest of it, instead of attaching the page to the archive or crashing.
 *
 * The archive is the real thing: the reader hook clears the owner (the earlier holder is gone), withdraws the
 * earlier consent and runs mailbox_consent_grant under the new holder's own session, between the guard's check
 * and the page's persistence.
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
    'The in-flight archive test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });
const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Inflight-${RUN}-x9!` };

const ADDRESS = 'inflight-owner@bank.example';
let tenant: GuardedTenant;
let restoreFlag: () => Promise<void>;
let sourceId = '';
let earlierItemId = '';

const PAGE: SourceItemPage = {
  items: [
    {
      id: 'g-late-1',
      internetMessageId: `<inflight-${RUN}@bank.example>`,
      conversationId: 'c-late',
      subject: 'Project Falcon: late page',
      sentDateTime: '2026-10-01T09:00:00Z',
      from: { emailAddress: { address: ADDRESS } },
      toRecipients: [{ emailAddress: { address: 'banker@other.example' } }],
      ccRecipients: [],
      body: { contentType: 'text', content: 'Project Falcon terms, read before the archive.' },
    },
  ],
  nextCheckpoint: 'after-late-page',
};

/**
 * An inner reader that archives the source between the guard's check (before the page is requested) and the
 * page's persistence: the new holder opts in while this page is in flight.
 */
function archivingReader(asked: SourceRow[]): ContentSource {
  const read = (source: SourceRow): AsyncIterable<SourceItemPage> => ({
    async *[Symbol.asyncIterator]() {
      asked.push(source);
      const session = tenant.sessions[0];
      // The owner is cleared first (the earlier holder is gone), so the withdrawal finds no source of theirs to
      // purge (#461) and the history stays for the archive.
      const orphaned = await db.from('content_sources').update({ owner_user_id: null }).eq('id', source.id);
      if (orphaned.error) throw new Error(`orphan failed: ${orphaned.error.message}`);
      const withdrawn = await session.rpc('mailbox_consent_withdraw');
      if (withdrawn.error) throw new Error(`withdraw failed: ${withdrawn.error.message}`);
      const granted = await session.rpc('mailbox_consent_grant');
      if (granted.error) throw new Error(`grant failed: ${granted.error.message}`);
      yield PAGE;
    },
  });
  return { kind: 'mailbox', backfill: (source) => read(source), delta: (source) => read(source) };
}

beforeAll(async () => {
  restoreFlag = await enableDiscoveryFlag(db);
  tenant = await createGuardedTenant(env, 'infl', [ADDRESS]);
  await registerFixtureReader(env, tenant);
  await optInOwners(tenant);   // the earlier holder's own source, owned and read
  const source = await db.from('content_sources').select('id').eq('tenant_id', tenant.id).eq('address', ADDRESS).single();
  if (source.error) throw new Error(`source failed: ${source.error.message}`);
  sourceId = source.data.id as string;
  // It already holds one stored item, so the next opt-in archives it rather than taking it over.
  const item = await db
    .from('source_items')
    .insert({ tenant_id: tenant.id, kind: 'message', subject: 'Earlier holder', content_hash: 'h', internet_message_id: `<inflight-old-${RUN}@old>` })
    .select('id')
    .single();
  if (item.error) throw new Error(`item failed: ${item.error.message}`);
  earlierItemId = item.data.id as string;
  const link = await db.from('source_item_sources').insert({ source_item_id: earlierItemId, content_source_id: sourceId, provider_item_id: 'p1' });
  if (link.error) throw new Error(`provenance failed: ${link.error.message}`);
}, 120_000);

afterAll(async () => {
  if (tenant) await dropGuardedTenant(env, tenant);
  await restoreFlag?.();
});

describe('a page that lands after the source was archived', () => {
  it('is refused for that source, the pass completes, and the archive keeps only the history it had', async () => {
    const asked: SourceRow[] = [];
    const summary = await runOnce({
      tenantId: tenant.id,
      db,
      provider: READER_MODE.FIXTURE,
      readerFor: () => archivingReader(asked),
    });
    expect(asked.map((s) => s.id)).toEqual([sourceId]);
    // The pass completed: the source is reported as skipped, nothing was refused by the guard, nothing crashed.
    expect(summary).toMatchObject({ status: 'ok', sources: 1, refused: [] });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.skipped).toEqual([{ sourceId, kind: 'mailbox', reason: 'source_archived' }]);

    // The source was archived by the opt-in, and the late page attached nothing to it.
    const { data: archived } = await db
      .from('content_sources')
      .select('address, status, archived_at, delta_checkpoint, last_synced_at, last_error')
      .eq('id', sourceId)
      .single();
    expect(archived?.address).toMatch(/^inflight-owner@bank\.example~[a-z0-9]{3}$/);
    expect(archived).toMatchObject({ status: 'paused', delta_checkpoint: null, last_synced_at: null, last_error: null });
    expect(archived?.archived_at).not.toBeNull();
    const links = await db.from('source_item_sources').select('source_item_id').eq('content_source_id', sourceId);
    expect(links.data).toEqual([{ source_item_id: earlierItemId }]);
    // No sync failure was recorded on the archive either, and the live source is untouched.
    const { data: fresh } = await db
      .from('content_sources')
      .select('id, owner_user_id, delta_checkpoint, last_error')
      .eq('tenant_id', tenant.id)
      .eq('address', ADDRESS)
      .single();
    expect(fresh).toMatchObject({ owner_user_id: tenant.ownerIds[0], delta_checkpoint: null, last_error: null });
    expect(fresh?.id).not.toBe(sourceId);
  });
});
