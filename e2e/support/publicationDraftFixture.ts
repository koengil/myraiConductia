import type { APIRequestContext } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

export const PROCESSOR_SWEEP_TOKEN = 'e2e-processor-sweep-token';

export type SeededDraft = {
  draftId: string;
  candidateId: string;
  candidateDigest: string;
  name: string;
};

function freshDigest(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}

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

type WriteResult = { error: { message: string } | null };

function assertWritten(table: string, result: WriteResult): void {
  if (result.error) {
    throw new Error(`could not seed ${table}: ${result.error.message}`);
  }
}

async function insertDraft(
  admin: SupabaseClient,
  opts: { dealId: string; authorId: string; name: string; phaseIndex: number },
): Promise<string> {
  const draftId = randomUUID();
  assertWritten(
    'skill_authoring_drafts',
    await admin.from('skill_authoring_drafts').insert({
      id: draftId,
      deal_id: opts.dealId,
      author_id: opts.authorId,
      name: opts.name,
      phase_index: opts.phaseIndex,
      placement_kind: 'phase_end',
    }),
  );
  return draftId;
}

async function insertMessageAndAttempt(
  admin: SupabaseClient,
  draftId: string,
  authorId: string,
): Promise<string> {
  const messageId = randomUUID();
  assertWritten(
    'skill_authoring_messages',
    await admin.from('skill_authoring_messages').insert({
      id: messageId,
      draft_id: draftId,
      author_id: authorId,
      ordinal: 1,
      text: 'Seeded for browser verification of skill publication.',
      client_message_id: randomUUID(),
      admitted_edit_revision: 0,
    }),
  );
  const attemptId = randomUUID();
  assertWritten(
    'skill_authoring_attempts',
    await admin.from('skill_authoring_attempts').insert({
      id: attemptId,
      draft_id: draftId,
      message_id: messageId,
      attempt_number: 1,
      status: 'succeeded',
      response_text: 'Seeded candidate.',
      completed_at: new Date().toISOString(),
    }),
  );
  return attemptId;
}

async function insertCandidate(
  admin: SupabaseClient,
  opts: { draftId: string; attemptId: string; name: string; digest: string },
): Promise<string> {
  const candidateId = randomUUID();
  assertWritten(
    'skill_authoring_candidates',
    await admin.from('skill_authoring_candidates').insert({
      id: candidateId,
      draft_id: opts.draftId,
      attempt_id: opts.attemptId,
      provider_candidate_id: randomUUID(),
      content_digest: opts.digest,
      schema_version: 1,
      preview: {
        name: opts.name,
        purpose: `Summarise diligence findings for ${opts.name}.`,
        expectedInput: `A diligence document reference for ${opts.name}.`,
        expectedOutput: `A written summary with open questions for ${opts.name}.`,
      },
    }),
  );
  assertWritten(
    'skill_authoring_drafts',
    await admin
      .from('skill_authoring_drafts')
      .update({ current_candidate_id: candidateId })
      .eq('id', opts.draftId),
  );
  return candidateId;
}

export async function seedPublishableDraft(opts: {
  dealId: string;
  authorId: string;
  name: string;
  phaseIndex?: number;
  digest?: string;
}): Promise<SeededDraft> {
  const admin = localAdmin('seed a publishable skill draft');
  const digest = opts.digest ?? freshDigest();
  const draftId = await insertDraft(admin, {
    dealId: opts.dealId,
    authorId: opts.authorId,
    name: opts.name,
    phaseIndex: opts.phaseIndex ?? 1,
  });
  const attemptId = await insertMessageAndAttempt(admin, draftId, opts.authorId);
  const candidateId = await insertCandidate(admin, {
    draftId,
    attemptId,
    name: opts.name,
    digest,
  });
  return { draftId, candidateId, candidateDigest: digest, name: opts.name };
}

export async function seedAnchoredDraft(opts: {
  dealId: string;
  authorId: string;
  name: string;
  anchorDealStepId: string;
  phaseIndex?: number;
}): Promise<SeededDraft> {
  const seeded = await seedPublishableDraft({
    dealId: opts.dealId,
    authorId: opts.authorId,
    name: opts.name,
    phaseIndex: opts.phaseIndex,
  });
  const admin = localAdmin('anchor a seeded skill draft');
  assertWritten(
    'skill_authoring_drafts',
    await admin
      .from('skill_authoring_drafts')
      .update({ placement_kind: 'after', anchor_deal_step_id: opts.anchorDealStepId })
      .eq('id', seeded.draftId),
  );
  return seeded;
}

export async function discardSeededDrafts(dealId: string): Promise<void> {
  const admin = localAdmin('discard seeded skill drafts');
  const drafts = await admin.from('skill_authoring_drafts').select('id').eq('deal_id', dealId);
  if (drafts.error) throw new Error(`could not read seeded drafts: ${drafts.error.message}`);
  const ids = (drafts.data ?? []).map((row) => row.id as string);
  if (ids.length === 0) return;
  assertWritten(
    'skill_publication_operations',
    await admin.from('skill_publication_operations').delete().in('draft_id', ids),
  );
  assertWritten(
    'skill_authoring_drafts',
    await admin.from('skill_authoring_drafts').update({ current_candidate_id: null }).in('id', ids),
  );
  assertWritten(
    'skill_authoring_candidates',
    await admin.from('skill_authoring_candidates').delete().in('draft_id', ids),
  );
  assertWritten(
    'skill_authoring_attempts',
    await admin.from('skill_authoring_attempts').delete().in('draft_id', ids),
  );
  assertWritten(
    'skill_authoring_messages',
    await admin.from('skill_authoring_messages').delete().in('draft_id', ids),
  );
  assertWritten(
    'skill_authoring_drafts',
    await admin.from('skill_authoring_drafts').delete().in('id', ids),
  );
}

export async function publicationStateOf(draftId: string): Promise<string | null> {
  const admin = localAdmin('read the publication state');
  const { data, error } = await admin
    .from('skill_publication_operations')
    .select('state')
    .eq('draft_id', draftId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not read the publication state: ${error.message}`);
  return (data ?? []).length > 0 ? ((data as { state: string }[])[0].state ?? null) : null;
}

export async function programPublicationStub(program: unknown): Promise<void> {
  const base = process.env.PUBLICATION_STUB_URL ?? 'http://127.0.0.1:4311';
  const response = await fetch(`${base}/__control/program`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(program),
  });
  if (!response.ok) {
    throw new Error(`could not program the publication stub: ${response.status}`);
  }
}

export async function publicationStubCalls(): Promise<
  Array<{ method: string; path: string; authorization: string | null }>
> {
  const base = process.env.PUBLICATION_STUB_URL ?? 'http://127.0.0.1:4311';
  const response = await fetch(`${base}/__control/calls`);
  if (!response.ok) {
    throw new Error(`could not read the publication stub's calls: ${response.status}`);
  }
  const body = (await response.json()) as {
    calls: Array<{ method: string; path: string; authorization: string | null }>;
  };
  return body.calls;
}

export async function sweepPublications(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/v1/internal/skill-publications/process', {
    headers: { Authorization: `Bearer ${PROCESSOR_SWEEP_TOKEN}` },
  });
  if (!response.ok()) {
    throw new Error(`the publication sweep failed: ${response.status()} ${await response.text()}`);
  }
}
