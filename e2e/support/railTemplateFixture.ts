import { randomUUID } from 'node:crypto';
import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { TABLE } from '@/lib/constants/tables';

import { mintSeededSession } from '../auth/session';
import { createRailDeal, insertCustomStep, insertSkillStep } from './railDealFixture';
import { seedPublishableDraft } from './publicationDraftFixture';
import type { CapturedRailCall, StubProgram } from './ignatiousPublicationStub';

export const SOURCE_DIRECTOR_EMAIL = 'cco.intelibank@dev.com';

export const SECOND_CREATOR_EMAIL = 'ib-director.intelibank@dev.com';

export const OUTSIDE_CREATOR_EMAIL = 'nw-director.intelibank@dev.com';

const STATE_DIR = path.join(__dirname, '..', 'auth', '.state');
const SOURCE_DIRECTOR_STATE_PATH = path.join(STATE_DIR, 'rail-template-director.json');
const SECOND_CREATOR_STATE_PATH = path.join(STATE_DIR, 'rail-template-creator.json');
const OUTSIDE_CREATOR_STATE_PATH = path.join(STATE_DIR, 'rail-template-outsider.json');

const STUB_BASE = process.env.PUBLICATION_STUB_URL ?? 'http://127.0.0.1:4311';

export type TemplateJourney = {
  source: { id: string; code: string };
  sourceDirectorStorageState: string;
  secondCreatorStorageState: string;
  outsideCreatorStorageState: string;
  leadName: string;
  leadCompanyId: string;
  baselineStepCount: number;
  removedStepId: string;
  secondRemovableStepId: string;
  secondRemovableStepRowId: string;
  manualStepTitle: string;
  skillStepTitle: string;
  selectedSkillId: string;
  selectedVersionId: string;
  oneOffVersionId: string;
};

export type DealStepRow = {
  id: string;
  stepId: string;
  origin: string;
  status: string;
  phaseIndex: number;
  displayOrder: number;
  title: string | null;
  assignedTo: string | null;
  removedAt: string | null;
};

export type DealBindingRow = {
  dealStepId: string;
  kind: string;
  skillId: string | null;
  versionId: string | null;
  digest: string;
  source: string;
};

function localAdmin(purpose: string): SupabaseClient {
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

function titleOf(definition: unknown): string | null {
  if (definition === null || typeof definition !== 'object') return null;
  const title = (definition as { title?: unknown }).title;
  return typeof title === 'string' ? title : null;
}

function freshDigest(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}

export async function programRailTemplateStub(program: StubProgram): Promise<void> {
  const response = await fetch(`${STUB_BASE}/__control/program`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(program),
  });
  if (!response.ok) {
    throw new Error(`could not program the rail template stub: ${response.status}`);
  }
}

export async function railTemplateStubCalls<K extends CapturedRailCall['kind']>(
  kind: K,
): Promise<Extract<CapturedRailCall, { kind: K }>[]> {
  const response = await fetch(`${STUB_BASE}/__control/rail-calls`);
  if (!response.ok) {
    throw new Error(`could not read the rail template stub's calls: ${response.status}`);
  }
  const { calls } = (await response.json()) as { calls: CapturedRailCall[] };
  return calls.filter(
    (call): call is Extract<CapturedRailCall, { kind: K }> => call.kind === kind,
  );
}

export async function readDealSteps(dealId: string): Promise<DealStepRow[]> {
  const admin = localAdmin('read a deal rail');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEPS)
    .select(
      'id, step_id, origin, status, phase_index, display_order, definition, assigned_to, removed_at',
    )
    .eq('deal_id', dealId)
    .order('display_order', { ascending: true });
  if (error) throw new Error(`could not read the deal rail: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    stepId: row.step_id as string,
    origin: row.origin as string,
    status: row.status as string,
    phaseIndex: row.phase_index as number,
    displayOrder: row.display_order as number,
    title: titleOf(row.definition),
    assignedTo: (row.assigned_to as string | null) ?? null,
    removedAt: (row.removed_at as string | null) ?? null,
  }));
}

export async function readDealBindings(dealId: string): Promise<DealBindingRow[]> {
  const admin = localAdmin('read the deal skill bindings');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_BINDINGS)
    .select('deal_step_id, kind, skill_id, version_id, digest, source')
    .eq('deal_id', dealId)
    .order('deal_step_id', { ascending: true });
  if (error) throw new Error(`could not read the deal bindings: ${error.message}`);
  return (data ?? []).map((row) => ({
    dealStepId: row.deal_step_id as string,
    kind: row.kind as string,
    skillId: (row.skill_id as string | null) ?? null,
    versionId: (row.version_id as string | null) ?? null,
    digest: row.digest as string,
    source: row.source as string,
  }));
}

export async function countSkillRuns(dealId: string): Promise<number> {
  const admin = localAdmin('count the recorded skill runs');
  const { count, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', dealId);
  if (error) throw new Error(`could not count the skill runs: ${error.message}`);
  return count ?? 0;
}

export async function readDealTemplateRevision(dealId: string): Promise<string | null> {
  const admin = localAdmin('read the deal template provenance');
  const { data, error } = await admin
    .from(TABLE.DEALS)
    .select('rail_template_revision_id')
    .eq('id', dealId)
    .maybeSingle();
  if (error) throw new Error(`could not read the deal provenance: ${error.message}`);
  return (data?.rail_template_revision_id as string | null) ?? null;
}

async function registerLead(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post('/api/v1/companies', { data: { name } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { company: { id: string } };
  return body.company.id;
}

async function removableCatalogSteps(dealId: string): Promise<DealStepRow[]> {
  const steps = await readDealSteps(dealId);
  return steps
    .filter(
      (step) =>
        step.removedAt === null &&
        step.origin === 'catalog' &&
        step.status === 'pending' &&
        !PROTECTED_STEP_IDS.has(step.stepId),
    )
    .sort((a, b) => b.displayOrder - a.displayOrder);
}

async function removeStep(
  request: APIRequestContext,
  dealRef: string,
  rowId: string,
): Promise<void> {
  const response = await request.delete(
    `/api/v1/deals/${encodeURIComponent(dealRef)}/rail/steps/${rowId}`,
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function stepRowId(dealId: string, stepId: string): Promise<string> {
  const admin = localAdmin('resolve a seeded step row');
  const { data, error } = await admin
    .from(TABLE.DEAL_STEPS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('step_id', stepId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`could not resolve the seeded step ${stepId}: ${error?.message ?? 'missing'}`);
  }
  return data.id as string;
}

async function seedPublishedVersion(opts: {
  dealId: string;
  actorId: string;
  name: string;
  stepKey: string;
  resultingStepId: string;
  skillId: string;
  versionId: string;
  digest: string;
}): Promise<void> {
  const admin = localAdmin('seed a published skill version');
  const draft = await seedPublishableDraft({
    dealId: opts.dealId,
    authorId: opts.actorId,
    name: opts.name,
  });
  const { data, error } = await admin
    .from('skill_authoring_candidates')
    .select('provider_candidate_id')
    .eq('id', draft.candidateId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`could not read the seeded candidate: ${error?.message ?? 'missing'}`);
  }

  const written = await admin.from('skill_publication_operations').insert({
    id: randomUUID(),
    deal_id: opts.dealId,
    draft_id: draft.draftId,
    actor_id: opts.actorId,
    client_request_id: randomUUID(),
    state: 'published',
    revision: 0,
    candidate_id: draft.candidateId,
    provider_candidate_id: data.provider_candidate_id as string,
    candidate_digest: draft.candidateDigest,
    draft_edit_revision: 0,
    name: opts.name,
    phase_index: 1,
    placement_kind: 'phase_end',
    reserved_skill_id: opts.skillId,
    reserved_step_key: opts.stepKey,
    capability_contract: {
      purpose: `Summarise diligence findings for ${opts.name}.`,
      expectedInput: `A diligence document reference for ${opts.name}.`,
      expectedOutput: `A written summary with open questions for ${opts.name}.`,
    },
    published_skill_id: opts.skillId,
    published_version_id: opts.versionId,
    published_digest: opts.digest,
    resulting_deal_step_id: opts.resultingStepId,
  });
  if (written.error) {
    throw new Error(`could not seed a published version: ${written.error.message}`);
  }

  const retired = await admin
    .from('skill_authoring_drafts')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', draft.draftId);
  if (retired.error) {
    throw new Error(`could not retire the seeded draft: ${retired.error.message}`);
  }
}

export async function seedTemplateJourney(opts: {
  runId: string;
  baseURL: string;
}): Promise<TemplateJourney> {
  await mintSeededSession(SOURCE_DIRECTOR_EMAIL, SOURCE_DIRECTOR_STATE_PATH, opts.baseURL);
  await mintSeededSession(SECOND_CREATOR_EMAIL, SECOND_CREATOR_STATE_PATH, opts.baseURL);
  await mintSeededSession(OUTSIDE_CREATOR_EMAIL, OUTSIDE_CREATOR_STATE_PATH, opts.baseURL);

  const request = await playwrightRequest.newContext({
    baseURL: opts.baseURL,
    storageState: SOURCE_DIRECTOR_STATE_PATH,
  });
  try {
    return await seedAsDirector(request, opts.runId);
  } finally {
    await request.dispose();
  }
}

async function seedAsDirector(
  request: APIRequestContext,
  runId: string,
): Promise<TemplateJourney> {
  const opts = { runId };
  const me = await request.get('/api/v1/me');
  expect(me.ok(), await me.text()).toBeTruthy();
  const actorId = ((await me.json()) as { user: { id: string } }).user.id;

  const leadName = `E2E Template Lead ${opts.runId}`;
  const leadCompanyId = await registerLead(request, leadName);

  const deal = await createRailDeal(request, { runId: opts.runId });
  const baseline = await readDealSteps(deal.id);
  const removable = await removableCatalogSteps(deal.id);
  expect(
    removable.length,
    'the baseline rail offers fewer than two removable non-protected steps',
  ).toBeGreaterThan(1);

  await removeStep(request, deal.code, removable[0].id);

  const tail = baseline[baseline.length - 1];
  const manualStepTitle = `Template manual step ${opts.runId}`;
  const manualStepId = `custom:${randomUUID()}`;
  await insertCustomStep(deal.id, {
    stepId: manualStepId,
    title: manualStepTitle,
    description: 'Confirm the buyer list with the deal team.',
    phaseIndex: tail.phaseIndex,
    displayOrder: tail.displayOrder + 1,
  });

  const skillStepTitle = `Template skill step ${opts.runId}`;
  const skillStepId = `custom:${randomUUID()}`;
  const skillId = randomUUID();
  const firstVersionId = randomUUID();
  const selectedVersionId = randomUUID();
  const oneOffVersionId = randomUUID();
  const selectedDigest = freshDigest();
  const oneOffDigest = freshDigest();

  await insertSkillStep(deal.id, {
    stepId: skillStepId,
    title: skillStepTitle,
    description: 'Draft the diligence readout.',
    helperText: 'Name the workstream to summarise.',
    binding: { skillId, versionId: firstVersionId, digest: freshDigest() },
    phaseIndex: tail.phaseIndex,
    displayOrder: tail.displayOrder + 2,
  });
  const skillRowId = await stepRowId(deal.id, skillStepId);

  await seedPublishedVersion({
    dealId: deal.id,
    actorId,
    name: `Diligence readout ${opts.runId}`,
    stepKey: skillStepId,
    resultingStepId: skillRowId,
    skillId,
    versionId: selectedVersionId,
    digest: selectedDigest,
  });
  await seedPublishedVersion({
    dealId: deal.id,
    actorId,
    name: `Diligence readout ${opts.runId} v3`,
    stepKey: skillStepId,
    resultingStepId: skillRowId,
    skillId,
    versionId: oneOffVersionId,
    digest: oneOffDigest,
  });

  const admin = localAdmin('select the default skill version');
  const bound = await admin.from(TABLE.DEAL_STEP_SKILL_BINDINGS).insert({
    deal_step_id: skillRowId,
    deal_id: deal.id,
    kind: 'publication',
    skill_id: skillId,
    version_id: selectedVersionId,
    digest: selectedDigest,
    bound_by: actorId,
    source: 'selection',
  });
  if (bound.error) {
    throw new Error(`could not select the default skill version: ${bound.error.message}`);
  }

  const ran = await admin.from(TABLE.DEAL_STEP_SKILL_RUNS).insert({
    id: randomUUID(),
    deal_id: deal.id,
    deal_step_id: skillRowId,
    actor_id: actorId,
    skill_id: skillId,
    version_id: oneOffVersionId,
    digest: oneOffDigest,
    input: 'A one-off run against a newer version.',
    outcome: 'succeeded',
    result_text: 'The newest version ran once and was never made the default.',
    source: 'execution',
  });
  if (ran.error) {
    throw new Error(`could not record the one-off run: ${ran.error.message}`);
  }

  return {
    source: { id: deal.id, code: deal.code },
    sourceDirectorStorageState: SOURCE_DIRECTOR_STATE_PATH,
    secondCreatorStorageState: SECOND_CREATOR_STATE_PATH,
    outsideCreatorStorageState: OUTSIDE_CREATOR_STATE_PATH,
    leadName,
    leadCompanyId,
    baselineStepCount: baseline.length,
    removedStepId: removable[0].stepId,
    secondRemovableStepId: removable[1].stepId,
    secondRemovableStepRowId: removable[1].id,
    manualStepTitle,
    skillStepTitle,
    selectedSkillId: skillId,
    selectedVersionId,
    oneOffVersionId,
  };
}
