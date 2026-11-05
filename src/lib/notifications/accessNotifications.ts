import type { SupabaseClient } from '@supabase/supabase-js';

import { NOTIFICATION_EVENT, type NotificationEvent } from '@/lib/constants/notifications';
import { dbFailure } from '@/lib/errors/upstream';

type InsertArgs = {
  tenantId: string;
  recipientId: string;
  eventType: NotificationEvent;
  payload: Record<string, unknown>;
};

export async function createAccessNotification(
  admin: SupabaseClient,
  args: InsertArgs,
): Promise<void> {
  const { error } = await admin.from('notifications').insert({
    tenant_id: args.tenantId,
    deal_id: null,
    recipient_id: args.recipientId,
    event_type: args.eventType,
    payload: args.payload,
  });
  if (error) throw dbFailure('Notification insert', error);
}

export async function notifyAccessRequested(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    approverIds: readonly string[];
    requesterName: string;
    destinationLabel: string;
    href: string;
    requestId: string;
    companyId: string;
  },
): Promise<void> {
  for (const recipientId of opts.approverIds) {
    await createAccessNotification(admin, {
      tenantId: opts.tenantId,
      recipientId,
      eventType: NOTIFICATION_EVENT.ACCESS_REQUESTED,
      payload: {
        actor: opts.requesterName,
        destinationLabel: opts.destinationLabel,
        href: opts.href,
        requestId: opts.requestId,
        companyId: opts.companyId,
      },
    });
  }
}

export async function notifyAccessDecision(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    recipientId: string;
    approved: boolean;
    actorName: string;
    destinationLabel: string;
    href: string;
  },
): Promise<void> {
  await createAccessNotification(admin, {
    tenantId: opts.tenantId,
    recipientId: opts.recipientId,
    eventType: opts.approved
      ? NOTIFICATION_EVENT.ACCESS_APPROVED
      : NOTIFICATION_EVENT.ACCESS_DENIED,
    payload: {
      actor: opts.actorName,
      destinationLabel: opts.destinationLabel,
      href: opts.href,
    },
  });
}
