import { NextResponse } from 'next/server';

import { firmMailAccess } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  DEFAULT_FIRM_COMPLIANCE_SETTINGS,
  FIRM_COMPLIANCE_SELECT,
  parseFirmComplianceSettings,
  settingsFromRow,
  type FirmComplianceSettings,
} from '@/lib/compliance/firmSettings';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { TABLE } from '@/lib/constants/tables';
import { notifyComplianceSettingsChanged } from '@/lib/notifications/mailReviewNotifications';

/**
 * The firm's CCO or admin, inside the research / trading wall (the same reach
 * as the mail review queue the settings shape), and whether they may change
 * them: only the CCO may (separation of duties; Martín's review of PR #640).
 * Anyone else: null.
 */
async function settingsReach(
  admin: Parameters<typeof firmMailAccess>[0],
  userId: string,
): Promise<{ tenantId: string; canEdit: boolean } | null> {
  const reach = await firmMailAccess(admin, userId);
  if (!reach.ok || !reach.tenantId) return null;
  if (reach.firmRole !== FIRM_ROLE.CCO && reach.firmRole !== FIRM_ROLE.ADMIN) return null;
  return { tenantId: reach.tenantId, canEdit: reach.firmRole === FIRM_ROLE.CCO };
}

/**
 * GET /api/v1/compliance-settings
 *
 * The firm's risk thresholds and send friction (Issue #94, Issue #95; D105).
 * `isDefault` is true when the firm never saved any, and the values are the
 * shipped defaults. `canEdit` is true for the CCO, false for an admin.
 */
export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const reach = await settingsReach(auth.admin, auth.user.id);
  if (!reach) return jsonError('Forbidden', 403);
  const { tenantId } = reach;

  const { data, error } = await auth.admin
    .from(TABLE.FIRM_COMPLIANCE_SETTINGS)
    .select(`${FIRM_COMPLIANCE_SELECT}, updated_at`)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    settings: settingsFromRow(data),
    isDefault: !data,
    updatedAt: data?.updated_at ?? null,
    canEdit: reach.canEdit,
  });
}

/**
 * PUT /api/v1/compliance-settings  { queuedFrom, sampledFrom, uncheckedFloor, sendFriction }
 *
 * Replaces the firm's settings, CCO only (an admin gets 403). The save and its
 * audit row (`update`, `kind: 'compliance_settings'`, before and after values)
 * are one transaction in firm_compliance_settings_save(): if either fails,
 * nothing is saved and the call answers 500. The firm's other CCOs and admins
 * are then notified. Applies to sends from the next one on; bands already stored are
 * not recomputed.
 */
export async function PUT(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const reach = await settingsReach(auth.admin, auth.user.id);
  if (!reach?.canEdit) return jsonError('Forbidden', 403);
  const { tenantId } = reach;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const next = parseFirmComplianceSettings(raw);
  if (typeof next === 'string') return jsonError(next, 400);

  const { data: previous, error } = await auth.admin.rpc('firm_compliance_settings_save', {
    p_tenant: tenantId,
    p_actor: auth.user.id,
    p_queued_from: next.queuedFrom,
    p_sampled_from: next.sampledFrom,
    p_unchecked_floor: next.uncheckedFloor,
    p_send_friction: next.sendFriction,
  });
  // The function rolled back: neither the settings nor the audit row were written.
  if (error) return jsonError(error.message, 500);

  await notifyComplianceSettingsChanged(auth.admin, {
    tenantId,
    actorId: auth.user.id,
    from: previousSettings(previous),
    to: next,
  });

  return NextResponse.json({ settings: next, isDefault: false, canEdit: true });
}

/** The values the save replaced, as firm_compliance_settings_save() returns them. */
function previousSettings(raw: unknown): FirmComplianceSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_FIRM_COMPLIANCE_SETTINGS;
  const row = raw as Record<string, unknown>;
  return settingsFromRow({
    queued_from: Number(row.queuedFrom),
    sampled_from: Number(row.sampledFrom),
    unchecked_floor: String(row.uncheckedFloor),
    send_friction: String(row.sendFriction),
  });
}
