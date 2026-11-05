import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { requireLocalDatabase, runPsql } from '../db/localDatabase';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack or the -dev project).',
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql',
);

const RUN = Date.now().toString(36);
const TENANT = randomUUID();

const dealIds: string[] = [];
let bankId = '';

async function seedStep(options: {
  stepId: string;
  input: string | null;
  reply: string | null;
  startedAt: string | null;
}) {
  if (!bankId) {
    const { data: bank, error } = await admin
      .from('companies')
      .insert({ tenant_id: TENANT, name: `Import Bank ${RUN}`, type: 'bank' })
      .select('id')
      .single();
    if (error || !bank) throw new Error(`bank seed failed: ${error?.message}`);
    bankId = bank.id;
  }

  const { data: deal, error: dealError } = await admin
    .from('deals')
    .insert({
      tenant_id: TENANT,
      code: `IMP-${RUN}-${dealIds.length + 1}`,
      codename: `Import Deal ${RUN} ${dealIds.length + 1}`,
      bank_id: bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`deal seed failed: ${dealError?.message}`);
  const dealId = deal.id as string;
  dealIds.push(dealId);

  const work: Record<string, unknown> = {};
  if (options.input !== null) work.meeting_notes = options.input;
  if (options.reply !== null) work.next_actions = options.reply;

  const { data: step, error: stepError } = await admin
    .from('deal_steps')
    .insert({
      deal_id: dealId,
      step_id: options.stepId,
      status: 'pending',
      origin: 'catalog',
      work,
      bench_run_started_at: options.startedAt,
    })
    .select('id')
    .single();
  if (stepError || !step) throw new Error(`step seed failed: ${stepError?.message}`);

  return { dealId, stepId: step.id as string };
}

function seedCatalogStepWithReply(options: {
  input: string | null;
  reply: string | null;
  startedAt: string | null;
}) {
  return seedStep({ stepId: 'p1-s10', ...options });
}

function seedUnknowableStepWithReply(options: {
  input: string | null;
  reply: string | null;
  startedAt: string | null;
}) {
  return seedStep({ stepId: 'p1-s11', ...options });
}

// Only the import statement is replayed, cut from the migration source so it
// cannot drift from what shipped. Replaying the whole file would also re-run
// its DDL and put the database back to 20260916140000's state, for example
// its audit_log_action_check, which lacks every action added since.
const IMPORT_START = 'insert into deal_step_skill_runs (';

function importStatement(): string {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const start = sql.indexOf(IMPORT_START);
  if (start === -1 || sql.indexOf(IMPORT_START, start + 1) !== -1) {
    throw new Error(`expected exactly one "${IMPORT_START}" in ${MIGRATION_PATH}`);
  }
  const end = sql.indexOf(';', start);
  if (end === -1) throw new Error('import statement has no terminating semicolon');
  const statement = sql.slice(start, end + 1);
  if (!statement.includes("'imported'") || !statement.includes('not exists')) {
    throw new Error('the cut statement is not the guarded bench-reply import');
  }
  return statement;
}

function runImportStatement(): void {
  const target = requireLocalDatabase();
  runPsql(target, ['-v', 'ON_ERROR_STOP=1', '-f', '-'], importStatement());
}

afterAll(async () => {
  for (const dealId of dealIds) {
    await admin.from('deal_step_skill_runs').delete().eq('deal_id', dealId);
    await admin.from('deal_steps').delete().eq('deal_id', dealId);
  }
  for (const dealId of dealIds) {
    await admin.from('deals').delete().eq('id', dealId);
  }
  if (bankId) {
    await admin.from('companies').delete().eq('id', bankId);
  }
});

describe('import bench replies', () => {
  it('imports one run per catalog step that holds a bench reply', async () => {
    const { dealId, stepId } = await seedCatalogStepWithReply({
      input: 'Check Acme',
      reply: 'High confidence.',
      startedAt: '2026-09-01T10:00:00Z',
    });

    runImportStatement();

    const { data } = await admin
      .from('deal_step_skill_runs')
      .select('*')
      .eq('deal_step_id', stepId);

    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({
      deal_id: dealId,
      source: 'imported',
      input: 'Check Acme',
      result_text: 'High confidence.',
      outcome: 'succeeded',
      skill_id: null,
      version_id: null,
      digest: null,
      actor_id: null,
    });
    expect(new Date(data?.[0].created_at as string).toISOString()).toBe(
      '2026-09-01T10:00:00.000Z',
    );
  });

  it('imports nothing for a step with no reply', async () => {
    const { stepId } = await seedCatalogStepWithReply({
      input: null,
      reply: null,
      startedAt: null,
    });
    runImportStatement();
    const { data } = await admin
      .from('deal_step_skill_runs')
      .select('id')
      .eq('deal_step_id', stepId);
    expect(data).toEqual([]);
  });

  it('imports nothing a second time', async () => {
    const { stepId } = await seedCatalogStepWithReply({
      input: 'Check Acme',
      reply: 'High confidence.',
      startedAt: null,
    });
    runImportStatement();
    runImportStatement();
    const { data } = await admin
      .from('deal_step_skill_runs')
      .select('id')
      .eq('deal_step_id', stepId);
    expect(data).toHaveLength(1);
  });

  it('imports nothing for a step whose reply key cannot be identified', async () => {
    const { stepId } = await seedUnknowableStepWithReply({
      input: 'Some input text',
      reply: 'Some reply text',
      startedAt: '2026-09-01T10:00:00Z',
    });
    runImportStatement();
    const { data } = await admin
      .from('deal_step_skill_runs')
      .select('id')
      .eq('deal_step_id', stepId);
    expect(data).toEqual([]);
  });
});
