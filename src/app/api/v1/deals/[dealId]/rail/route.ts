import { NextResponse } from 'next/server';

import {
  classifyInternalUser,
  resolveDealStepStructureCapability,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { MVP_DEAL_RAIL } from '@/lib/rail/dealRail';

type RouteContext = { params: Promise<{ dealId: string }> };

type RemovedByUser = {
  id?: string | null;
  display_name?: string | null;
  full_name?: string | null;
  email?: string | null;
};

function actorName(user: RemovedByUser) {
  return user.display_name?.trim() || user.full_name?.trim() || user.email || 'Banker';
}

// `work_skip` reads only `work->skip`: the rest of a step's work never leaves
// the server. It proves a column-backed skip was verified (`skipApproverVerified`)
// and is the whole record of a skip logged before the database wrote the skip_*
// columns, which `completed_by_user` and `completed_at` serve (see `legacySkip`).
const RAIL_STEP_SELECT =
  'id, step_id, seq, status, census_version, phase_index, display_order, anchor_step_id, origin, definition, removed_at, removed_by, skipped_at, skipped_by, skip_approver_id, skip_reason, assigned_to, completed_at, work_skip:work->skip, removed_by_user:users!deal_steps_removed_by_fkey(id, display_name, full_name, email), skipped_by_user:users!deal_steps_skipped_by_fkey(id, display_name, full_name, email), skip_approver_user:users!deal_steps_skip_approver_id_fkey(id, display_name, full_name, email), completed_by_user:users!deal_steps_completed_by_fkey(id, display_name, full_name, email)';

// Proposed: caps for text a banker typed before the approver was verified.
const LEGACY_APPROVER_MAX = 120;
const LEGACY_REASON_MAX = 2000;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function cappedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function firstUser(raw: RemovedByUser | RemovedByUser[] | null | undefined) {
  return Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the database checked this skip's approver. Since #312 both skip paths
 * write `work.skip.approverId` equal to `skip_approver_id` after
 * rail_skip_approver accepts the approver. A rail-model skip written before that
 * has the columns but no `approverId`, and its approver was never checked.
 */
function skipApproverVerified(row: { work_skip?: unknown; skip_approver_id?: unknown }): boolean {
  const record = row.work_skip;
  return (
    isRecord(record) &&
    typeof record.approverId === 'string' &&
    typeof row.skip_approver_id === 'string' &&
    record.approverId.toLowerCase() === row.skip_approver_id.toLowerCase()
  );
}

/**
 * A skip logged before the database wrote the skip_* columns carries only
 * `work.skip`, whose approver is whatever the banker typed. It is shown as
 * recorded, never as a verified seat.
 */
function legacySkip(
  row: { status?: unknown; work_skip?: unknown; completed_at?: unknown },
  completedBy: RemovedByUser | null,
) {
  const record = row.work_skip;
  if (row.status !== 'skipped' || !isRecord(record)) return null;
  return {
    at: isoOrNull(record.at) ?? (typeof row.completed_at === 'string' ? row.completed_at : ''),
    by: completedBy ? actorName(completedBy) : 'Banker',
    approver: cappedText(record.approver, LEGACY_APPROVER_MAX),
    reason: cappedText(record.reason, LEGACY_REASON_MAX),
    approverVerified: false,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;
  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const canEditStructure = await resolveDealStepStructureCapability(auth.admin, auth.user.id);
  if (canEditStructure === 'unreadable') return jsonError('Permission lookup failed', 500);

  const { data: dealRow, error: dealError } = await auth.admin
    .from('deals')
    .select('current_deal_step_id, bank_id')
    .eq('id', deal.id)
    .single();
  if (dealError) return jsonError(dealError.message, 500);

  const canSaveTemplate = await hasCompanyPermissionChecked(
    auth.admin,
    auth.user.id,
    dealRow.bank_id as string,
    COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE,
  );
  if (canSaveTemplate === 'unreadable') return jsonError('Permission lookup failed', 500);

  const { data: rows, error } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select(RAIL_STEP_SELECT)
    .eq('deal_id', deal.id)
    .order('display_order', { ascending: true });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    currentStepId: dealRow.current_deal_step_id,
    canEditStructure,
    canSaveTemplate,
    phases: MVP_DEAL_RAIL.map((phase) => ({
      index: phase.index,
      name: phase.name,
      dealStatus: phase.dealStatus,
      roles: phase.roles,
      tools: phase.tools,
    })),
    steps: (rows ?? []).map((row) => {
      const rawRemovedByUser = row.removed_by_user as RemovedByUser | RemovedByUser[] | null;
      const removedByUser = Array.isArray(rawRemovedByUser)
        ? rawRemovedByUser[0] ?? null
        : rawRemovedByUser;
      const rawSkippedByUser = row.skipped_by_user as RemovedByUser | RemovedByUser[] | null;
      const skippedByUser = Array.isArray(rawSkippedByUser)
        ? rawSkippedByUser[0] ?? null
        : rawSkippedByUser;
      const rawSkipApproverUser = row.skip_approver_user as RemovedByUser | RemovedByUser[] | null;
      const skipApproverUser = Array.isArray(rawSkipApproverUser)
        ? rawSkipApproverUser[0] ?? null
        : rawSkipApproverUser;

      return {
        id: row.id,
        stepId: row.step_id,
        origin: row.origin,
        phaseIndex: row.phase_index,
        displayOrder: row.display_order,
        seq: row.seq,
        status: row.status,
        censusVersion: row.census_version,
        definition: row.definition,
        anchorStepId: row.anchor_step_id,
        removedAt: row.removed_at,
        removedBy: row.removed_at && row.removed_by
          ? {
              id: row.removed_by,
              name: removedByUser ? actorName(removedByUser) : 'Banker',
            }
          : null,
        assignedTo: row.assigned_to,
        skip: row.skipped_at
          ? {
              at: row.skipped_at,
              by: skippedByUser ? actorName(skippedByUser) : 'Banker',
              approver: skipApproverUser ? actorName(skipApproverUser) : 'Banker',
              reason: row.skip_reason,
              approverVerified: skipApproverVerified(row),
            }
          : legacySkip(
              row,
              firstUser(row.completed_by_user as RemovedByUser | RemovedByUser[] | null),
            ),
      };
    }),
  });
}
