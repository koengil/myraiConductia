import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/v1/http';
import { ensureBoxEnvironmentRootFolder, getBoxClient } from '@/lib/box';
import { BOX_NAME_MAX_LENGTH, boxSafeName } from '@/lib/box/safeName';
import { DATAROOM_STEP_DEFS } from '@/lib/constants/dataroomSteps';
import { DATAROOM_PROVIDER } from '@/lib/constants/datarooms';
import { TABLE } from '@/lib/constants/tables';
import { dbFailure, errorCodeOf } from '@/lib/errors/upstream';
import { orderedSteps, type RailStep } from '@/lib/rail/dealRail';
import { manualStepDef } from '@/lib/rail/manualStepDefs';
import { getDataRoomStorage } from '@/lib/storage';

function railStepById(stepId: string): RailStep | undefined {
  return orderedSteps().find((s) => s.id === stepId);
}

// Deal codes are generated and short; the caps only keep the title room wide.
const DEAL_CODE_MAX_LENGTH = 120;
const STEP_TAG_MAX_LENGTH = 40;
const UUID_SUFFIX = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The step id as it appears in the folder name: the catalog id (`p2-s32`), or
 * the first eight hex digits of a custom step's uuid (`custom:<uuid>`).
 */
function stepFolderTag(stepId: string): string {
  const uuid = UUID_SUFFIX.exec(stepId);
  if (uuid) return uuid[1].toLowerCase();
  return boxSafeName(stepId, 'step', STEP_TAG_MAX_LENGTH);
}

/**
 * `{dealCode} — {title} ({step tag})`, safe for Box (#328). The step tag keeps
 * two steps whose titles sanitize alike ('A / B', 'A - B') out of one folder,
 * since createFolder reuses a folder on 409. Only the title is cut to fit.
 */
function stepFolderName(dealCode: string, title: string, stepId: string): string {
  const head = `${boxSafeName(dealCode, 'Deal', DEAL_CODE_MAX_LENGTH)} — `;
  const tail = ` (${stepFolderTag(stepId)})`;
  const room = BOX_NAME_MAX_LENGTH - head.length - tail.length;
  return `${head}${boxSafeName(title, 'Step', room)}${tail}`;
}

export type DataroomRow = {
  id: string;
  deal_id: string;
  step_id: string;
  provider: string;
  box_folder_id: string | null;
  box_folder_url: string | null;
  requires_upload: boolean;
  min_phase: number;
};

export type DealRef = { id: string; code: string };

/** Resolve a deal by UUID or human-readable code (D38 URL segment). */
export async function loadDealByIdOrCode(
  admin: SupabaseClient,
  idOrCode: string,
): Promise<DealRef | null> {
  const base = admin.from('deals').select('id, code');
  const { data, error } = await (isUuid(idOrCode)
    ? base.eq('id', idOrCode)
    : base.eq('code', idOrCode)
  ).maybeSingle();
  if (error) throw dbFailure('Deal lookup', error);
  if (!data?.id || !data?.code) return null;
  return { id: data.id as string, code: data.code as string };
}

export type StepWithDataroom = {
  stepId: string;
  label: string;
  seq: number | null;
  railStatus: string | null;
  requiresUpload: boolean;
  minPhase: number;
  dataroom: DataroomRow | null;
};

/** Insert Box dataroom rows for canonical rail steps on a deal. */
export async function seedDataroomsForDeal(
  admin: SupabaseClient,
  dealId: string,
): Promise<void> {
  for (const def of DATAROOM_STEP_DEFS) {
    const { data: existing } = await admin
      .from(TABLE.DATAROOMS)
      .select('id')
      .eq('deal_id', dealId)
      .eq('step_id', def.stepId)
      .maybeSingle();

    if (existing?.id) continue;

    const { error } = await admin.from(TABLE.DATAROOMS).insert({
      deal_id: dealId,
      step_id: def.stepId,
      provider: DATAROOM_PROVIDER.BOX,
      requires_upload: def.requiresUpload,
      min_phase: def.minPhase,
    });
    if (error) throw dbFailure('Dataroom seed', error);
  }
}

export async function listDealStepsWithDatarooms(
  admin: SupabaseClient,
  dealId: string,
): Promise<StepWithDataroom[]> {
  const { data: datarooms, error: dataroomsError } = await admin
    .from(TABLE.DATAROOMS)
    .select(
      'id, deal_id, step_id, provider, box_folder_id, box_folder_url, requires_upload, min_phase',
    )
    .eq('deal_id', dealId)
    .order('step_id', { ascending: true });
  if (dataroomsError) throw dbFailure('Dataroom lookup', dataroomsError);

  const { data: railSteps, error: railError } = await admin
    .from(TABLE.DEAL_STEPS)
    .select('step_id, seq, status')
    .eq('deal_id', dealId);
  if (railError) throw dbFailure('Dataroom rail lookup', railError);

  const railByStepId = new Map(
    (railSteps ?? []).map((s) => [
      s.step_id as string,
      { seq: s.seq as number, status: s.status as string },
    ]),
  );

  return (datarooms ?? []).map((row) => {
    const stepId = row.step_id as string;
    const rail = railByStepId.get(stepId);
    const censusStep = railStepById(stepId);
    return {
      stepId,
      label: censusStep?.title ?? stepId,
      seq: rail?.seq ?? censusStep?.seq ?? null,
      railStatus: rail?.status ?? null,
      requiresUpload: row.requires_upload as boolean,
      minPhase: row.min_phase as number,
      dataroom: row as DataroomRow,
    };
  });
}

/**
 * Whether the step's dataroom holds at least one document. Read by the
 * completion gate for `uploadRequired` steps: the artifact is the step's
 * output, so the step is not done until the file is filed. Does not provision
 * a folder — a step with no dataroom row has no upload by definition.
 */
export async function stepHasUpload(
  admin: SupabaseClient,
  dealId: string,
  stepId: string,
): Promise<boolean> {
  const { data: dataroom, error: dataroomError } = await admin
    .from(TABLE.DATAROOMS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('step_id', stepId)
    .maybeSingle();
  if (dataroomError) throw dbFailure('Dataroom lookup', dataroomError);
  if (!dataroom?.id) return false;

  const { count, error } = await admin
    .from(TABLE.DOCUMENTS)
    .select('id', { head: true, count: 'exact' })
    .eq('dataroom_id', dataroom.id as string);
  if (error) throw dbFailure('Dataroom lookup', error);
  return (count ?? 0) > 0;
}

/** Ensure the Box folder exists for a rail step's dataroom row. */
export async function provisionDataroomFolder(
  admin: SupabaseClient,
  dealId: string,
  stepId: string,
  dealCode: string,
  stepTitle?: string,
): Promise<DataroomRow> {
  const DATAROOM_SELECT =
    'id, deal_id, step_id, provider, box_folder_id, box_folder_url, requires_upload, min_phase';

  const { data: existing, error: dataroomError } = await admin
    .from(TABLE.DATAROOMS)
    .select(DATAROOM_SELECT)
    .eq('deal_id', dealId)
    .eq('step_id', stepId)
    .maybeSingle();
  if (dataroomError) throw dbFailure('Dataroom lookup', dataroomError);

  const censusStep = railStepById(stepId);
  const title = censusStep?.title ?? stepTitle;
  if (!title) throw new Error(`Unknown rail step: ${stepId}`);

  const dataroom =
    existing ??
    (await (async () => {
      const { data, error } = await admin
        .from(TABLE.DATAROOMS)
        .insert({
          deal_id: dealId,
          step_id: stepId,
          provider: DATAROOM_PROVIDER.BOX,
          requires_upload: manualStepDef(stepId)?.requiresUpload ?? false,
          min_phase: 0,
        })
        .select(DATAROOM_SELECT)
        .single();
      if (data) return data;

      if ((error as { code?: string } | null)?.code === '23505') {
        const { data: winner } = await admin
          .from(TABLE.DATAROOMS)
          .select(DATAROOM_SELECT)
          .eq('deal_id', dealId)
          .eq('step_id', stepId)
          .maybeSingle();
        if (winner) return winner;
      }

      throw error ? dbFailure('Dataroom create', error) : new Error(`Could not open a dataroom for step: ${stepId}`);
    })());

  if (dataroom.box_folder_id) {
    return dataroom as DataroomRow;
  }

  const box = getBoxClient();
  const parentId = await ensureBoxEnvironmentRootFolder(box);
  // Census titles can carry a '/' (p2-s32), which Box refuses (#328).
  const folderName = stepFolderName(dealCode, title, stepId);
  const folder = await box.createFolder(folderName, parentId);

  const { data: updated, error: updateError } = await admin
    .from(TABLE.DATAROOMS)
    .update({
      box_folder_id: folder.id,
      box_folder_url: folder.url,
    })
    .eq('id', dataroom.id)
    .select(
      'id, deal_id, step_id, provider, box_folder_id, box_folder_url, requires_upload, min_phase',
    )
    .single();
  if (updateError || !updated) {
    throw updateError ? dbFailure('Dataroom folder save', updateError) : new Error('Failed to persist dataroom folder');
  }

  return updated as DataroomRow;
}

export type DealDataroomStatus = 'ready' | 'pending';

async function setDataroomPending(
  admin: SupabaseClient,
  dealId: string,
  pending: boolean,
): Promise<boolean> {
  const update = admin
    .from(TABLE.DEALS)
    .update({ dataroom_pending_since: pending ? new Date().toISOString() : null })
    .eq('id', dealId);
  const { error } = await (pending
    ? update.is('dataroom_pending_since', null)
    : update.not('dataroom_pending_since', 'is', null));
  if (error) console.error('dataroom pending state not saved', { dealId, code: errorCodeOf(error) });
  return !error;
}

/**
 * Seed dataroom rows and provision Box folders when a deal is created, and
 * again on a retry. A failure is recorded on the deal (`dataroom_pending_since`)
 * instead of thrown; a success clears it.
 */
export async function provisionDealDataroomOnCreate(
  admin: SupabaseClient,
  dealId: string,
  dealCode: string,
): Promise<DealDataroomStatus> {
  try {
    await seedDataroomsForDeal(admin, dealId);
    for (const def of DATAROOM_STEP_DEFS) {
      await provisionDataroomFolder(admin, dealId, def.stepId, dealCode);
    }
    await getDataRoomStorage().ensureDealFolders(dealCode);
  } catch (err) {
    console.error('dataroom provision failed', { dealId, code: errorCodeOf(err) });
    await setDataroomPending(admin, dealId, true);
    return 'pending';
  }
  return (await setDataroomPending(admin, dealId, false)) ? 'ready' : 'pending';
}

export async function dealDataroomStatus(
  admin: SupabaseClient,
  dealId: string,
): Promise<DealDataroomStatus> {
  const { data, error } = await admin
    .from(TABLE.DEALS)
    .select('dataroom_pending_since')
    .eq('id', dealId)
    .maybeSingle();
  if (error) throw dbFailure('Dataroom status lookup', error);
  return data?.dataroom_pending_since ? 'pending' : 'ready';
}
