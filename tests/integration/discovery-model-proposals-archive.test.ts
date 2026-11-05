import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { messageKey } from '@/lib/discovery/propose/key';
import { listModelProposals } from '@/lib/discovery/propose/read';
import { createDiscoveryTenant } from './helpers/discoveryTenant';

/*
 * Demo only (#460), review #509-3 (owner: archive, do not delete). Against a REAL
 * database: a proposal that names a rules-found candidate is shown to the mailbox
 * owner through the read route's reader while the candidate is live; once the
 * candidate is rejected or deleted the row is archived, keeps its key, name and id,
 * and is no longer shown; clearing archived_at restores it; deleting the mailbox
 * source still removes every row, archived ones included.
 */

const tenant = createDiscoveryTenant('pa');
const { db, tenantId } = tenant;
const STORM = 'storm.duncan@bank.example';
const RUN = '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d';

let sourceId: string;
const visible: Array<{ id: string; name: string }> = [];

async function propose(messageId: string, candidate: { id: string; name: string }) {
  const { error } = await db.rpc('discovery_record_model_proposal', {
    p_tenant_id: tenantId,
    p_proposal: {
      content_source_id: sourceId,
      message_key: messageKey(messageId),
      item_hash: messageKey(`text of ${messageId}`),
      sent_at: '2026-03-02T10:00:00Z',
      party_domains: ['harbourline.example'],
      outcome: 'deal',
      deal_key: `c:${candidate.id}`,
      deal_name: candidate.name,
      candidate_id: candidate.id,
      phase: 'phase-2',
      p_deal: 0.9,
      p_phase: 0.6,
      model: 'anthropic/claude-haiku-5.5',
      prompt_version: 'v1',
      prompt_hash: 'hash-v1',
      response_id: null,
      run_id: RUN,
    },
  });
  if (error) throw new Error(`record proposal failed: ${error.message}`);
}

const shownToAlice = async () => {
  const result = await listModelProposals(tenant.sessionFor('alice'));
  if (!result.ok) throw new Error(result.error);
  return result.proposals.map((g) => g.dealKey);
};

const rowOf = async (candidateId: string) => {
  const { data, error } = await db
    .from('discovery_model_proposals')
    .select('deal_key, deal_name, candidate_id, archived_at')
    .eq('tenant_id', tenantId)
    .eq('deal_key', `c:${candidateId}`);
  if (error) throw new Error(error.message);
  return data ?? [];
};

beforeAll(async () => {
  await tenant.setup();
  await tenant.seedDemo();
  sourceId = await tenant.sourceIdOf(STORM);
  // Two live candidates Alice can see, read through her own session (RLS decides).
  const { data, error } = await tenant
    .sessionFor('alice')
    .from('deal_candidates')
    .select('id, proposed_name, codename_guess')
    .in('discovery_state', ['proposed', 'confirmed']);
  if (error) throw new Error(error.message);
  for (const c of (data ?? []) as Array<{ id: string; proposed_name: string | null; codename_guess: string | null }>) {
    visible.push({ id: c.id, name: (c.proposed_name ?? c.codename_guess ?? 'Deal').slice(0, 80) });
  }
  if (visible.length < 2) throw new Error(`the demo corpus gave Alice ${visible.length} visible candidates; need 2`);
  await propose('<archive-1@harbourline.example>', visible[0]);
  await propose('<archive-2@harbourline.example>', visible[1]);
});

afterAll(async () => {
  await db.from('discovery_model_proposals').delete().eq('tenant_id', tenantId);
  await db.from('content_sources').delete().eq('tenant_id', tenantId);
  await tenant.cleanup();
});

describe('proposals are archived, not deleted, when their candidate goes away (#460 review #509-3)', () => {
  it('shows both proposals while their candidates are live', async () => {
    expect(await shownToAlice()).toEqual(expect.arrayContaining([`c:${visible[0].id}`, `c:${visible[1].id}`]));
  });

  it('rejecting a candidate archives its proposal, keeps key, name and id, and hides it from the read route', async () => {
    const { error } = await db.from('deal_candidates').update({ discovery_state: 'rejected' }).eq('id', visible[0].id);
    expect(error).toBeNull();
    const [row] = await rowOf(visible[0].id);
    expect(row).toMatchObject({ deal_key: `c:${visible[0].id}`, deal_name: visible[0].name, candidate_id: visible[0].id });
    expect(row.archived_at).not.toBeNull();
    const shown = await shownToAlice();
    expect(shown).not.toContain(`c:${visible[0].id}`);
    expect(shown).toContain(`c:${visible[1].id}`);
  });

  it('clearing archived_at restores the row', async () => {
    await db.from('discovery_model_proposals').update({ archived_at: null }).eq('deal_key', `c:${visible[0].id}`);
    expect((await rowOf(visible[0].id))[0].archived_at).toBeNull();
    await db.from('discovery_model_proposals').update({ archived_at: new Date().toISOString() }).eq('deal_key', `c:${visible[0].id}`);
  });

  it('deleting a candidate archives its proposal the same way, and the read route skips it', async () => {
    const { error } = await db.from('deal_candidates').delete().eq('id', visible[1].id);
    expect(error).toBeNull();
    const [row] = await rowOf(visible[1].id);
    expect(row).toMatchObject({ deal_key: `c:${visible[1].id}`, deal_name: visible[1].name, candidate_id: visible[1].id });
    expect(row.archived_at).not.toBeNull();
    expect(await shownToAlice()).not.toContain(`c:${visible[1].id}`);
  });

  it('deleting the mailbox source still removes every proposal, archived ones included', async () => {
    const before = await db.from('discovery_model_proposals').select('id', { count: 'exact', head: true }).eq('content_source_id', sourceId);
    expect(before.count).toBe(2);
    const { error } = await db.from('content_sources').delete().eq('id', sourceId);
    expect(error).toBeNull();
    const after = await db.from('discovery_model_proposals').select('id', { count: 'exact', head: true }).eq('content_source_id', sourceId);
    expect(after.count).toBe(0);
  });
});
