import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { recordAiUsage } from '@/lib/ai/usage';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack).',
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();
let bankId = '';
let deals = 0;

type Seed = {
  dealId: string;
  stepId: string;
  actorId: string;
  rootId: string;
  skillId: string;
  versionId: string;
};

async function seedRun(): Promise<Seed> {
  if (!bankId) {
    const { data: bank, error } = await admin
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Revision Bank ${RUN}`, type: 'bank' })
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
  const { error: userError } = await admin
    .from('users')
    .update({ tenant_id: TENANT, status: 'active' })
    .eq('id', actorId);
  if (userError) throw new Error(`user claim failed: ${userError.message}`);

  deals += 1;
  const { data: deal, error: dealError } = await admin
    .from('deals')
    .insert({
      tenant_id: TENANT,
      code: `REV-${RUN}-${deals}`,
      codename: `Revision Deal ${RUN} ${deals}`,
      bank_id: bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`deal seed failed: ${dealError?.message}`);

  const { data: step, error: stepError } = await admin
    .from('deal_steps')
    .insert({
      deal_id: deal.id,
      step_id: `custom:${randomUUID()}`,
      status: 'pending',
      origin: 'custom',
      definition: {},
    })
    .select('id')
    .single();
  if (stepError || !step) throw new Error(`step seed failed: ${stepError?.message}`);

  const seed = {
    dealId: deal.id as string,
    stepId: step.id as string,
    actorId,
    rootId: randomUUID(),
    skillId: randomUUID(),
    versionId: randomUUID(),
  };
  const { error: runError } = await admin.from('deal_step_skill_runs').insert({
    id: seed.rootId,
    deal_id: seed.dealId,
    deal_step_id: seed.stepId,
    actor_id: seed.actorId,
    skill_id: seed.skillId,
    version_id: seed.versionId,
    digest: 'a'.repeat(64),
    input: 'Summarise the week',
    outcome: 'succeeded',
    result_text: 'First output.',
    source: 'execution',
  });
  if (runError) throw new Error(`run seed failed: ${runError.message}`);
  return seed;
}

function revision(seed: Seed, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    deal_id: seed.dealId,
    deal_step_id: seed.stepId,
    actor_id: seed.actorId,
    source: 'revision',
    parent_run_id: seed.rootId,
    root_run_id: seed.rootId,
    skill_id: seed.skillId,
    version_id: seed.versionId,
    digest: 'a'.repeat(64),
    inputs: { kind: 'edits', edits: [] },
    outcome: 'succeeded',
    result_text: 'Revised output.',
    ...overrides,
  };
}

describe('skill output revision rows', () => {
  it('stores a revision that names its parent, its root and the run reference', async () => {
    const seed = await seedRun();

    const { error } = await admin.from('deal_step_skill_runs').insert(revision(seed));

    expect(error).toBeNull();
  });

  it('stores a revision of an imported run, which has no reference at all', async () => {
    const seed = await seedRun();

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { skill_id: null, version_id: null, digest: null }));

    expect(error).toBeNull();
  });

  it('refuses a revision with half a reference', async () => {
    const seed = await seedRun();

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { version_id: null }));

    expect(error).not.toBeNull();
  });

  it('refuses a revision with no parent or no actor', async () => {
    const seed = await seedRun();

    const orphan = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: null }));
    const anonymous = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { actor_id: null }));

    expect(orphan.error).not.toBeNull();
    expect(anonymous.error).not.toBeNull();
  });

  it('refuses an executed run that claims a parent', async () => {
    const seed = await seedRun();

    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: seed.dealId,
      deal_step_id: seed.stepId,
      actor_id: seed.actorId,
      skill_id: seed.skillId,
      version_id: seed.versionId,
      digest: 'a'.repeat(64),
      input: 'Again',
      outcome: 'succeeded',
      result_text: 'Second run.',
      source: 'execution',
      parent_run_id: seed.rootId,
      root_run_id: seed.rootId,
    });

    expect(error).not.toBeNull();
  });

  it('lets only one successful revision stand on a parent', async () => {
    const seed = await seedRun();
    const first = await admin.from('deal_step_skill_runs').insert(revision(seed));

    const second = await admin.from('deal_step_skill_runs').insert(revision(seed));

    expect(first.error).toBeNull();
    expect(second.error?.code).toBe('23505');
  });

  it('keeps a failed attempt beside the successful revision of the same parent', async () => {
    const seed = await seedRun();
    await admin.from('deal_step_skill_runs').insert(revision(seed));

    const { error } = await admin.from('deal_step_skill_runs').insert(
      revision(seed, {
        outcome: 'failed',
        result_text: null,
        error_message: 'The edit could not be applied.',
      }),
    );

    expect(error).toBeNull();
  });

  it('refuses to change a revision row once written', async () => {
    const seed = await seedRun();
    const row = revision(seed);
    await admin.from('deal_step_skill_runs').insert(row);

    const { error } = await admin
      .from('deal_step_skill_runs')
      .update({ result_text: 'tampered' })
      .eq('id', row.id);

    expect(error).not.toBeNull();
  });

  it('refuses a revision whose root belongs to another step', async () => {
    const seed = await seedRun();
    const other = await seedRun();

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: other.rootId, root_run_id: other.rootId }));

    expect(error?.code).toBe('23514');
  });

  it('refuses a revision whose root is itself a revision', async () => {
    const seed = await seedRun();
    const first = revision(seed);
    await admin.from('deal_step_skill_runs').insert(first);

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: first.id, root_run_id: first.id }));

    expect(error?.code).toBe('23514');
  });

  it('refuses a revision whose parent sits on another run of the same step', async () => {
    const seed = await seedRun();
    const otherRoot = randomUUID();
    await admin.from('deal_step_skill_runs').insert({
      id: otherRoot,
      deal_id: seed.dealId,
      deal_step_id: seed.stepId,
      actor_id: seed.actorId,
      skill_id: seed.skillId,
      version_id: seed.versionId,
      digest: 'a'.repeat(64),
      input: 'Again',
      outcome: 'succeeded',
      result_text: 'Second run.',
      source: 'execution',
    });

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: otherRoot }));

    expect(error?.code).toBe('23514');
  });

  it('stores a revision of a revision on the same run', async () => {
    const seed = await seedRun();
    const first = revision(seed);
    await admin.from('deal_step_skill_runs').insert(first);

    const { error } = await admin
      .from('deal_step_skill_runs')
      .insert(revision(seed, { parent_run_id: first.id }));

    expect(error).toBeNull();
  });

  it('records a revision and its audit entry together', async () => {
    const seed = await seedRun();
    const row = revision(seed);

    const { error } = await admin.rpc('record_skill_run_revision', {
      p_run: row,
      p_audit: { kind: 'skill_run_revision', phase: 'recorded', revisionId: row.id },
    });

    expect(error).toBeNull();
    const { data: stored } = await admin.from('deal_step_skill_runs').select('id, created_at').eq('id', row.id);
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.created_at).toEqual(expect.any(String));
    const { data: audits } = await admin
      .from('audit_log')
      .select('actor_id, action, detail')
      .eq('deal_id', seed.dealId)
      .eq('detail->>kind', 'skill_run_revision');
    expect(audits).toEqual([
      {
        actor_id: seed.actorId,
        action: 'create',
        detail: { kind: 'skill_run_revision', phase: 'recorded', revisionId: row.id },
      },
    ]);
  });

  it('writes no audit entry when the revision itself is refused', async () => {
    const seed = await seedRun();
    await admin.from('deal_step_skill_runs').insert(revision(seed));
    const loser = revision(seed);

    const { error } = await admin.rpc('record_skill_run_revision', {
      p_run: loser,
      p_audit: { kind: 'skill_run_revision', phase: 'recorded', revisionId: loser.id },
    });

    expect(error?.code).toBe('23505');
    const { data: audits } = await admin
      .from('audit_log')
      .select('detail')
      .eq('deal_id', seed.dealId)
      .eq('detail->>kind', 'skill_run_revision');
    expect(audits).toEqual([]);
  });

  it('accepts a ledger row for a revision', async () => {
    const seed = await seedRun();

    const result = await recordAiUsage(admin, {
      tenantId: TENANT,
      dealId: seed.dealId,
      actorId: seed.actorId,
      source: 'skill_revision',
      task: 'custom:revision-test',
      externalId: randomUUID(),
      model: 'sonnet',
      costUsd: null,
    });

    expect(result.error).toBeNull();
  });
});
