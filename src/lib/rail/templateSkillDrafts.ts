import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { housePhases } from '@/lib/rail/railTemplateCatalog';
import { displayOrderForPlacement, type TemplateStepOrder } from '@/lib/rail/templateChanges';
import {
  streamAuthoringTurn,
  type TurnCandidate,
  type TurnCandidatePreview,
} from '@/lib/skillAuthoring/ignatiousAuthoring';
import {
  GENERATION_FAILED,
  GENERATION_FAILED_MESSAGE,
  storableCandidate,
} from '@/lib/skillAuthoring/runTurn';
import { authoringUsageOf, type AuthoringUsageRecorder } from '@/lib/skillAuthoring/authoringUsage';
import type { AttemptRead, CandidatePreview, DraftRead, Placement } from '@/lib/skillAuthoring/types';
import { parseSkillInputFields } from '@/lib/skillRun/inputs';
import type { CandidateSkillSource } from '@/lib/railTemplates/types';
import { isDigest, isUuid } from '@/lib/skillPublication/parse';
import type { CapabilityContract, SkillStepDefinitionV1 } from '@/lib/skillPublication/types';
import { dbFailure } from '@/lib/errors/upstream';

const NAME_MAX = 100;
const COMPOSER_MAX = 20000;
const CONTRACT_MAX = 2000;

type StoredMessage = DraftRead['messages'][number];

type DraftRow = {
  id: string;
  template_id: string;
  status: DraftRead['status'];
  name: string;
  placement: unknown;
  composer_text: string;
  edit_revision: number;
  messages: unknown;
  candidate: unknown;
};

export type DraftFailure = { ok: false; status: number; error: string; draft?: DraftRead };

export function parseTemplatePlacement(value: unknown): Placement | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { kind?: unknown; phaseIndex?: unknown; afterStepId?: unknown };
  if (typeof record.phaseIndex !== 'number' || !Number.isInteger(record.phaseIndex)) return null;
  if (record.kind === 'phase_start' || record.kind === 'phase_end') {
    return { kind: record.kind, phaseIndex: record.phaseIndex };
  }
  if (record.kind === 'after' && typeof record.afterStepId === 'string') {
    return { kind: 'after', phaseIndex: record.phaseIndex, afterStepId: record.afterStepId };
  }
  return null;
}

export function presentTemplateSkillDraft(row: DraftRow): DraftRead {
  const messages = storedMessages(row.messages);
  return {
    id: row.id,
    dealId: row.template_id,
    status: row.status,
    name: row.name,
    placement: parseTemplatePlacement(row.placement),
    composerText: row.composer_text,
    editRevision: Number(row.edit_revision),
    messages,
    activeAttempt: runningAttempt(messages),
    candidate: storedCandidate(row.candidate),
    publication: { available: false },
  };
}

export type TemplateSkillStepDefinition = Omit<SkillStepDefinitionV1, 'skillBinding'> & {
  skill: { name: string; contract: CapabilityContract; source: CandidateSkillSource };
};

function contractText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= CONTRACT_MAX ? text : null;
}

export function templateSkillStepDefinition(
  name: string,
  candidate: CandidatePreview,
): TemplateSkillStepDefinition | null {
  const title = name.trim();
  const purpose = contractText(candidate.purpose);
  const expectedInput = contractText(candidate.expectedInput);
  const expectedOutput = contractText(candidate.expectedOutput);
  if (!title || !purpose || !expectedInput || !expectedOutput) return null;
  if (!isUuid(candidate.id) || !isDigest(candidate.digest)) return null;
  return {
    schemaVersion: 1,
    type: 'skill',
    title,
    description: purpose,
    inputs: [
      { key: 'primary', kind: 'text', label: 'Input', helperText: expectedInput, required: true },
    ],
    skill: {
      name: title,
      contract: { purpose, expectedInput, expectedOutput },
      source: { kind: 'candidate', candidateId: candidate.id, digest: candidate.digest },
    },
  };
}

export async function openTemplateSkillDraft(
  admin: SupabaseClient,
  input: { companyId: string; authorId: string; templateId: string; placement: Placement | null },
): Promise<DraftRead> {
  const existing = await activeDraft(admin, input.templateId, input.authorId);
  if (existing) {
    if (!input.placement) return presentTemplateSkillDraft(existing);
    const { data, error } = await admin
      .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
      .update({
        placement: input.placement,
        edit_revision: Number(existing.edit_revision) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select(DRAFT_COLUMNS)
      .single();
    if (error || !data) return presentTemplateSkillDraft(existing);
    return presentTemplateSkillDraft(data as DraftRow);
  }

  const { data, error } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .insert({
      template_id: input.templateId,
      company_id: input.companyId,
      author_id: input.authorId,
      placement: input.placement,
    })
    .select(DRAFT_COLUMNS)
    .single();
  if (error?.code === '23505') {
    const raced = await activeDraft(admin, input.templateId, input.authorId);
    if (raced) return presentTemplateSkillDraft(raced);
  }
  if (error || !data) throw error ? dbFailure('Skill draft read', error) : new Error('Could not open the skill draft.');
  return presentTemplateSkillDraft(data as DraftRow);
}

export async function readTemplateSkillDraft(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
): Promise<DraftRead | null> {
  const row = await draftRow(admin, templateId, draftId);
  return row ? presentTemplateSkillDraft(row) : null;
}

export async function patchTemplateSkillDraft(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
  patch: { expectedEditRevision: number; name: string; placement: Placement | null; composerText: string },
): Promise<{ draft: DraftRead } | DraftFailure> {
  if (patch.name.length > NAME_MAX || patch.composerText.length > COMPOSER_MAX) {
    return { ok: false, status: 400, error: 'That draft is too long.' };
  }
  const row = await draftRow(admin, templateId, draftId);
  if (!row || row.status !== 'active') return { ok: false, status: 404, error: 'Draft not found.' };
  const current = presentTemplateSkillDraft(row);
  if (runningAttempt(current.messages)) {
    return { ok: false, status: 409, error: 'Finish the current response before editing.', draft: current };
  }
  if (Number(row.edit_revision) !== patch.expectedEditRevision) {
    return { ok: false, status: 409, error: 'The draft changed. Try again.', draft: current };
  }
  const { data, error } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .update({
      name: patch.name,
      placement: patch.placement,
      composer_text: patch.composerText,
      edit_revision: patch.expectedEditRevision + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .eq('edit_revision', patch.expectedEditRevision)
    .select(DRAFT_COLUMNS)
    .single();
  if (error || !data) return { ok: false, status: 409, error: 'The draft changed. Try again.', draft: current };
  return { draft: presentTemplateSkillDraft(data as DraftRow) };
}

export async function submitTemplateSkillMessage(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
  command: { expectedEditRevision: number; text: string },
): Promise<{ attemptId: string } | DraftFailure> {
  return beginAttempt(admin, templateId, draftId, command.expectedEditRevision, null, command.text);
}

export async function retryTemplateSkillMessage(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
  messageId: string,
): Promise<{ attemptId: string } | DraftFailure> {
  const row = await draftRow(admin, templateId, draftId);
  if (!row || row.status !== 'active') return { ok: false, status: 404, error: 'Draft not found.' };
  return beginAttempt(admin, templateId, draftId, Number(row.edit_revision), messageId, null);
}

export async function discardTemplateSkillDraft(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
  expectedEditRevision: number,
): Promise<{ ok: true } | DraftFailure> {
  const row = await draftRow(admin, templateId, draftId);
  if (!row || row.status !== 'active') return { ok: false, status: 404, error: 'Draft not found.' };
  if (Number(row.edit_revision) !== expectedEditRevision) {
    return { ok: false, status: 409, error: 'The draft changed. Try again.', draft: presentTemplateSkillDraft(row) };
  }
  const { error } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('status', 'active');
  if (error) return { ok: false, status: 500, error: 'Could not discard the draft.' };
  return { ok: true };
}

export async function publishTemplateSkillDraft(
  admin: SupabaseClient,
  input: {
    companyId: string;
    authorId: string;
    templateId: string;
    draftId: string;
    expectedEditRevision: number;
    candidateId: string;
    candidateDigest: string;
  },
): Promise<{ stepId: string; digest: string } | DraftFailure> {
  const row = await draftRow(admin, input.templateId, input.draftId);
  if (!row || row.status !== 'active') return { ok: false, status: 404, error: 'Draft not found.' };
  const draft = presentTemplateSkillDraft(row);
  if (Number(row.edit_revision) !== input.expectedEditRevision) {
    return { ok: false, status: 409, error: 'The draft changed. Try again.', draft };
  }
  if (!draft.candidate || draft.candidate.id !== input.candidateId || draft.candidate.digest !== input.candidateDigest) {
    return { ok: false, status: 409, error: 'Generate a candidate skill before saving.', draft };
  }
  const name = draft.name.trim();
  if (!name) return { ok: false, status: 400, error: 'Name the step before saving.', draft };
  if (!draft.placement) return { ok: false, status: 400, error: 'Choose a position before saving.', draft };
  if (!housePhases().some((phase) => phase.index === draft.placement?.phaseIndex)) {
    return { ok: false, status: 400, error: 'Choose a phase for the step.', draft };
  }

  const definition = templateSkillStepDefinition(name, draft.candidate);
  if (!definition) {
    return { ok: false, status: 409, error: 'Generate a candidate skill before saving.', draft };
  }

  const steps = await templateSteps(admin, input.templateId);
  const at = displayOrderForPlacement(steps, draft.placement);
  if (at == null) return { ok: false, status: 400, error: 'Choose a position before saving.', draft };

  const stepKey = `custom-${randomUUID()}`;
  const { data, error } = await admin.rpc('add_rail_template_step', {
    p_company_id: input.companyId,
    p_actor_id: input.authorId,
    p_template_id: input.templateId,
    p_step_id: stepKey,
    p_seq: null,
    p_phase_index: draft.placement.phaseIndex,
    p_origin: 'custom',
    p_definition: definition,
    p_at: at,
  });
  if (error?.code === 'P0003') return { ok: false, status: 404, error: 'Template not found.' };
  if (error) return { ok: false, status: 500, error: 'Could not add the step.' };
  const stepId = recordId(data);
  if (!stepId) return { ok: false, status: 500, error: 'Could not add the step.' };

  await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', input.draftId);

  return { stepId, digest: draft.candidate.digest };
}

export async function runTemplateAuthoringTurn(
  admin: SupabaseClient,
  draftId: string,
  attemptId: string,
  record?: AuthoringUsageRecorder,
): Promise<void> {
  const row = await draftById(admin, draftId);
  if (!row) return;
  const messages = storedMessages(row.messages);
  const attempt = findAttempt(messages, attemptId);
  if (!attempt || attempt.status !== 'running') return;
  const message = messages.find((item) => item.attempts.some((candidate) => candidate.id === attemptId));
  if (!message) return;

  const config = readIgnatiousConfig();
  if (!config) {
    await finishAttempt(admin, draftId, attemptId, {
      status: 'failed',
      responseText: '',
      error: { code: 'unavailable', message: 'Skill drafting is not available right now.' },
      candidate: null,
    });
    return;
  }

  const history = messages.flatMap((item) => {
    const last = item.attempts[item.attempts.length - 1];
    const turns: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: item.text }];
    if (last && last.id !== attemptId && last.responseText) {
      turns.push({ role: 'assistant', content: last.responseText });
    }
    return turns;
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 280_000);
  let text = '';
  let candidate: TurnCandidate | null = null;
  let lastFlush = Date.now();
  try {
    for await (const line of streamAuthoringTurn(
      config,
      {
        attemptId,
        history,
        message: message.text,
        currentCandidate: previewOf(storedCandidate(row.candidate)),
        basis: null,
        seedRun: null,
      },
      controller.signal,
    )) {
      if (line.type === 'text') {
        text += line.text;
        if (Date.now() - lastFlush >= 500) {
          lastFlush = Date.now();
          await writeAttemptProgress(admin, draftId, attemptId, text);
        }
      } else if (line.type === 'candidate') {
        const { type: _type, ...rest } = line;
        candidate = storableCandidate(rest);
      } else if (line.type === 'error') {
        await finishAttempt(admin, draftId, attemptId, {
          status: 'failed',
          responseText: text,
          error: { code: line.code, message: line.message },
          candidate: null,
        });
        return;
      } else {
        await finishAttempt(admin, draftId, attemptId, {
          status: 'succeeded',
          responseText: text,
          error: null,
          candidate: candidatePreview(candidate),
        });
        await record?.(attemptId, 'catalog_skill_authoring', authoringUsageOf(line));
        return;
      }
    }
    await finishAttempt(admin, draftId, attemptId, {
      status: 'failed',
      responseText: text,
      error: { code: GENERATION_FAILED, message: GENERATION_FAILED_MESSAGE },
      candidate: null,
    });
  } catch {
    await finishAttempt(admin, draftId, attemptId, {
      status: 'failed',
      responseText: text,
      error: { code: GENERATION_FAILED, message: GENERATION_FAILED_MESSAGE },
      candidate: null,
    }).catch(() => undefined);
  } finally {
    clearTimeout(deadline);
  }
}

const DRAFT_COLUMNS = 'id, template_id, status, name, placement, composer_text, edit_revision, messages, candidate';

async function activeDraft(admin: SupabaseClient, templateId: string, authorId: string): Promise<DraftRow | null> {
  const { data } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .select(DRAFT_COLUMNS)
    .eq('template_id', templateId)
    .eq('author_id', authorId)
    .eq('status', 'active')
    .maybeSingle();
  return (data as DraftRow | null) ?? null;
}

async function draftRow(admin: SupabaseClient, templateId: string, draftId: string): Promise<DraftRow | null> {
  const { data } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .select(DRAFT_COLUMNS)
    .eq('template_id', templateId)
    .eq('id', draftId)
    .maybeSingle();
  return (data as DraftRow | null) ?? null;
}

async function draftById(admin: SupabaseClient, draftId: string): Promise<DraftRow | null> {
  const { data } = await admin.from(TABLE.RAIL_CATALOG_SKILL_DRAFTS).select(DRAFT_COLUMNS).eq('id', draftId).maybeSingle();
  return (data as DraftRow | null) ?? null;
}

async function beginAttempt(
  admin: SupabaseClient,
  templateId: string,
  draftId: string,
  expectedEditRevision: number,
  messageId: string | null,
  text: string | null,
): Promise<{ attemptId: string } | DraftFailure> {
  const row = await draftRow(admin, templateId, draftId);
  if (!row || row.status !== 'active') return { ok: false, status: 404, error: 'Draft not found.' };
  const current = presentTemplateSkillDraft(row);
  if (Number(row.edit_revision) !== expectedEditRevision) {
    return { ok: false, status: 409, error: 'The draft changed. Try again.', draft: current };
  }
  if (runningAttempt(current.messages)) {
    return { ok: false, status: 409, error: 'Finish the current response before sending another.', draft: current };
  }
  const attempt: AttemptRead = {
    id: randomUUID(),
    messageId: messageId ?? randomUUID(),
    number: 1,
    status: 'running',
    responseText: '',
    error: null,
  };
  const messages = storedMessages(row.messages);
  if (messageId) {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return { ok: false, status: 404, error: 'Draft not found.' };
    attempt.messageId = message.id;
    attempt.number = message.attempts.length + 1;
    message.attempts.push(attempt);
  } else {
    const body = text?.trim() ?? '';
    if (!body) return { ok: false, status: 400, error: 'Describe the skill you want to build.' };
    messages.push({ id: attempt.messageId, ordinal: messages.length + 1, text: body, attempts: [attempt] });
  }
  const { error } = await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .update({
      messages,
      composer_text: messageId ? row.composer_text : '',
      edit_revision: expectedEditRevision + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .eq('edit_revision', expectedEditRevision);
  if (error) return { ok: false, status: 409, error: 'The draft changed. Try again.', draft: current };
  return { attemptId: attempt.id };
}

async function writeAttemptProgress(admin: SupabaseClient, draftId: string, attemptId: string, responseText: string) {
  const row = await draftById(admin, draftId);
  if (!row) return;
  const messages = storedMessages(row.messages);
  const attempt = findAttempt(messages, attemptId);
  if (!attempt || attempt.status !== 'running') return;
  attempt.responseText = responseText;
  await admin.from(TABLE.RAIL_CATALOG_SKILL_DRAFTS).update({ messages, updated_at: new Date().toISOString() }).eq('id', draftId);
}

async function finishAttempt(
  admin: SupabaseClient,
  draftId: string,
  attemptId: string,
  outcome: {
    status: 'succeeded' | 'failed';
    responseText: string;
    error: { code: string; message: string } | null;
    candidate: CandidatePreview | null;
  },
) {
  const row = await draftById(admin, draftId);
  if (!row) return;
  const messages = storedMessages(row.messages);
  const attempt = findAttempt(messages, attemptId);
  if (!attempt || attempt.status !== 'running') return;
  attempt.status = outcome.status;
  attempt.responseText = outcome.responseText;
  attempt.error = outcome.error;
  await admin
    .from(TABLE.RAIL_CATALOG_SKILL_DRAFTS)
    .update({
      messages,
      candidate: outcome.candidate ?? row.candidate,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId);
}

function candidatePreview(candidate: TurnCandidate | null): CandidatePreview | null {
  if (!candidate) return null;
  const preview = candidate.preview;
  if (!previewText(preview.name) || !previewText(preview.purpose)) return null;
  return {
    id: candidate.providerCandidateId,
    digest: candidate.contentDigest,
    schemaVersion: 1,
    name: preview.name,
    purpose: preview.purpose,
    expectedInput: preview.expectedInput,
    expectedOutput: preview.expectedOutput,
    inputs: parseSkillInputFields(preview.inputs),
  };
}

function previewOf(candidate: CandidatePreview | null): TurnCandidatePreview | null {
  if (!candidate) return null;
  return {
    name: candidate.name,
    purpose: candidate.purpose,
    expectedInput: candidate.expectedInput,
    expectedOutput: candidate.expectedOutput,
    inputs: parseSkillInputFields(candidate.inputs),
  };
}

function previewText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function templateSteps(admin: SupabaseClient, templateId: string): Promise<TemplateStepOrder[]> {
  const { data } = await admin
    .from(TABLE.RAIL_CATALOG_STEPS)
    .select('id, step_id, phase_index, display_order')
    .eq('template_id', templateId);
  return ((data ?? []) as { id: string; step_id: string; phase_index: number; display_order: number }[]).map((step) => ({
    id: step.id,
    stepId: step.step_id,
    phaseIndex: step.phase_index,
    displayOrder: step.display_order,
  }));
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function storedMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const message = item as StoredMessage;
    if (typeof message.id !== 'string' || typeof message.text !== 'string' || !Array.isArray(message.attempts)) return [];
    return [message];
  });
}

function storedCandidate(value: unknown): CandidatePreview | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as CandidatePreview;
  if (candidate.schemaVersion !== 1 || typeof candidate.id !== 'string' || typeof candidate.digest !== 'string') return null;
  if (!previewText(candidate.name) || !previewText(candidate.purpose)) return null;
  return { ...candidate, inputs: parseSkillInputFields(candidate.inputs) };
}

function runningAttempt(messages: readonly StoredMessage[]): AttemptRead | null {
  for (const message of messages) {
    const attempt = message.attempts.find((item) => item.status === 'running');
    if (attempt) return attempt;
  }
  return null;
}

function findAttempt(messages: readonly StoredMessage[], attemptId: string): AttemptRead | null {
  for (const message of messages) {
    const attempt = message.attempts.find((item) => item.id === attemptId);
    if (attempt) return attempt;
  }
  return null;
}
