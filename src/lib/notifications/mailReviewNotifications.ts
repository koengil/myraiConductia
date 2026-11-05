import type { SupabaseClient } from '@supabase/supabase-js';

import type { FirmComplianceSettings } from '@/lib/compliance/firmSettings';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { errorCodeOf } from '@/lib/errors/upstream';

/**
 * A Queued send went out (Issue #94): each of the firm's active internal CCOs
 * and admins, other than the sender, gets one bell notification pointing at
 * the review queue. Content-free: the sender's name, never the subject or the
 * reasons (the queue shows those to whoever may read them). Never throws: the
 * message has already left, and the queue holds it whether or not the bell rang.
 */
export async function notifyQueuedSend(
  admin: SupabaseClient,
  opts: { tenantId: string; senderId: string; messageId: string; dealId: string | null },
): Promise<void> {
  try {
    const { data: people, error } = await admin
      .from('users')
      .select('id')
      .eq('tenant_id', opts.tenantId)
      .in('firm_role', [FIRM_ROLE.CCO, FIRM_ROLE.ADMIN])
      .eq('status', 'active')
      .eq('is_external', false);
    if (error) {
      console.error('[outbox] queued-send notification: reviewers unavailable', errorCodeOf(error));
      return;
    }
    const reviewers = (people ?? []).filter((p) => p.id !== opts.senderId);
    if (!reviewers.length) return;

    const { data: sender } = await admin
      .from('users')
      .select('display_name, full_name, email')
      .eq('id', opts.senderId)
      .maybeSingle();
    const name =
      [sender?.display_name, sender?.full_name, sender?.email]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .find(Boolean) ?? 'A banker';

    const { error: insertError } = await admin.from('notifications').insert(
      reviewers.map((r) => ({
        tenant_id: opts.tenantId,
        deal_id: opts.dealId,
        recipient_id: r.id,
        event_type: NOTIFICATION_EVENT.MAIL_QUEUED_FOR_REVIEW,
        payload: {
          destinationLabel: `${name}: a sent email is queued for your review`,
          ...(opts.dealId ? { href: `/projects/${opts.dealId}/mail?folder=held` } : {}),
          messageId: opts.messageId,
        },
      })),
    );
    if (insertError) console.error('[outbox] queued-send notification failed', errorCodeOf(insertError));
  } catch (error) {
    console.error('[outbox] queued-send notification failed', errorCodeOf(error));
  }
}

/**
 * The firm's compliance settings changed (D105; Martín's review of PR #640):
 * each of the firm's other active internal CCOs and admins gets one bell
 * notification naming who changed them and the before and after values. The
 * admins are included so a firm with a single CCO still has a second pair of
 * eyes on the change. The settings are already saved and audited, so this
 * never throws.
 */
export async function notifyComplianceSettingsChanged(
  admin: SupabaseClient,
  opts: { tenantId: string; actorId: string; from: FirmComplianceSettings; to: FirmComplianceSettings },
): Promise<void> {
  try {
    const { data: people, error } = await admin
      .from('users')
      .select('id')
      .eq('tenant_id', opts.tenantId)
      .in('firm_role', [FIRM_ROLE.CCO, FIRM_ROLE.ADMIN])
      .eq('status', 'active')
      .eq('is_external', false);
    if (error) {
      console.error('[compliance-settings] change notification: reviewers unavailable', errorCodeOf(error));
      return;
    }
    const reviewers = (people ?? []).filter((p) => p.id !== opts.actorId);
    if (!reviewers.length) return;

    const { data: actor } = await admin
      .from('users')
      .select('display_name, full_name, email')
      .eq('id', opts.actorId)
      .maybeSingle();
    const name =
      [actor?.display_name, actor?.full_name, actor?.email]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .find(Boolean) ?? 'A CCO';

    const { error: insertError } = await admin.from('notifications').insert(
      reviewers.map((c) => ({
        tenant_id: opts.tenantId,
        deal_id: null,
        recipient_id: c.id,
        event_type: NOTIFICATION_EVENT.COMPLIANCE_SETTINGS_CHANGED,
        payload: {
          destinationLabel: `${name} changed the firm's compliance settings`,
          from: opts.from,
          to: opts.to,
        },
      })),
    );
    if (insertError) console.error('[compliance-settings] change notification failed', errorCodeOf(insertError));
  } catch (error) {
    console.error('[compliance-settings] change notification failed', errorCodeOf(error));
  }
}
