import { NextResponse } from 'next/server';
import { firmMailAccess } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { errorCodeOf } from '@/lib/errors/upstream';
import { OUTBOX_STATUS } from '@/lib/constants/outbox';
import { defaultFromAddress, getEmailTransport } from '@/lib/email/transport';
import { requireFlag } from '@/lib/flags/requireFlag';
import { providerFailureCopy } from '../providerFailureCopy';

/**
 * PATCH /api/v1/outbox/{messageId} — the supervisory review verbs over a HELD
 * message. Overseer (CCO/admin) only — and never the message's own sender
 * (four-eyes, #165); the reviewer identity, timestamp and note are recorded
 * on the row.
 *
 *   release — the supervisor clears it: the message is sent NOW by the
 *             reviewer (audit 'release' + 'send'). Two deliberate deltas from
 *             the original send, both surfaced to the reviewer:
 *             - attachment bytes were never retained, so a release goes out
 *               without them and the response says so
 *               (releasedWithoutAttachments);
 *             - it goes out via the DEFAULT transport and platform from
 *               address, not the banker's connected mailbox — a release is
 *               the supervisor's send, never impersonation of the banker.
 *             Double-send safety: the row is atomically claimed
 *             (held -> pending) before the provider call; a concurrent or
 *             retried release finds no held row and 409s.
 *   reject  — returned to the sender with the note; status 'rejected',
 *             audit 'reject'. Never sent.
 */

type ReviewBody = { action?: unknown; note?: unknown };

type HeldRow = {
  id: string;
  status: string;
  sender_id: string;
  to_emails: string[];
  cc_emails: string[] | null;
  bcc_emails: string[] | null;
  subject: string;
  body: string;
  body_html: string | null;
  attachments: unknown;
  deal_id: string | null;
};

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ messageId: string }> },
) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const access = await firmMailAccess(auth.admin, auth.user.id);
  const overseer =
    access.firmRole === FIRM_ROLE.CCO || access.firmRole === FIRM_ROLE.ADMIN;
  if (!access.ok || !access.tenantId || !overseer) return jsonError('Forbidden', 403);

  let body: ReviewBody;
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const action = body.action;
  if (action !== 'release' && action !== 'reject') {
    return jsonError("action must be 'release' or 'reject'", 400);
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2_000) : null;

  const { messageId } = await ctx.params;
  const { data: rowData, error: loadError } = await auth.admin
    .from('outbound_messages')
    .select(
      'id, status, sender_id, to_emails, cc_emails, bcc_emails, subject, body, body_html, attachments, deal_id',
    )
    .eq('id', messageId)
    .eq('tenant_id', access.tenantId)
    .maybeSingle();
  if (loadError) return jsonError(`Message lookup failed (${errorCodeOf(loadError)})`, 500);
  if (!rowData) return jsonError('Message not found', 404);

  const row = rowData as unknown as HeldRow;
  if (row.status !== OUTBOX_STATUS.HELD) {
    return jsonError('Only a held message can be reviewed', 409);
  }
  // Four-eyes (#165): the sender never reviews their own held message —
  // without this, an overseer-sender's queue degrades to self-approval.
  if (row.sender_id === auth.user.id) {
    return jsonError('A held message cannot be reviewed by its sender', 403);
  }

  const reviewed = {
    reviewed_by: auth.user.id,
    reviewed_at: new Date().toISOString(),
    review_note: note,
  };

  if (action === 'reject') {
    const { data: updated, error } = await auth.admin
      .from('outbound_messages')
      .update({ status: OUTBOX_STATUS.REJECTED, ...reviewed })
      .eq('id', messageId)
      .select('id, status')
      .single();
    if (error) return jsonError(`Reject write failed (${errorCodeOf(error)})`, 500);

    const { error: rejectAuditError } = await auth.admin.from('audit_log').insert({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.REJECT,
      deal_id: row.deal_id,
      detail: { messageId, note },
    });
    if (rejectAuditError) {
      return jsonError(`Audit write failed (${errorCodeOf(rejectAuditError)})`, 500);
    }

    return NextResponse.json({ message: updated });
  }

  // release — the reviewer sends it now. Claim the row FIRST (held -> pending,
  // conditional on it still being held) so a concurrent or retried release
  // can never send twice: the loser of the race finds no held row.
  const { data: claimed, error: claimError } = await auth.admin
    .from('outbound_messages')
    .update({ status: OUTBOX_STATUS.PENDING, ...reviewed })
    .eq('id', messageId)
    .eq('status', OUTBOX_STATUS.HELD)
    .select('id')
    .maybeSingle();
  if (claimError) return jsonError(`Release claim failed (${errorCodeOf(claimError)})`, 500);
  if (!claimed) return jsonError('Only a held message can be reviewed', 409);

  const hadAttachments = Array.isArray(row.attachments) && row.attachments.length > 0;
  let providerReceipt: { id: string; provider: string; simulated?: boolean };
  try {
    providerReceipt = await getEmailTransport().send({
      from: defaultFromAddress(),
      to: row.to_emails,
      ...(row.cc_emails?.length ? { cc: row.cc_emails } : {}),
      ...(row.bcc_emails?.length ? { bcc: row.bcc_emails } : {}),
      subject: row.subject,
      text: row.body,
      ...(row.body_html ? { html: row.body_html } : {}),
    });
  } catch (err) {
    // Nothing left; return the claim so the reviewer can retry the release.
    await auth.admin
      .from('outbound_messages')
      .update({ status: OUTBOX_STATUS.HELD, reviewed_by: null, reviewed_at: null, review_note: null })
      .eq('id', messageId)
      .eq('status', OUTBOX_STATUS.PENDING);
    return jsonError(providerFailureCopy(err), 502);
  }

  const { data: updated, error } = await auth.admin
    .from('outbound_messages')
    .update({
      status: OUTBOX_STATUS.SENT,
      provider: providerReceipt.provider,
      provider_message_id: providerReceipt.id,
    })
    .eq('id', messageId)
    .select('id, status')
    .single();
  // Past the provider call a failure must be loud — the row stays 'pending'
  // (not re-releasable) as evidence of the in-flight send.
  if (error) {
    return jsonError(`Message sent but record update failed (${errorCodeOf(error)})`, 500);
  }

  const { error: releaseAuditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.RELEASE,
    deal_id: row.deal_id,
    detail: { messageId, note },
  });
  if (releaseAuditError) {
    return jsonError(`Message sent but audit write failed (${errorCodeOf(releaseAuditError)})`, 500);
  }
  const { error: sendAuditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.SEND,
    deal_id: row.deal_id,
    detail: {
      messageId,
      provider: providerReceipt.provider,
      providerMessageId: providerReceipt.id,
      recipients: row.to_emails.length,
      released: true,
      ...(providerReceipt.simulated ? { simulated: true } : {}),
    },
  });
  if (sendAuditError) {
    return jsonError(`Message sent but audit write failed (${errorCodeOf(sendAuditError)})`, 500);
  }

  return NextResponse.json({
    message: updated,
    ...(hadAttachments ? { releasedWithoutAttachments: true } : {}),
  });
}
