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
const revisionIds: string[] = [];
const templateIds: string[] = [];
const catalogIds: string[] = [];
let bankId = '';

function hex64(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0');
}

async function seedCustomStep(options: { removed?: boolean } = {}) {
  if (!bankId) {
    const { data: bank, error } = await admin
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Lineage Bank ${RUN}`, type: 'bank' })
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
      code: `LNG-${RUN}-${dealIds.length + 1}`,
      codename: `Lineage Deal ${RUN} ${dealIds.length + 1}`,
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

async function seedDraft(options: { dealId: string; actorId: string; basisStepId: string | null }) {
  const draftId = randomUUID();
  const insert: Record<string, unknown> = {
    id: draftId,
    deal_id: options.dealId,
    author_id: options.actorId,
  };
  if (options.basisStepId) {
    insert.basis = { source: 'step', dealStepId: options.basisStepId };
    insert.basis_deal_step_id = options.basisStepId;
  } else {
    insert.phase_index = 0;
    insert.placement_kind = 'phase_end';
  }
  const { data, error } = await admin.from('skill_authoring_drafts').insert(insert).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function seedTemplateRevision(actorId: string) {
  const name = `Lineage Template ${RUN} ${templateIds.length + 1}`;
  const { data: template, error: templateError } = await admin
    .from('rail_templates')
    .insert({ tenant_id: TENANT, company_id: bankId, name, created_by: actorId })
    .select('id')
    .single();
  if (templateError || !template) throw new Error(`template seed failed: ${templateError?.message}`);
  templateIds.push(template.id);

  const { data: catalog, error: catalogError } = await admin
    .from('rail_catalog_templates')
    .insert({ company_id: bankId, name, created_by: actorId, rail_template_id: template.id })
    .select('id')
    .single();
  if (catalogError || !catalog) throw new Error(`catalog template seed failed: ${catalogError?.message}`);
  catalogIds.push(catalog.id);

  const { data: revision, error: revisionError } = await admin
    .from('rail_template_revisions')
    .insert({
      template_id: template.id,
      actor_id: actorId,
      request_id: randomUUID(),
      request_digest: hex64(),
      command: { requestId: randomUUID() },
      source_catalog_template_id: catalog.id,
      manifest: { steps: [], skills: [] },
      state: 'ready',
    })
    .select('id')
    .single();
  if (revisionError || !revision) throw new Error(`revision seed failed: ${revisionError?.message}`);
  revisionIds.push(revision.id);
  return revision.id as string;
}

async function seedImportedSkill(options: {
  dealId: string;
  actorId: string;
  skillId: string;
  versionId: string;
}) {
  const revisionId = await seedTemplateRevision(options.actorId);
  return admin.from('deal_skill_imports').insert({
    skill_id: options.skillId,
    deal_id: options.dealId,
    version_id: options.versionId,
    digest: hex64(),
    name: 'Copied lineage skill',
    capability_contract: {
      purpose: 'Summarize the copied deal.',
      expectedInput: 'Recent deal activity.',
      expectedOutput: 'A short summary.',
    },
    imported_by: options.actorId,
    template_revision_id: revisionId,
    source_asset_key: 's0',
  });
}

async function seedPublicationOperation(options: {
  skillId: string;
  state: string;
  context?: { dealId: string; actorId: string; stepId: string };
}) {
  const { dealId, actorId, stepId } = options.context ?? (await seedCustomStep());

  const draftId = randomUUID();
  const draftInsert = await admin.from('skill_authoring_drafts').insert({
    id: draftId,
    deal_id: dealId,
    author_id: actorId,
    phase_index: 0,
    placement_kind: 'phase_end',
  });
  if (draftInsert.error) throw new Error(draftInsert.error.message);

  const messageId = randomUUID();
  const messageInsert = await admin.from('skill_authoring_messages').insert({
    id: messageId,
    draft_id: draftId,
    author_id: actorId,
    ordinal: 1,
    text: 'lineage seed message',
    client_message_id: randomUUID(),
    admitted_edit_revision: 0,
  });
  if (messageInsert.error) throw new Error(messageInsert.error.message);

  const attemptId = randomUUID();
  const attemptInsert = await admin.from('skill_authoring_attempts').insert({
    id: attemptId,
    draft_id: draftId,
    message_id: messageId,
    attempt_number: 1,
  });
  if (attemptInsert.error) throw new Error(attemptInsert.error.message);

  const candidateId = randomUUID();
  const providerCandidateId = randomUUID();
  const digest = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const candidateInsert = await admin.from('skill_authoring_candidates').insert({
    id: candidateId,
    draft_id: draftId,
    attempt_id: attemptId,
    provider_candidate_id: providerCandidateId,
    content_digest: digest,
    schema_version: 1,
    preview: { name: 'Lineage candidate' },
  });
  if (candidateInsert.error) throw new Error(candidateInsert.error.message);

  const operationId = randomUUID();
  const publishedFields =
    options.state === 'published'
      ? {
          published_skill_id: options.skillId,
          published_version_id: randomUUID(),
          published_digest: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          resulting_deal_step_id: stepId,
        }
      : {};
  const { data, error } = await admin
    .from('skill_publication_operations')
    .insert({
      id: operationId,
      deal_id: dealId,
      draft_id: draftId,
      actor_id: actorId,
      client_request_id: randomUUID(),
      candidate_id: candidateId,
      provider_candidate_id: providerCandidateId,
      candidate_digest: digest,
      draft_edit_revision: 0,
      name: 'Lineage skill',
      phase_index: 0,
      placement_kind: 'phase_end',
      reserved_skill_id: options.skillId,
      reserved_step_key: `custom:${randomUUID()}`,
      capability_contract: {
        purpose: 'Summarize the deal.',
        expectedInput: 'Recent deal activity.',
        expectedOutput: 'A short summary.',
      },
      state: options.state,
      ...publishedFields,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function clearAuthoring(dealId: string) {
  await admin.from('skill_publication_operations').delete().eq('deal_id', dealId);
  const { data: drafts } = await admin
    .from('skill_authoring_drafts')
    .select('id')
    .eq('deal_id', dealId);
  const draftIds = ((drafts ?? []) as { id: string }[]).map((draft) => draft.id);
  if (draftIds.length > 0) {
    await admin.from('skill_authoring_candidates').delete().in('draft_id', draftIds);
    await admin.from('skill_authoring_attempts').delete().in('draft_id', draftIds);
    await admin.from('skill_authoring_messages').delete().in('draft_id', draftIds);
  }
  await admin.from('skill_authoring_drafts').delete().eq('deal_id', dealId);
}

afterAll(async () => {
  for (const dealId of dealIds) {
    await clearAuthoring(dealId);
    await admin.from('deal_skill_imports').delete().eq('deal_id', dealId);
    await admin.from('deal_step_skill_bindings').delete().eq('deal_id', dealId);
    await admin.from('deal_steps').delete().eq('deal_id', dealId);
  }
  for (const revisionId of revisionIds) {
    await admin.from('rail_template_revisions').delete().eq('id', revisionId);
  }
  for (const catalogId of catalogIds) {
    await admin.from('rail_catalog_templates').delete().eq('id', catalogId);
  }
  for (const templateId of templateIds) {
    await admin.from('rail_templates').delete().eq('id', templateId);
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

describe('skill version lineage', () => {
  it('admits two published operations on one skill identity', async () => {
    const skillId = randomUUID();
    await expect(seedPublicationOperation({ skillId, state: 'published' })).resolves.toBeTruthy();
    await expect(seedPublicationOperation({ skillId, state: 'published' })).resolves.toBeTruthy();
  });

  it('still admits only one live operation per skill identity', async () => {
    const skillId = randomUUID();
    await seedPublicationOperation({ skillId, state: 'preparing' });
    await expect(seedPublicationOperation({ skillId, state: 'preparing' })).rejects.toThrow();
  });

  it('admits a creation draft and an enhancement draft for one author on one deal', async () => {
    const { dealId, actorId, stepId } = await seedCustomStep();
    await expect(seedDraft({ dealId, actorId, basisStepId: null })).resolves.toBeTruthy();
    await expect(seedDraft({ dealId, actorId, basisStepId: stepId })).resolves.toBeTruthy();
    await expect(seedDraft({ dealId, actorId, basisStepId: stepId })).rejects.toThrow();
  });

  it('admits an authored version beside a copied one on the same skill identity', async () => {
    const skillId = randomUUID();
    const { dealId, actorId, stepId } = await seedCustomStep();
    const imported = await seedImportedSkill({
      dealId,
      actorId,
      skillId,
      versionId: randomUUID(),
    });
    expect(imported.error).toBeNull();

    await expect(
      seedPublicationOperation({
        skillId,
        state: 'published',
        context: { dealId, actorId, stepId },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a second import claiming a version another import already holds', async () => {
    const versionId = randomUUID();
    const first = await seedCustomStep();
    const second = await seedCustomStep();
    const taken = await seedImportedSkill({
      dealId: first.dealId,
      actorId: first.actorId,
      skillId: randomUUID(),
      versionId,
    });
    expect(taken.error).toBeNull();

    const repeat = await seedImportedSkill({
      dealId: second.dealId,
      actorId: second.actorId,
      skillId: randomUUID(),
      versionId,
    });

    expect(repeat.error).not.toBeNull();
  });

  it('records a mount run with no publication ids', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: dealId,
      deal_step_id: stepId,
      actor_id: actorId,
      mount_name: 'demo',
      mount_version: 3,
      digest: 'a'.repeat(64),
      input: 'Check Acme',
      outcome: 'succeeded',
      result_text: 'Done.',
      model: 'sonnet',
      source: 'execution',
    });
    expect(error).toBeNull();
  });

  it('records an imported run with no reference at all', async () => {
    const { dealId, stepId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: dealId,
      deal_step_id: stepId,
      input: 'Check Acme',
      outcome: 'succeeded',
      result_text: 'Done.',
      source: 'imported',
    });
    expect(error).toBeNull();
  });

  it('rejects an imported run carrying a stray actor_id', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: dealId,
      deal_step_id: stepId,
      actor_id: actorId,
      input: 'Check Acme',
      outcome: 'succeeded',
      result_text: 'Done.',
      source: 'imported',
    });
    expect(error).not.toBeNull();
  });

  it('rejects an execution run carrying a half reference', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: dealId,
      deal_step_id: stepId,
      actor_id: actorId,
      skill_id: randomUUID(),
      digest: 'a'.repeat(64),
      input: 'Check Acme',
      outcome: 'succeeded',
      result_text: 'Done.',
      source: 'execution',
    });
    expect(error).not.toBeNull();
  });

  it('rejects an execution run carrying both references at once', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_runs').insert({
      id: randomUUID(),
      deal_id: dealId,
      deal_step_id: stepId,
      actor_id: actorId,
      skill_id: randomUUID(),
      version_id: randomUUID(),
      mount_name: 'demo',
      mount_version: 3,
      digest: 'a'.repeat(64),
      input: 'Check Acme',
      outcome: 'succeeded',
      result_text: 'Done.',
      source: 'execution',
    });
    expect(error).not.toBeNull();
  });

  it('rejects a mount binding carrying a stray skill_id', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_bindings').insert({
      deal_step_id: stepId,
      deal_id: dealId,
      kind: 'mount',
      skill_id: randomUUID(),
      mount_name: 'demo',
      mount_version: 3,
      digest: 'a'.repeat(64),
      bound_by: actorId,
      source: 'selection',
    });
    expect(error).not.toBeNull();
  });

  it('rejects a publication binding carrying a stray mount_name', async () => {
    const { dealId, stepId, actorId } = await seedCustomStep();
    const { error } = await admin.from('deal_step_skill_bindings').insert({
      deal_step_id: stepId,
      deal_id: dealId,
      kind: 'publication',
      skill_id: randomUUID(),
      version_id: randomUUID(),
      mount_name: 'demo',
      digest: 'b'.repeat(64),
      bound_by: actorId,
      source: 'publication',
    });
    expect(error).not.toBeNull();
  });
});
