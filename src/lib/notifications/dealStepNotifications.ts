import type { SupabaseClient } from '@supabase/supabase-js';

import { AUDIT_ACTION } from '@/lib/constants/audit';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';
import { dbFailure } from '@/lib/errors/upstream';

type NotifyArgs = {
  tenantId: string;
  dealId: string;
  actorId: string;
  recipientId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

/** Insert a deal-scoped notification and mirror it in audit_log (Gate 0 pattern). */
export async function createDealNotification(
  admin: SupabaseClient,
  args: NotifyArgs,
): Promise<void> {
  const { error: notifyError } = await admin.from('notifications').insert({
    tenant_id: args.tenantId,
    deal_id: args.dealId,
    recipient_id: args.recipientId,
    event_type: args.eventType,
    payload: args.payload,
  });
  if (notifyError) throw dbFailure('Notification insert', notifyError);

  const { error: auditError } = await admin.from('audit_log').insert({
    actor_id: args.actorId,
    action: AUDIT_ACTION.NOTIFY,
    deal_id: args.dealId,
    detail: { recipient: args.recipientId, event: args.eventType },
  });
  if (auditError) throw dbFailure('Notification audit', auditError);
}

export async function notifyStepAssigned(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    dealId: string;
    actorId: string;
    assigneeId: string;
    dealCode: string;
    codename: string;
    stepId: string;
    stepTitle: string;
    actorName: string;
  },
): Promise<void> {
  await createDealNotification(admin, {
    tenantId: opts.tenantId,
    dealId: opts.dealId,
    actorId: opts.actorId,
    recipientId: opts.assigneeId,
    eventType: NOTIFICATION_EVENT.STEP_ASSIGNED,
    payload: {
      code: opts.dealCode,
      codename: opts.codename,
      stepId: opts.stepId,
      stepTitle: opts.stepTitle,
      actor: opts.actorName,
    },
  });
}

export async function notifyStepCompleted(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    dealId: string;
    actorId: string;
    recipientId: string;
    dealCode: string;
    codename: string;
    stepId: string;
    stepTitle: string;
    completedBy: string;
  },
): Promise<void> {
  await createDealNotification(admin, {
    tenantId: opts.tenantId,
    dealId: opts.dealId,
    actorId: opts.actorId,
    recipientId: opts.recipientId,
    eventType: NOTIFICATION_EVENT.STEP_COMPLETED,
    payload: {
      code: opts.dealCode,
      codename: opts.codename,
      stepId: opts.stepId,
      stepTitle: opts.stepTitle,
      completedBy: opts.completedBy,
    },
  });
}
