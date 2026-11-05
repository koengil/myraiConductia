import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { RAIL_CENSUS_VERSION } from '../src/lib/constants/dealSteps';
import {
  DEAL_RAIL,
  GATE0_STEP_ID_SET,
  MVP_DEAL_RAIL,
  railSeedRows,
  type RailSeedRow,
} from '../src/lib/rail/dealRail';

type StepRow = { step_id: string; seq: number | null };
type BackfillRow = RailSeedRow & { retired: boolean; missing: boolean };

function planDeal(steps: StepRow[]): BackfillRow[] {
  const active = railSeedRows(MVP_DEAL_RAIL);
  const census = railSeedRows(DEAL_RAIL);
  const activeIds = new Set(active.map((row) => row.stepId));
  const censusIds = new Set(census.map((row) => row.stepId));
  const retired = census.filter((row) => !activeIds.has(row.stepId)).sort((a, b) => a.seq - b.seq);
  const retiredIds = new Set(retired.map((row) => row.stepId));
  const present = new Set(steps.map((step) => step.step_id));

  return [...retired, ...active]
    .sort((a, b) => a.phaseIndex - b.phaseIndex)
    .filter((row) => present.has(row.stepId) || !censusIds.has(row.stepId))
    .map((row, index) => ({
      ...row,
      displayOrder: index + 1,
      retired: retiredIds.has(row.stepId),
      missing: !present.has(row.stepId),
    }));
}

async function setCurrentDealStepId(admin: SupabaseClient, dealId: string): Promise<void> {
  const { data: active, error: activeError } = await admin
    .from('deal_steps')
    .select('id, seq, status, step_id')
    .eq('deal_id', dealId)
    .is('removed_at', null)
    .order('display_order');
  if (activeError) throw activeError;

  const rows = (active ?? []) as { id: string; seq: number | null; status: string; step_id: string }[];
  const pending = rows.filter((row) => row.status === 'pending');
  const current =
    rows.find((row) => row.status === 'current') ??
    pending.find((row) => !GATE0_STEP_ID_SET.has(row.step_id)) ??
    pending[0];
  if (current && current.status !== 'current') {
    const { error: promoteError } = await admin
      .from('deal_steps')
      .update({ status: 'current' })
      .eq('id', current.id);
    if (promoteError) throw promoteError;
  }

  const position: { current_deal_step_id: string | null; current_step_seq?: number } = {
    current_deal_step_id: current?.id ?? null,
  };
  if (current?.seq != null) position.current_step_seq = current.seq;

  const { error } = await admin.from('deals').update(position).eq('id', dealId);
  if (error) throw error;
}

async function applyDeal(admin: SupabaseClient, dealId: string, rows: BackfillRow[]): Promise<void> {
  for (const row of rows) {
    if (row.missing) {
      const { error: insertError } = await admin.from('deal_steps').insert([
        {
          deal_id: dealId,
          step_id: row.stepId,
          seq: row.seq,
          census_version: RAIL_CENSUS_VERSION,
          phase_index: row.phaseIndex,
          display_order: row.displayOrder,
          status: 'skipped_entry',
        },
      ]);
      if (insertError) throw insertError;
      continue;
    }

    const { error } = await admin
      .from('deal_steps')
      .update({ phase_index: row.phaseIndex, display_order: row.displayOrder })
      .eq('deal_id', dealId)
      .eq('step_id', row.stepId);
    if (error) throw error;

    if (row.retired) {
      const { error: retireError } = await admin
        .from('deal_steps')
        .update({ removed_at: new Date().toISOString(), removed_by: null })
        .eq('deal_id', dealId)
        .eq('step_id', row.stepId)
        .is('removed_at', null);
      if (retireError) throw retireError;
    }
  }

  await setCurrentDealStepId(admin, dealId);
}

export async function backfillRail(admin: SupabaseClient): Promise<void> {
  const knownIds = new Set(
    [...railSeedRows(DEAL_RAIL), ...railSeedRows(MVP_DEAL_RAIL)].map((row) => row.stepId),
  );
  const { data: deals, error } = await admin.from('deals').select('id, code').order('code');
  if (error) throw error;

  for (const deal of (deals ?? []) as { id: string; code: string }[]) {
    const { data, error: stepsError } = await admin
      .from('deal_steps')
      .select('step_id, seq')
      .eq('deal_id', deal.id);
    if (stepsError) throw stepsError;

    const steps = (data ?? []) as StepRow[];
    const unknownIds = steps.map((step) => step.step_id).filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      console.log(`skipped ${deal.code}: ${unknownIds.join(',')} not in the catalogue`);
      continue;
    }
    if (steps.length === 0) {
      console.log(`skipped ${deal.code}: no step rows`);
      continue;
    }

    await applyDeal(admin, deal.id, planDeal(steps));
    console.log(`applied ${deal.code}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required');
  console.log(`target: ${url}`);

  await backfillRail(createClient(url, key, { auth: { persistSession: false } }));
}

if (process.argv[1]?.endsWith('backfill-project-rail.ts')) {
  void main();
}
