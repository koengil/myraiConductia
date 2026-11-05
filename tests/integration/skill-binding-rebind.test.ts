import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack or the -dev project).',
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();

const dealIds: string[] = [];
const userIds: string[] = [];
let bankId = '';

async function seedCustomStep(options: { removed?: boolean } = {}) {
  if (!bankId) {
    const { data: bank, error } = await admin
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Rebind Bank ${RUN}`, type: 'bank' })
      .select('id')
      .single();
    if (error || !bank) throw new Error(`bank seed failed: ${error?.message}`);
    bankId = bank.id;
  }

  const { id: actorId } = await createProvisionedUser(admin, {
    email: `${randomUUID()}-${RUN}@integration.conductia.dev`,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  userIds.push(actorId);

  const { error: userError } = await admin
    .from('users')
    .update({ tenant_id: TENANT, status: 'active' })
    .eq('id', actorId);
  if (userError) throw new Error(`user claim failed: ${userError.message}`);

  const { data: deal, error: dealError } = await admin
    .from('deals')
    .insert({
      tenant_id: TENANT,
      code: `RBND-${RUN}-${dealIds.length + 1}`,
      codename: `Rebind Deal ${RUN} ${dealIds.length + 1}`,
      bank_id: bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`deal seed failed: ${dealError?.message}`);
  const dealId = deal.id;
  dealIds.push(dealId);

  const { data: step, error: stepError } = await admin
    .from('deal_steps')
    .insert({
      deal_id: dealId,
      step_id: `custom:${randomUUID()}`,
      status: 'pending',
      origin: 'custom',
      definition: {},
      removed_at: options.removed ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (stepError || !step) throw new Error(`step seed failed: ${stepError?.message}`);

  return { dealId, stepId: step.id as string, actorId };
}

afterAll(async () => {
  for (const dealId of dealIds) {
    await admin.from('deal_step_skill_bindings').delete().eq('deal_id', dealId);
    await admin.from('deal_steps').delete().eq('deal_id', dealId);
  }
  for (const dealId of dealIds) {
    await admin.from('deals').delete().eq('id', dealId);
  }
  if (bankId) {
    await admin.from('companies').delete().eq('id', bankId);
  }
  for (const userId of userIds) {
    await admin.from('users').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
  }
});

describe('rail_rebind_step', () => {
  it('writes a binding and replaces it on a second rebind', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const first = { kind: 'publication', skillId: randomUUID(), versionId: randomUUID(), digest: 'a'.repeat(64) };
    const second = { kind: 'mount', name: 'demo', version: 3, digest: 'b'.repeat(64) };

    await admin.rpc('rail_rebind_step', {
      p_deal_id: dealId,
      p_actor_id: actorId,
      p_deal_step_id: stepId,
      p_reference: first,
      p_source: 'publication',
    });
    await admin.rpc('rail_rebind_step', {
      p_deal_id: dealId,
      p_actor_id: actorId,
      p_deal_step_id: stepId,
      p_reference: second,
      p_source: 'selection',
    });

    const { data } = await admin
      .from('deal_step_skill_bindings')
      .select('*')
      .eq('deal_step_id', stepId)
      .single();

    expect(data).toMatchObject({ kind: 'mount', mount_name: 'demo', mount_version: 3, source: 'selection' });
    expect(data.skill_id).toBeNull();
  });

  it('audits the previous reference alongside the new one', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const first = { kind: 'publication', skillId: randomUUID(), versionId: randomUUID(), digest: 'a'.repeat(64) };
    const second = { kind: 'mount', name: 'demo', version: 3, digest: 'b'.repeat(64) };

    await admin.rpc('rail_rebind_step', {
      p_deal_id: dealId,
      p_actor_id: actorId,
      p_deal_step_id: stepId,
      p_reference: first,
      p_source: 'publication',
    });
    await admin.rpc('rail_rebind_step', {
      p_deal_id: dealId,
      p_actor_id: actorId,
      p_deal_step_id: stepId,
      p_reference: second,
      p_source: 'selection',
    });

    const { data } = await admin
      .from('audit_log')
      .select('detail, ts')
      .eq('deal_id', dealId)
      .eq('action', 'rail.step_rebound')
      .order('ts', { ascending: true });

    const details = ((data ?? []) as { detail: Record<string, unknown> }[]).map(
      (row) => row.detail,
    );
    expect(details).toHaveLength(2);
    expect(details[0].previousReference).toBeUndefined();
    expect(details[1]).toMatchObject({
      reference: second,
      previousReference: first,
    });
  });

  it('refuses a removed step', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep({ removed: true });
    const { error } = await admin.rpc('rail_rebind_step', {
      p_deal_id: dealId,
      p_actor_id: actorId,
      p_deal_step_id: stepId,
      p_reference: { kind: 'mount', name: 'demo', version: 1, digest: 'c'.repeat(64) },
      p_source: 'selection',
    });
    expect(error?.message).toContain('step_removed');
  });
});
