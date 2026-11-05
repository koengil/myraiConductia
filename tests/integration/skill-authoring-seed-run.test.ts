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
const ERROR_MESSAGE = 'The skill returned an empty reply.';

const dealIds: string[] = [];
const draftIds: string[] = [];
const userIds: string[] = [];
const companyIds: string[] = [];

function expectNoError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function seedFailedRunDraft(options: {
  errorMessage: string | null;
  input?: string | null;
  inputs?: Record<string, unknown>;
}) {
  const companyId = randomUUID();
  expectNoError(
    'companies',
    (
      await admin
        .from('companies')
        .insert({ id: companyId, tenant_id: TENANT, name: `Seed Bank ${companyId}`, type: 'bank' })
    ).error,
  );
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

  const dealId = randomUUID();
  expectNoError(
    'deals',
    (
      await admin.from('deals').insert({
        id: dealId,
        tenant_id: TENANT,
        code: `SEED-${dealId.slice(0, 8)}`,
        codename: `Seed deal ${dealId.slice(0, 8)}`,
        bank_id: companyId,
      })
    ).error,
  );
  dealIds.push(dealId);

  const step = await admin
    .from('deal_steps')
    .insert({
      deal_id: dealId,
      step_id: `custom:${randomUUID()}`,
      status: 'pending',
      origin: 'custom',
      phase_index: 1,
      definition: { schemaVersion: 1, type: 'skill', title: 'Buyer screen' },
    })
    .select('id')
    .single();
  expectNoError('deal_steps', step.error);
  const dealStepId = (step.data as { id: string }).id;

  const basis = {
    kind: 'publication',
    skillId: randomUUID(),
    versionId: randomUUID(),
    digest: 'b'.repeat(64),
  };

  const runId = randomUUID();
  expectNoError(
    'deal_step_skill_runs',
    (
      await admin.from('deal_step_skill_runs').insert({
        id: runId,
        deal_id: dealId,
        deal_step_id: dealStepId,
        actor_id: actorId,
        skill_id: basis.skillId,
        version_id: basis.versionId,
        digest: basis.digest,
        source: 'execution',
        input: options.input === undefined ? 'Check Acme' : options.input,
        inputs: options.inputs ?? {},
        outcome: 'failed',
        result_text: null,
        error_message: options.errorMessage,
      })
    ).error,
  );

  const draftId = randomUUID();
  expectNoError(
    'skill_authoring_drafts',
    (
      await admin.from('skill_authoring_drafts').insert({
        id: draftId,
        deal_id: dealId,
        author_id: actorId,
        basis,
        basis_deal_step_id: dealStepId,
        seed_run_id: runId,
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
        text: 'It failed. Fix it.',
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
        status: 'running',
      })
    ).error,
  );

  return { attemptId };
}

afterAll(async () => {
  for (const draftId of draftIds) {
    await admin.from('skill_authoring_attempts').delete().eq('draft_id', draftId);
    await admin.from('skill_authoring_messages').delete().eq('draft_id', draftId);
    await admin.from('skill_authoring_drafts').delete().eq('id', draftId);
  }
  for (const dealId of dealIds) {
    await admin.from('deal_step_skill_runs').delete().eq('deal_id', dealId);
    await admin.from('deal_steps').delete().eq('deal_id', dealId);
    await admin.from('audit_log').delete().eq('deal_id', dealId);
    await admin.from('deals').delete().eq('id', dealId);
  }
  for (const userId of userIds) {
    await admin.from('audit_log').delete().eq('actor_id', userId);
    await admin.from('users').update({ company_id: null }).eq('id', userId);
    await admin.from('users').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
  }
  for (const companyId of companyIds) {
    await admin.from('companies').delete().eq('id', companyId);
  }
});

describe('skill_authoring_run_context seeded from a failed run', () => {
  it('sends the error message as the seed run output, because a failed run has no result text', async () => {
    const { attemptId } = await seedFailedRunDraft({ errorMessage: ERROR_MESSAGE });

    const { data, error } = await admin.rpc('skill_authoring_run_context', {
      p_attempt_id: attemptId,
    });
    expect(error).toBeNull();

    const context = data as { seedRun: { input: string; output: string } };
    expect(context.seedRun).toEqual({ input: 'Check Acme', inputs: {}, output: ERROR_MESSAGE });
  });

  it('sends an empty output when the failed run recorded no message either', async () => {
    const { attemptId } = await seedFailedRunDraft({ errorMessage: null });

    const { data, error } = await admin.rpc('skill_authoring_run_context', {
      p_attempt_id: attemptId,
    });
    expect(error).toBeNull();

    const context = data as { seedRun: { input: string; output: string } };
    expect(context.seedRun).toEqual({ input: 'Check Acme', inputs: {}, output: '' });
  });

  it('sends an empty string input and the recorded inputs when the run had no instructions', async () => {
    const { attemptId } = await seedFailedRunDraft({
      errorMessage: ERROR_MESSAGE,
      input: null,
      inputs: { companyName: 'Acme', urgency: 'High' },
    });

    const { data, error } = await admin.rpc('skill_authoring_run_context', {
      p_attempt_id: attemptId,
    });
    expect(error).toBeNull();

    const context = data as {
      seedRun: { input: string; inputs: Record<string, unknown>; output: string };
    };
    expect(context.seedRun).toEqual({
      input: '',
      inputs: { companyName: 'Acme', urgency: 'High' },
      output: ERROR_MESSAGE,
    });
  });
});
