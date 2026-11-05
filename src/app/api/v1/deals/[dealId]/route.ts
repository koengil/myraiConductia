import { NextResponse } from 'next/server';
import { userCanAccessDeal, userIsDealMd } from '@/lib/api/v1/access';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import {
  CATEGORY_DRIVEN_STATUS,
  DEAL_STATUS,
  LIFECYCLE_CATEGORIES,
  SCHEDULE_STATUSES,
  type LifecycleCategory,
  type ScheduleStatus,
} from '@/lib/constants/deals';
import { checkFeeUsd, checkTargetCloseDate } from '@/lib/validation/inputPolicy';

type RouteContext = { params: Promise<{ dealId: string }> };

// The route segment is the deal CODE (e.g. SUM-2026-014) after the URL-scheme
// cutover (G14), but a UUID still resolves for back-compat and internal callers.
// COMPLIANCE: the segment is always the code or a fixture code name — never the
// target company name (the mask holds in every URL).
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  // Resolve the canonical row by primary key OR by human-readable code first, so
  // access is then checked against the real UUID.
  const base = auth.admin
    .from('deals')
    .select(
      'id, code, codename, status, mandate_owner_id, bank_id, created_at, entry_step_seq, current_step_seq, conflicts_approved_by, conflicts_approved_on, target_close_date, fee_usd, schedule_status, lifecycle_category',
    );
  const { data: deal, error: dealError } = await (isUuid(dealId)
    ? base.eq('id', dealId)
    : base.eq('code', dealId)
  ).maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();

  const { data: parties, error: partiesError } = await auth.admin
    .from('deal_parties')
    .select('party_role, company:companies(id, name, type)')
    .eq('deal_id', deal.id);
  if (partiesError) return jsonError(partiesError.message, 500);

  const { data: members, error: membersError } = await auth.admin
    .from('deal_memberships')
    // deal_memberships has two FKs to users (user_id + added_by); disambiguate
    // the embed by the user_id constraint name.
    .select(
      'deal_role, phase, user:users!deal_memberships_user_id_fkey(id, email, full_name, display_name)',
    )
    .eq('deal_id', deal.id);
  if (membersError) return jsonError(membersError.message, 500);

  const { data: gate0NotificationRows, error: gate0NotifyError } = await auth.admin
    .from('notifications')
    .select(
      'created_at, payload, recipient:users!notifications_recipient_id_fkey(full_name, display_name, firm_role)',
    )
    .eq('deal_id', deal.id)
    .eq('event_type', 'deal_created')
    .order('created_at', { ascending: true });
  if (gate0NotifyError) return jsonError(gate0NotifyError.message, 500);

  type NotifyRecipient = {
    full_name: string | null;
    display_name: string | null;
    firm_role: string | null;
  };

  const gate0Notifications = (gate0NotificationRows ?? []).map((row) => {
    const raw = row.recipient as NotifyRecipient | NotifyRecipient[] | null;
    const recipient = Array.isArray(raw) ? (raw[0] ?? null) : raw;
    return {
      at: row.created_at as string,
      recipientName:
        recipient?.display_name?.trim() ||
        recipient?.full_name?.trim() ||
        'Compliance officer',
      recipientRole: recipient?.firm_role ?? null,
      payload: row.payload as Record<string, unknown>,
    };
  });

  return NextResponse.json({
    // The raw row plus the three graduated Book fields in the API's camelCase.
    deal: { ...deal, ...bookFields(deal) },
    parties: parties ?? [],
    members: members ?? [],
    gate0Notifications,
  });
}

/** The four graduated Book fields (#191) in the API's camelCase, beside the raw row. */
function bookFields(row: Record<string, unknown>) {
  return {
    targetCloseDate: (row.target_close_date as string | null) ?? null,
    feeUsd: row.fee_usd == null ? null : Number(row.fee_usd),
    scheduleStatus: (row.schedule_status as ScheduleStatus | null) ?? null,
    lifecycleCategory: (row.lifecycle_category as LifecycleCategory | null) ?? 'live',
  };
}

type BookColumn = 'target_close_date' | 'fee_usd' | 'schedule_status' | 'lifecycle_category';

/**
 * Validate one Book field from the PATCH body. Returns the column + value to
 * write, or an error message. Close date, fee and schedule are nullable
 * (`null` withdraws them); the lifecycle category never is.
 */
function parseBookField(
  key: 'targetCloseDate' | 'feeUsd' | 'scheduleStatus' | 'lifecycleCategory',
  value: unknown,
): { column: BookColumn; value: string | number | null } | { error: string } {
  if (key === 'lifecycleCategory') {
    // NOT NULL in the schema: a deal is always somewhere in the Book.
    if (typeof value !== 'string' || !LIFECYCLE_CATEGORIES.includes(value as LifecycleCategory)) {
      return { error: 'Select a lifecycle category from the list.' };
    }
    return { column: 'lifecycle_category', value };
  }
  if (key === 'targetCloseDate') {
    const closeDate = checkTargetCloseDate(value);
    if (!closeDate.ok) return { error: closeDate.message };
    return { column: 'target_close_date', value: closeDate.value };
  }
  if (key === 'feeUsd') {
    const fee = checkFeeUsd(value);
    if (!fee.ok) return { error: fee.message };
    return { column: 'fee_usd', value: fee.value };
  }
  if (value !== null && (typeof value !== 'string' || !SCHEDULE_STATUSES.includes(value as ScheduleStatus))) {
    return { error: 'Select a schedule status from the list, or clear it.' };
  }
  return { column: 'schedule_status', value };
}

const BOOK_FIELD_KEYS = ['targetCloseDate', 'feeUsd', 'scheduleStatus', 'lifecycleCategory'] as const;

/**
 * Update the deal's graduated Book fields (#191): target close date, fee,
 * schedule status and lifecycle category. Each is the MD's call: MD (or
 * admin) only, any member is 403. Send any subset; `null` withdraws a
 * nullable field (the category is never null). Every changed field is
 * audited as its own 'update' row with { field, from, to }, so the Book's
 * columns are a record, not a guess. The segment is the deal CODE or UUID (G14).
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object') return jsonError('Invalid JSON body', 400);

  const writes: Array<{ column: BookColumn; value: string | number | null }> = [];
  for (const key of BOOK_FIELD_KEYS) {
    if (!(key in body)) continue;
    const parsed = parseBookField(key, body[key]);
    if ('error' in parsed) return jsonError(parsed.error, 400);
    writes.push(parsed);
  }
  if (writes.length === 0) {
    return jsonError('Set a close date, fee, schedule status or lifecycle category to save.', 400);
  }

  const base = auth.admin.from('deals').select('id, code, status, target_close_date, fee_usd, schedule_status, lifecycle_category');
  const { data: deal, error: dealError } = await (isUuid(dealId)
    ? base.eq('id', dealId)
    : base.eq('code', dealId)
  ).maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const isMember = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!isMember) return dealNotVisible();
  const isMd = await userIsDealMd(auth.admin, auth.user.id, deal.id);
  if (!isMd) return jsonError('Only the deal MD can set the Book fields', 403);

  const before = deal as Record<string, unknown>;
  const patch: Partial<Record<BookColumn | 'status', string | number | null>> = {};
  for (const w of writes) patch[w.column] = w.value;

  // Storm's ruling: the Book category drives the working status (Closed,
  // Terminated and Lost end the work; Mandate hold pauses it; moving back to
  // Live reactivates a paused or closed deal). An intake deal is never
  // advanced by a category save, and pitch/prospect carry no ruling.
  const categoryWrite = writes.find((w) => w.column === 'lifecycle_category');
  let statusChange: { from: string | null; to: string } | null = null;
  if (categoryWrite && typeof categoryWrite.value === 'string') {
    const driven = CATEGORY_DRIVEN_STATUS[categoryWrite.value as LifecycleCategory];
    const current = typeof before.status === 'string' ? before.status : null;
    // An intake deal is never touched by a category save, in either
    // direction: Storm's ruling is about live deals, and entry out of
    // intake belongs to the rail (its cursor leaving phase 1), not to the Book.
    const intake = current === DEAL_STATUS.INTAKE || current == null;
    const reactivating = driven === DEAL_STATUS.ACTIVE;
    const eligible =
      !intake &&
      (reactivating
        ? current === DEAL_STATUS.PAUSED || current === DEAL_STATUS.CLOSED
        : driven != null && current !== driven);
    if (driven && eligible) {
      patch.status = driven;
      statusChange = { from: current, to: driven };
    }
  }

  const { data: updated, error: updateError } = await auth.admin
    .from('deals')
    .update(patch)
    .eq('id', deal.id)
    .select('id, code, target_close_date, fee_usd, schedule_status, lifecycle_category')
    .single();
  if (updateError) {
    // Reactivating to Live re-enters the active-codename unique index; if
    // another deal claimed the code name while this one was parked, answer
    // in banker vocabulary, mirroring the create path.
    if ((updateError as { code?: string }).code === '23505') {
      return jsonError('Code name is already in use on a live deal', 409);
    }
    return jsonError(updateError.message, 500);
  }

  // One audit row per field written, even when the value is unchanged: the
  // MD's act of setting it is the record. A single batched insert so the
  // trail is all-or-nothing for this request, never partial.
  type AuditField = BookColumn | 'status';
  const auditRows: Array<{
    actor_id: string;
    action: string;
    deal_id: string;
    detail: { field: AuditField; from: unknown; to: unknown };
  }> = writes.map((w) => ({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.UPDATE,
    deal_id: deal.id,
    detail: {
      field: w.column,
      from: before[w.column] == null ? null : w.column === 'fee_usd' ? Number(before[w.column]) : before[w.column],
      to: w.value,
    },
  }));
  if (statusChange) {
    auditRows.push({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.UPDATE,
      deal_id: deal.id,
      detail: { field: 'status', from: statusChange.from, to: statusChange.to },
    });
  }
  const { error: auditError } = await auth.admin.from('audit_log').insert(auditRows);
  if (auditError) return jsonError(`Updated but audit write failed: ${auditError.message}`, 500);

  return NextResponse.json({
    deal: { code: updated.code, ...bookFields(updated as Record<string, unknown>) },
  });
}
