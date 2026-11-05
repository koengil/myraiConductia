import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TABLE } from '@/lib/constants/tables';

const CONFLICTS_APPROVER = 'Pat Rivera';

export type CreatedDeal = { code: string; id: string };

/**
 * Creates a fresh, uniquely-named deal directly through POST /api/v1/deals
 * (the same Gate 0 RPC the wizard drives), bypassing the UI so every test in
 * this file owns its own deal rather than sharing one across runs. The
 * creating identity is whoever `request` is authenticated as.
 */
export async function createRailDeal(
  request: APIRequestContext,
  opts: { runId: string; entryStepSeq?: number; memberIds?: string[] },
): Promise<CreatedDeal> {
  const approvedOn = new Date().toISOString().slice(0, 10);
  const response = await request.post('/api/v1/deals', {
    data: {
      codename: `Project RailVerify ${opts.runId}`,
      targetName: `E2E Rail Target ${opts.runId}`,
      entryStepSeq: opts.entryStepSeq,
      members: (opts.memberIds ?? []).map((userId) => ({ userId, dealRole: 'deal_team' })),
      conflictsAttestation: { approvedBy: CONFLICTS_APPROVER, approvedOn },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { deal: { id: string; code: string } };
  return { code: body.deal.code, id: body.deal.id };
}

function localAdmin(purpose: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(`${purpose} needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY`);
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    throw new Error(`refusing to ${purpose} against a non-local Supabase URL: ${url}`);
  }
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Inserts a step with no catalog entry, the only way one gets onto a deal's
 * rail; this mirrors the manual DB insert the original exploratory session used.
 * Local-only: refuses any NEXT_PUBLIC_SUPABASE_URL that is not 127.0.0.1 or
 * localhost.
 */
export async function insertCustomStep(
  dealId: string,
  opts: { stepId: string; title: string; description: string; phaseIndex: number; displayOrder: number },
): Promise<void> {
  const admin = localAdmin('write a custom step');
  const { error } = await admin.from(TABLE.DEAL_STEPS).insert({
    deal_id: dealId,
    step_id: opts.stepId,
    seq: null,
    status: 'pending',
    origin: 'custom',
    phase_index: opts.phaseIndex,
    display_order: opts.displayOrder,
    definition: { title: opts.title, description: opts.description },
  });
  if (error) throw new Error(`could not insert custom step: ${error.message}`);
}

/**
 * Inserts a custom step bound to a published skill version, the shape Part C
 * writes and Part D runs. The binding is fabricated rather than published:
 * the hermetic tier has no skill bench, so what this proves is everything
 * Conductia owns either side of the provider call.
 */
export async function insertSkillStep(
  dealId: string,
  opts: {
    stepId: string;
    title: string;
    description: string;
    helperText: string;
    binding: { skillId: string; versionId: string; digest: string };
    phaseIndex: number;
    displayOrder: number;
  },
): Promise<void> {
  const admin = localAdmin('write a skill-backed custom step');
  const { error } = await admin.from(TABLE.DEAL_STEPS).insert({
    deal_id: dealId,
    step_id: opts.stepId,
    seq: null,
    status: 'pending',
    origin: 'custom',
    phase_index: opts.phaseIndex,
    display_order: opts.displayOrder,
    definition: {
      schemaVersion: 1,
      type: 'skill',
      title: opts.title,
      description: opts.description,
      inputs: [
        {
          key: 'primary',
          kind: 'text',
          label: 'Input',
          helperText: opts.helperText,
          required: true,
        },
      ],
      skillBinding: opts.binding,
    },
  });
  if (error) throw new Error(`could not insert skill step: ${error.message}`);
}

export async function readSkillRuns(
  dealId: string,
): Promise<{ id: string; outcome: string; input: string; inputs: Record<string, unknown> | null; digest: string }[]> {
  const admin = localAdmin('read the recorded skill runs');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select('id, outcome, input, inputs, digest, created_at')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`could not read skill runs: ${error.message}`);
  return (data ?? []) as {
    id: string;
    outcome: string;
    input: string;
    inputs: Record<string, unknown> | null;
    digest: string;
  }[];
}

export async function insertDealWithoutActivity(
  mdId: string,
  runId: string,
): Promise<CreatedDeal & { codename: string }> {
  const admin = localAdmin('seed a deal with no audit rows');
  const { data: md, error: mdError } = await admin
    .from(TABLE.USERS)
    .select('tenant_id, company_id')
    .eq('id', mdId)
    .single();
  if (mdError || !md) throw new Error(`could not read the MD's profile: ${mdError?.message ?? 'missing'}`);
  const { data: role, error: roleError } = await admin
    .from(TABLE.ROLES)
    .select('id')
    .eq('slug', 'md')
    .single();
  if (roleError || !role) throw new Error(`could not read the md role: ${roleError?.message ?? 'missing'}`);

  const codename = `Project Quiet ${runId}`;
  const { data: deal, error: dealError } = await admin
    .from(TABLE.DEALS)
    .insert({
      tenant_id: md.tenant_id,
      bank_id: md.company_id,
      code: `QUIET-${runId}`.toUpperCase().slice(0, 40),
      codename,
      mandate_owner_id: mdId,
    })
    .select('id, code')
    .single();
  if (dealError || !deal) throw new Error(`could not seed the deal: ${dealError?.message ?? 'missing'}`);

  const { error: seatError } = await admin
    .from(TABLE.DEAL_MEMBERSHIPS)
    .insert({ deal_id: deal.id, user_id: mdId, role_id: role.id, deal_role: 'md' });
  if (seatError) throw new Error(`could not seat the MD: ${seatError.message}`);

  return { id: deal.id as string, code: deal.code as string, codename };
}

export async function insertSucceededRun(
  dealId: string,
  opts: {
    stepId: string;
    actorId: string;
    binding: { skillId: string; versionId: string; digest: string };
    resultText: string;
  },
): Promise<string> {
  const admin = localAdmin('write a succeeded skill run');
  const step = await admin
    .from(TABLE.DEAL_STEPS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('step_id', opts.stepId)
    .single();
  if (step.error || !step.data) throw new Error(`could not find the step: ${step.error?.message}`);

  const runId = randomUUID();
  const { error } = await admin.from(TABLE.DEAL_STEP_SKILL_RUNS).insert({
    id: runId,
    deal_id: dealId,
    deal_step_id: step.data.id,
    actor_id: opts.actorId,
    skill_id: opts.binding.skillId,
    version_id: opts.binding.versionId,
    digest: opts.binding.digest,
    input: 'Summarise the week',
    outcome: 'succeeded',
    result_text: opts.resultText,
    source: 'execution',
  });
  if (error) throw new Error(`could not insert the run: ${error.message}`);
  return runId;
}

export async function readRevisionRows(
  dealId: string,
): Promise<{ id: string; outcome: string; result_text: string | null; parent_run_id: string; inputs: Record<string, unknown> }[]> {
  const admin = localAdmin('read the revision rows');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select('id, outcome, result_text, parent_run_id, inputs, created_at')
    .eq('deal_id', dealId)
    .eq('source', 'revision')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`could not read revisions: ${error.message}`);
  return (data ?? []) as {
    id: string;
    outcome: string;
    result_text: string | null;
    parent_run_id: string;
    inputs: Record<string, unknown>;
  }[];
}

export async function insertTaughtRevision(
  dealId: string,
  opts: {
    rootRunId: string;
    actorId: string;
    binding: { skillId: string; versionId: string; digest: string };
    parentText: string;
    comment: string;
    passage: string;
    replacement: string;
  },
): Promise<{ revisionId: string; editId: string }> {
  const admin = localAdmin('write a taught comment revision');
  const root = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select('deal_step_id')
    .eq('id', opts.rootRunId)
    .single();
  if (root.error || !root.data) throw new Error(`could not find the run: ${root.error?.message}`);

  const start = opts.parentText.indexOf(opts.passage);
  if (start < 0) throw new Error('the passage is not in the parent text');
  const resultText = opts.parentText.replace(opts.passage, opts.replacement);
  const revisionId = randomUUID();
  const editId = randomUUID();
  const { error } = await admin.rpc('record_skill_run_revision', {
    p_run: {
      id: revisionId,
      deal_id: dealId,
      deal_step_id: root.data.deal_step_id,
      actor_id: opts.actorId,
      source: 'revision',
      parent_run_id: opts.rootRunId,
      root_run_id: opts.rootRunId,
      skill_id: opts.binding.skillId,
      version_id: opts.binding.versionId,
      digest: opts.binding.digest,
      inputs: {
        kind: 'edits',
        edits: [
          {
            id: editId,
            kind: 'comment',
            start,
            end: start + opts.passage.length,
            comment: opts.comment,
            teach: true,
            status: 'applied',
            resultStart: start,
            resultEnd: start + opts.replacement.length,
          },
        ],
      },
      outcome: 'succeeded',
      result_text: resultText,
    },
    p_audit: { kind: 'skill_run_revision', phase: 'recorded', revisionId },
  });
  if (error) throw new Error(`could not record the taught revision: ${error.message}`);
  return { revisionId, editId };
}
