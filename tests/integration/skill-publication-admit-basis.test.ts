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
const DIGEST = 'a'.repeat(64);
const STEP_TITLE = `Buyer screen ${RUN}`;

const dealIds: string[] = [];
const draftIds: string[] = [];
const userIds: string[] = [];
const companyIds: string[] = [];

function expectNoError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function seedActorAndDeal() {
  const companyId = randomUUID();
  const company = await admin
    .from('companies')
    .insert({ id: companyId, tenant_id: TENANT, name: `Admit Bank ${companyId}`, type: 'bank' });
  expectNoError('companies', company.error);
  companyIds.push(companyId);

  const { id: actorId } = await createProvisionedUser(admin, {
    email: `${randomUUID()}-${RUN}@integration.conductia.dev`,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  userIds.push(actorId);

  expectNoError(
    'users',
    (
      await admin
        .from('users')
        .update({
          tenant_id: TENANT,
          company_id: companyId,
          company_role: 'director',
          status: 'active',
          is_external: false,
        })
        .eq('id', actorId)
    ).error,
  );
  expectNoError(
    'company_member_access',
    (await admin.from('company_member_access').insert({ company_id: companyId, user_id: actorId }))
      .error,
  );
  expectNoError(
    'company_member_permissions',
    (
      await admin.from('company_member_permissions').insert({
        company_id: companyId,
        user_id: actorId,
        permission_key: 'company:deals:steps:structure',
        granted_by: actorId,
      })
    ).error,
  );

  const dealId = randomUUID();
  expectNoError(
    'deals',
    (
      await admin.from('deals').insert({
        id: dealId,
        tenant_id: TENANT,
        code: `ADMT-${dealId.slice(0, 8)}`,
        codename: `Admit deal ${dealId.slice(0, 8)}`,
        bank_id: companyId,
      })
    ).error,
  );
  dealIds.push(dealId);

  const mdRole = await admin.from('roles').select('id').eq('slug', 'md').single();
  expectNoError('roles', mdRole.error);
  expectNoError(
    'deal_memberships',
    (
      await admin.from('deal_memberships').insert({
        deal_id: dealId,
        user_id: actorId,
        role_id: (mdRole.data as { id: string }).id,
        deal_role: 'md',
      })
    ).error,
  );

  return { companyId, dealId, actorId };
}

async function seedBasisStep(dealId: string) {
  const { data, error } = await admin
    .from('deal_steps')
    .insert({
      deal_id: dealId,
      step_id: `custom:${randomUUID()}`,
      status: 'pending',
      origin: 'custom',
      phase_index: 2,
      definition: { schemaVersion: 1, type: 'skill', title: STEP_TITLE },
    })
    .select('id')
    .single();
  expectNoError('deal_steps', error);
  return (data as { id: string }).id;
}

type DraftChainOptions = {
  name?: string;
  phaseIndex?: number;
  placementKind?: string;
  status?: 'active' | 'published';
  digest?: string;
};

async function seedMember(companyId: string, dealId: string) {
  const { id: actorId } = await createProvisionedUser(admin, {
    email: `${randomUUID()}-${RUN}@integration.conductia.dev`,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  userIds.push(actorId);

  expectNoError(
    'users',
    (
      await admin
        .from('users')
        .update({
          tenant_id: TENANT,
          company_id: companyId,
          status: 'active',
          is_external: false,
        })
        .eq('id', actorId)
    ).error,
  );
  expectNoError(
    'company_member_access',
    (await admin.from('company_member_access').insert({ company_id: companyId, user_id: actorId }))
      .error,
  );
  expectNoError(
    'company_member_permissions',
    (
      await admin.from('company_member_permissions').insert({
        company_id: companyId,
        user_id: actorId,
        permission_key: 'company:deals:steps:structure',
        granted_by: actorId,
      })
    ).error,
  );

  const mdRole = await admin.from('roles').select('id').eq('slug', 'md').single();
  expectNoError('roles', mdRole.error);
  expectNoError(
    'deal_memberships',
    (
      await admin.from('deal_memberships').insert({
        deal_id: dealId,
        user_id: actorId,
        role_id: (mdRole.data as { id: string }).id,
        deal_role: 'md',
      })
    ).error,
  );

  return actorId;
}

async function seedDraftChain(
  dealId: string,
  actorId: string,
  basis: Record<string, unknown> | null,
  basisStepId: string | null,
  options: DraftChainOptions = {},
) {
  const digest = options.digest ?? DIGEST;
  const draftId = randomUUID();
  expectNoError(
    'skill_authoring_drafts',
    (
      await admin.from('skill_authoring_drafts').insert({
        id: draftId,
        deal_id: dealId,
        author_id: actorId,
        basis,
        basis_deal_step_id: basisStepId,
        name: options.name ?? '',
        phase_index: options.phaseIndex ?? null,
        placement_kind: options.placementKind ?? null,
        status: options.status ?? 'active',
        published_at: options.status === 'published' ? new Date().toISOString() : null,
      })
    ).error,
  );
  draftIds.push(draftId);

  const messageId = randomUUID();
  expectNoError(
    'skill_authoring_messages',
    (
      await admin.from('skill_authoring_messages').insert({
        id: messageId,
        draft_id: draftId,
        author_id: actorId,
        ordinal: 1,
        text: 'improve this skill',
        client_message_id: randomUUID(),
        admitted_edit_revision: 0,
      })
    ).error,
  );

  const attemptId = randomUUID();
  expectNoError(
    'skill_authoring_attempts',
    (
      await admin.from('skill_authoring_attempts').insert({
        id: attemptId,
        draft_id: draftId,
        message_id: messageId,
        attempt_number: 1,
        status: 'succeeded',
        response_text: 'here it is',
        completed_at: new Date().toISOString(),
      })
    ).error,
  );

  const candidateId = randomUUID();
  const providerCandidateId = randomUUID();
  expectNoError(
    'skill_authoring_candidates',
    (
      await admin.from('skill_authoring_candidates').insert({
        id: candidateId,
        draft_id: draftId,
        attempt_id: attemptId,
        provider_candidate_id: providerCandidateId,
        content_digest: digest,
        schema_version: 1,
        preview: {
          name: options.name ?? STEP_TITLE,
          purpose: 'Screen buyers',
          expectedInput: 'Deal context',
          expectedOutput: 'Ranked buyers',
        },
      })
    ).error,
  );
  expectNoError(
    'skill_authoring_drafts.current_candidate_id',
    (
      await admin
        .from('skill_authoring_drafts')
        .update({ current_candidate_id: candidateId })
        .eq('id', draftId)
    ).error,
  );

  return { draftId, candidateId, providerCandidateId, digest };
}

async function seedOperation(
  dealId: string,
  actorId: string,
  chain: { draftId: string; candidateId: string; providerCandidateId: string; digest: string },
  fields: Record<string, unknown>,
) {
  const operationId = randomUUID();
  expectNoError(
    'skill_publication_operations',
    (
      await admin.from('skill_publication_operations').insert({
        id: operationId,
        deal_id: dealId,
        draft_id: chain.draftId,
        actor_id: actorId,
        client_request_id: randomUUID(),
        candidate_id: chain.candidateId,
        provider_candidate_id: chain.providerCandidateId,
        candidate_digest: chain.digest,
        draft_edit_revision: 0,
        phase_index: 2,
        placement_kind: 'phase_end',
        reserved_step_key: `custom:${randomUUID()}`,
        capability_contract: {
          purpose: 'Screen buyers as they were screened before',
          expectedInput: 'Deal context',
          expectedOutput: 'A shorter list',
        },
        ...fields,
      })
    ).error,
  );
  return operationId;
}

async function seedPublishedAncestor(
  dealId: string,
  actorId: string,
  dealStepId: string,
  skillId: string,
) {
  const chain = await seedDraftChain(dealId, actorId, null, null, {
    name: STEP_TITLE,
    phaseIndex: 2,
    placementKind: 'phase_end',
    status: 'published',
    digest: 'f'.repeat(64),
  });
  return seedOperation(dealId, actorId, chain, {
    state: 'published',
    name: STEP_TITLE,
    reserved_skill_id: skillId,
    published_skill_id: skillId,
    published_version_id: randomUUID(),
    published_digest: chain.digest,
    resulting_deal_step_id: dealStepId,
  });
}

async function admit(dealId: string, actorId: string, draftId: string, candidateId: string) {
  return admin.rpc('skill_publication_admit', {
    p_actor_id: actorId,
    p_deal_id: dealId,
    p_draft_id: draftId,
    p_client_request_id: randomUUID(),
    p_expected_edit_revision: 0,
    p_candidate_id: candidateId,
    p_candidate_digest: DIGEST,
    p_correlation_id: randomUUID(),
  });
}

async function operationFor(draftId: string) {
  const { data, error } = await admin
    .from('skill_publication_operations')
    .select('state, status_code, name, phase_index, placement_kind, anchor_deal_step_id, reserved_skill_id')
    .eq('draft_id', draftId)
    .single();
  expectNoError('skill_publication_operations', error);
  return data as Record<string, unknown>;
}

afterAll(async () => {
  for (const dealId of dealIds) {
    await admin.from('skill_publication_operations').delete().eq('deal_id', dealId);
  }
  for (const draftId of draftIds) {
    await admin.from('skill_authoring_candidates').delete().eq('draft_id', draftId);
    await admin.from('skill_authoring_attempts').delete().eq('draft_id', draftId);
    await admin.from('skill_authoring_messages').delete().eq('draft_id', draftId);
    await admin.from('skill_authoring_drafts').delete().eq('id', draftId);
  }
  for (const dealId of dealIds) {
    await admin.from('deal_step_skill_bindings').delete().eq('deal_id', dealId);
    await admin.from('deal_steps').delete().eq('deal_id', dealId);
    await admin.from('audit_log').delete().eq('deal_id', dealId);
    await admin.from('deal_memberships').delete().eq('deal_id', dealId);
    await admin.from('deals').delete().eq('id', dealId);
  }
  for (const userId of userIds) {
    await admin.from('company_member_permissions').delete().eq('user_id', userId);
    await admin.from('company_member_access').delete().eq('user_id', userId);
    await admin.from('audit_log').delete().eq('actor_id', userId);
    await admin.from('users').update({ company_id: null }).eq('id', userId);
    await admin.from('users').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
  }
  for (const companyId of companyIds) {
    await admin.from('companies').delete().eq('id', companyId);
  }
});

describe('skill_publication_admit with a basis', () => {
  it('admits a publication enhancement onto the ancestor skill id, exempting its own step and its own published operation', async () => {
    const { dealId, actorId } = await seedActorAndDeal();
    const stepId = await seedBasisStep(dealId);
    const ancestorSkillId = randomUUID();
    await seedPublishedAncestor(dealId, actorId, stepId, ancestorSkillId);
    const { draftId, candidateId } = await seedDraftChain(
      dealId,
      actorId,
      {
        kind: 'publication',
        skillId: ancestorSkillId,
        versionId: randomUUID(),
        digest: 'b'.repeat(64),
      },
      stepId,
    );

    const { error } = await admit(dealId, actorId, draftId, candidateId);
    expect(error).toBeNull();

    const op = await operationFor(draftId);
    expect({ state: op.state, statusCode: op.status_code }).toEqual({
      state: 'preparing',
      statusCode: null,
    });
    expect(op.name).toBe(STEP_TITLE);
    expect(op.phase_index).toBe(2);
    expect(op.placement_kind).toBe('after');
    expect(op.anchor_deal_step_id).toBe(stepId);
    expect(op.reserved_skill_id).toBe(ancestorSkillId);
  });

  it('mints a fresh skill id for a mount basis, which is the catalog fork', async () => {
    const { dealId, actorId } = await seedActorAndDeal();
    const stepId = await seedBasisStep(dealId);
    const { draftId, candidateId } = await seedDraftChain(
      dealId,
      actorId,
      { kind: 'mount', name: 'md-briefing', version: 3, digest: 'c'.repeat(64) },
      stepId,
    );

    const { error } = await admit(dealId, actorId, draftId, candidateId);
    expect(error).toBeNull();

    const op = await operationFor(draftId);
    expect(op.state).toBe('preparing');
    expect(op.reserved_skill_id).not.toBe(null);
    expect(String(op.reserved_skill_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('still reports a creation duplicate against an operation that is still in flight', async () => {
    const { companyId, dealId, actorId } = await seedActorAndDeal();
    const otherActorId = await seedMember(companyId, dealId);
    const inFlightChain = await seedDraftChain(dealId, otherActorId, null, null, {
      name: STEP_TITLE,
      phaseIndex: 2,
      placementKind: 'phase_end',
      digest: 'e'.repeat(64),
    });
    await seedOperation(dealId, otherActorId, inFlightChain, {
      state: 'preparing',
      name: STEP_TITLE,
      reserved_skill_id: randomUUID(),
    });

    const { draftId, candidateId } = await seedDraftChain(dealId, actorId, null, null, {
      name: STEP_TITLE,
      phaseIndex: 2,
      placementKind: 'phase_end',
    });

    const { error } = await admit(dealId, actorId, draftId, candidateId);
    expect(error).toBeNull();

    const op = await operationFor(draftId);
    expect(op.state).toBe('failed');
    expect(op.status_code).toBe('duplicate_active');
  });

  it('still reports a duplicate against a different step', async () => {
    const { dealId, actorId } = await seedActorAndDeal();
    const stepId = await seedBasisStep(dealId);
    const otherStepId = await seedBasisStep(dealId);
    const { draftId, candidateId } = await seedDraftChain(
      dealId,
      actorId,
      {
        kind: 'publication',
        skillId: randomUUID(),
        versionId: randomUUID(),
        digest: 'd'.repeat(64),
      },
      stepId,
    );

    const { error } = await admit(dealId, actorId, draftId, candidateId);
    expect(error).toBeNull();

    const op = await operationFor(draftId);
    expect(op.state).toBe('failed');
    expect(op.status_code).toBe('duplicate_active');
    expect(otherStepId).not.toBe(stepId);
  });
});
