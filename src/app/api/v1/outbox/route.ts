import { loadRecipientReview, RecipientPolicyError } from '@/lib/api/v1/recipientReview';
import { mintRecipientToken, verifyRecipientToken } from '@/lib/compliance/recipientToken';
import { becomesKnownRecipient } from '@/lib/mail/recipientReview';
import { loadMailDomainPolicy } from '@/lib/api/v1/mailDomainPolicy';
import { recipientBoundary, type RecipientBoundary } from '@/lib/mail/recipientBoundary';
import { recordAiUsage } from '@/lib/ai/usage';
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { resolveDealRefLenient, type LenientDealRef } from '@/lib/api/v1/dealRef';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { errorCodeOf } from '@/lib/errors/upstream';
import { OUTBOX_STATUS, OUTBOX_STATUSES, type OutboxStatus } from '@/lib/constants/outbox';
import { RISK_BAND, RISK_BANDS, type RiskBand } from '@/lib/constants/outbox';
import { riskBandFor } from '@/lib/compliance/riskBand';
import { loadFirmComplianceSettings, SEND_FRICTION, type FirmComplianceSettings } from '@/lib/compliance/firmSettings';
import { notifyQueuedSend } from '@/lib/notifications/mailReviewNotifications';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { fullScreenFields } from '@/lib/compliance/llm';
import { modelCallsAllowed, modelDecisionRecord } from '@/lib/ai/modelPolicy';
import { jevCallAllowed } from '@/lib/compliance/secondOpinion';
import { readAttachments, withUnreadAttachments } from '@/lib/compliance/attachmentScreen';
import {
  SCREEN_TOKEN_KEY_MISSING,
  hasScreenTokenKey,
  mintScreenToken,
  screenTokenRecord,
  screenedFromToken,
  verifyScreenToken,
} from '@/lib/compliance/screenToken';
import { lexiconAuditFields } from '@/lib/compliance/lexicon';
import { MAILBOX_UNAVAILABLE_COPY } from '@/lib/constants/mailboxSend';
import { connectedSendRefusal, envelopeSha, sendAsConnectedUser, sendingIdentity } from '@/lib/email/connectedSender';
import { verifyReplyToken } from '@/lib/email/replyToken';
import { defaultFromAddress, getEmailTransport, type MessageInput } from '@/lib/email/transport';
import { requireFlag } from '@/lib/flags/requireFlag';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import { LIFECYCLE_CATEGORIES, type LifecycleCategory } from '@/lib/constants/deals';
import { confidentialSubject, requiresConfidential } from '@/lib/mail/confidential';
import { toPlainText } from '@/lib/mail/format';
import { providerFailureCopy } from './providerFailureCopy';

/**
 * /api/v1/outbox — the send path of the compliance email client. Nothing
 * leaves the platform channel unscreened: every POST runs the full (mode
 * "full") screen first. Since #192 (written decision, Aug 24) NOTHING blocks
 * or holds a send — MNPI included; risk is reduced through traceability:
 *
 *   compliant    -> handed to the EmailTransport provider; row status 'sent'.
 *   risk issues  -> (any hold or blocked read) nothing stored, nothing sent —
 *                   a 200 returns the issues to the SENDER (reasons, the AI's
 *                   minimal-fix rewrite, ephemeral heat, a binding token):
 *                   the Risk Patcher. Their choices: use the AI's draft,
 *                   edit, or send as-is (token-bound). Every choice sends;
 *                   every choice is audited. The screen audit records the
 *                   control fired either way.
 *
 * 'held' and 'blocked' rows are no longer produced here; legacy rows keep
 * their review flow ([messageId] PATCH). Sender sign-offs (#164 option A)
 * still clear their own promissory terms before the screen.
 *
 * The full message is stored in outbound_messages (a business communication is
 * a required record — SEC 17a-4 / FINRA 4511; a held message must be readable
 * to be reviewed). audit_log carries the events: 'screen' always, 'send' only
 * when a message actually left.
 */

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 1_000;
const MAX_BODY = 50_000;
const MAX_HTML = 200_000;
const MAX_ATTACHMENTS = 5;
// Base64 chars across all attachments (~3MB of bytes) — keeps the request
// under the platform body limit with headroom.
const MAX_ATTACHMENT_B64 = 4_000_000;

/** A deal id that matches no row: the GET filter for a deal the caller cannot see. */
const NO_SUCH_DEAL = '00000000-0000-0000-0000-000000000000';

const MESSAGE_SELECT =
  'id, deal_id, recipient_boundary, status, verdict, reasons, rewrite, llm_checked, risk_band, provider, provider_message_id, ' +
  'to_emails, cc_emails, bcc_emails, subject, body, body_html, attachments, review_note, reviewed_at, created_at';

type MessageRow = {
  id: string;
  deal_id: string | null;
  recipient_boundary: RecipientBoundary | null;
  // Present only on GET reads, via the deals(code) embed.
  deal?: { code: string } | null;
  status: string;
  verdict: string;
  reasons: unknown;
  rewrite: string | null;
  llm_checked: boolean;
  risk_band: string | null;
  provider: string | null;
  provider_message_id: string | null;
  to_emails: string[];
  cc_emails: string[] | null;
  bcc_emails: string[] | null;
  subject: string;
  body: string;
  body_html: string | null;
  attachments: unknown;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
};

function toApiMessage(row: MessageRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    recipientBoundary: row.recipient_boundary ?? null,
    dealCode: row.deal?.code ?? null,
    status: row.status,
    verdict: row.verdict,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    rewrite: row.rewrite,
    llmChecked: row.llm_checked,
    riskBand: row.risk_band,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    to: row.to_emails,
    cc: row.cc_emails ?? [],
    bcc: row.bcc_emails ?? [],
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

type OutboxPostBody = {
  dealId?: unknown;
  preApproved?: unknown;
  /** Risk Patcher (#192): send despite reported risk issues. `overrideReputational`
   *  is the pre-#192 name, accepted as an alias. */
  sendAsIs?: unknown;
  overrideReputational?: unknown;
  overrideToken?: unknown;
  recipientApprovalToken?: unknown;
  /** Send friction (Issue #95): the sender confirmed a send outside the firm. */
  externalConfirmed?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
  html?: unknown;
  attachments?: unknown;
  /** A reply (#339): the token the Deal email thread route signed with the reply's threading headers. */
  replyToken?: unknown;
  /** Idempotency key: one per logical send, reused on retry (see priorSend). */
  clientRequestId?: unknown;
};

const CLIENT_REQUEST_ID_RX = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Send idempotency: a clientRequestId already claimed by this sender (its
 * row exists) is never sent again. A sent row replays the original 201; a
 * row still pending is an in-flight or unconfirmed send, so 409. null = the
 * id is unclaimed and the send may proceed.
 */
async function priorSend(
  admin: Parameters<typeof userCanAccessDeal>[0],
  senderId: string,
  clientRequestId: string,
): Promise<NextResponse | null> {
  const { data, error } = await admin
    .from('outbound_messages')
    .select(MESSAGE_SELECT)
    .eq('sender_id', senderId)
    .eq('client_request_id', clientRequestId)
    .maybeSingle();
  if (error) return jsonError(`Outbox read failed (${errorCodeOf(error)})`, 500);
  if (!data) return null;
  const prior = data as unknown as MessageRow;
  if (prior.status === OUTBOX_STATUS.SENT) {
    return NextResponse.json(
      { message: toApiMessage(prior) },
      { status: 201, headers: { 'Idempotent-Replayed': 'true' } },
    );
  }
  return jsonError('This message is already being sent. Check Sent before sending it again.', 409);
}

/** Parse an optional email list field; null = invalid. */
function emailList(value: unknown, max: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const list = value.filter((t): t is string => typeof t === 'string');
  if (list.length !== value.length || list.length > max) return null;
  if (list.some((t) => !EMAIL_RX.test(t))) return null;
  return list;
}

// The LLM screen may legitimately take >15s on hard judgments (llm.ts
// TIMEOUT_MS 25s) — without this the platform default kills the request
// mid-screen instead of degrading visibly.
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let raw: OutboxPostBody;
  try {
    raw = (await request.json()) as OutboxPostBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  // Missing = the pre-idempotency behaviour (older clients); malformed = 400.
  let clientRequestId: string | null = null;
  if (raw.clientRequestId !== undefined && raw.clientRequestId !== null) {
    if (typeof raw.clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RX.test(raw.clientRequestId)) {
      return jsonError('clientRequestId must be 8-128 letters, digits or _.:-', 400);
    }
    clientRequestId = raw.clientRequestId;
    // A retry of a claimed send answers before any screen or AI spend.
    const prior = await priorSend(auth.admin, auth.user.id, clientRequestId);
    if (prior) return prior;
  }

  const to = Array.isArray(raw.to)
    ? raw.to.filter((t): t is string => typeof t === 'string')
    : [];
  if (to.length === 0 || to.length > MAX_RECIPIENTS) {
    return jsonError('to must list 1-20 recipient emails', 400);
  }
  if (to.some((t) => !EMAIL_RX.test(t))) {
    return jsonError('to contains an invalid email address', 400);
  }

  let subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!subject || subject.length > MAX_SUBJECT) {
    return jsonError('subject is required', 400);
  }

  const messageBody = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!messageBody || messageBody.length > MAX_BODY) {
    return jsonError('body is required', 400);
  }

  const cc = emailList(raw.cc, MAX_RECIPIENTS);
  if (!cc) return jsonError('cc contains an invalid email address', 400);
  const bcc = emailList(raw.bcc, MAX_RECIPIENTS);
  if (!bcc) return jsonError('bcc contains an invalid email address', 400);

  // A reply (#339) carries the token the thread route signed, never header text:
  // In-Reply-To and References are the stored ids of a thread the caller read.
  const replyToken = raw.replyToken;
  if (replyToken !== undefined && (typeof replyToken !== 'string' || typeof raw.dealId !== 'string' || !raw.dealId.trim())) {
    return jsonError('a reply needs its replyToken and dealId', 400);
  }
  const reply =
    replyToken === undefined ? null : verifyReplyToken(replyToken, { actorId: auth.user.id, dealCode: raw.dealId as string });
  if (replyToken !== undefined && !reply) {
    return jsonError('This reply is out of date. Open the thread again and reply from there.', 400);
  }

  const html = typeof raw.html === 'string' && raw.html.trim() ? raw.html : null;
  if (html && html.length > MAX_HTML) return jsonError('html too long', 400);

  type RawAttachment = { name?: unknown; contentBase64?: unknown; type?: unknown };
  const rawAttachments = Array.isArray(raw.attachments) ? (raw.attachments as RawAttachment[]) : [];
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return jsonError(`at most ${MAX_ATTACHMENTS} attachments`, 400);
  }
  let b64Total = 0;
  const attachments: Array<{ filename: string; contentBase64: string; contentType?: string }> = [];
  for (const a of rawAttachments) {
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 255) : '';
    const content = typeof a.contentBase64 === 'string' ? a.contentBase64 : '';
    if (!name || !content) return jsonError('each attachment needs a name and contentBase64', 400);
    b64Total += content.length;
    if (b64Total > MAX_ATTACHMENT_B64) return jsonError('attachments exceed the 3MB limit', 400);
    attachments.push({
      filename: name,
      contentBase64: content,
      ...(typeof a.type === 'string' && a.type ? { contentType: a.type } : {}),
    });
  }
  // The retained record: metadata + a hash of the bytes, never the bytes.
  const attachmentMeta = attachments.map((a) => {
    const bytes = Buffer.from(a.contentBase64, 'base64');
    return {
      name: a.filename,
      type: a.contentType ?? null,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });

  // Deal tagging is LENIENT by design: a sandbox fixture slug sends UNTAGGED
  // rather than failing. A real deal the caller cannot see and a deal-shaped
  // ref that matches nothing both get the "no such deal" answer, so a send
  // never reveals whether a deal exists (D65, #245). A lookup ERROR fails the
  // send loudly — it is retryable.
  let dealRef: LenientDealRef;
  try {
    dealRef = await resolveDealRefLenient(auth.admin, auth.user.id, raw.dealId);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Deal lookup failed', 500);
  }
  if (dealRef.kind === 'hidden') return dealNotVisible();
  const dealId = dealRef.kind === 'deal' ? dealRef.id : null;

  if (dealId) {
    // Apply the authoritative label before screening, token binding or storage.
    const { data: deal, error: lifecycleError } = await auth.admin
      .from('deals')
      .select('lifecycle_category')
      .eq('id', dealId)
      .maybeSingle();
    if (lifecycleError) return jsonError('Unable to verify email confidentiality', 500);
    if (!deal) return jsonError('Deal not found', 404);
    if (!LIFECYCLE_CATEGORIES.includes(deal.lifecycle_category as LifecycleCategory)) {
      return jsonError('Deal lifecycle is unavailable', 500);
    }
    subject = confidentialSubject(subject, requiresConfidential(deal.lifecycle_category as LifecycleCategory));
    if (subject.length > MAX_SUBJECT) return jsonError('subject too long after Confidential marking', 400);
  }

  const { data: sender, error: senderError } = await auth.admin
    .from('users')
    .select('tenant_id, firm_role, company_id')
    .eq('id', auth.user.id)
    .single();
  if (senderError) return jsonError('Sender profile unavailable', 500);
  if (!sender) return jsonError('User profile not found', 404);
  // The model gate (#339): whether the screen's model pass may see this
  // tenant's mail. A sender with no tenant is withheld, and the screen runs
  // its deterministic layer only.
  const model = modelCallsAllowed((sender.tenant_id as string | null) ?? null, 'mail_send_screen');
  // Storm, Sep 21 (Q3): an outside recipient warns, it never blocks. A lookup
  // failure is recorded honestly as 'unverified' and logged, not turned into a
  // refusal: the send path must not gain two new tables as hard preconditions,
  // and the composer keeps Send enabled in exactly this state.
  let boundary: RecipientBoundary = 'unverified';
  let verifiedDomains: string[] = [];
  try {
    const policy = await loadMailDomainPolicy(auth.admin, sender);
    verifiedDomains = policy.verifiedDomains;
    boundary = recipientBoundary([...to, ...cc, ...bcc], verifiedDomains);
  } catch (error) {
    console.error('[outbox] recipient boundary unavailable, recorded as unverified', {
      code: errorCodeOf(error),
    });
  }

  // A risk-issues response must be able to mint its token. Checked BEFORE
  // anything is screened or written: a misconfigured environment fails here,
  // cleanly, never after the screen audit row has already committed.
  if (!hasScreenTokenKey()) {
    console.error(`outbox: ${SCREEN_TOKEN_KEY_MISSING}`);
    return jsonError('Mail send is not configured on this environment', 500);
  }

  // The firm's thresholds and send friction (Issue #94, Issue #95). A read
  // error refuses the send: falling back to the defaults could band a message
  // more loosely, or skip a confirm step, the CCO has set.
  let settings: FirmComplianceSettings;
  try {
    settings = await loadFirmComplianceSettings(auth.admin, sender.tenant_id as string);
  } catch (error) {
    console.error('[outbox] compliance settings unavailable', errorCodeOf(error));
    return jsonError('Compliance settings unavailable', 503);
  }

  const recipientAdmin = auth.admin;
  const recipientActorId = auth.user.id;
  let recipientReview: Awaited<ReturnType<typeof loadRecipientReview>> | null = null;
  const recipientMessageDigest = createHash('sha256').update(JSON.stringify([
    to.map(email => email.trim().toLowerCase()), cc.map(email => email.trim().toLowerCase()),
    bcc.map(email => email.trim().toLowerCase()), subject, messageBody, html, attachmentMeta,
  ])).digest('hex');
  const recipientLists = {to, cc, bcc};
  // A reply threads only among its thread's own participants (Martín's review of
  // PR #642): adding anyone else sends it unthreaded, so the thread's Message-IDs
  // never reach a party who was never on it. The audit rows say so.
  const replyParticipants = reply ? new Set(reply.participants) : null;
  const replyOutsideThread =
    replyParticipants !== null && [...to, ...cc, ...bcc].some((email) => !replyParticipants.has(email.trim().toLowerCase()));
  const replyThreading = reply && !replyOutsideThread ? { inReplyTo: reply.inReplyTo, references: reply.references } : null;
  // On the screen row as well as the send row, so a refused reply is tied to the thread it answered.
  const replyAudit = reply
    ? { replyToSourceItemId: reply.sourceItemId, ...(replyOutsideThread ? { replyRecipientsOutsideThread: true } : {}) }
    : {};
  async function checkRecipientApproval() {
    if (!dealId) return null;
    recipientReview = await loadRecipientReview(recipientAdmin, recipientActorId, dealId, recipientLists);
    if (!recipientReview.recipients.some(recipient => recipient.requiresConfirmation)) return null;
    const binding = {actorId: recipientActorId, tenantId: sender!.tenant_id as string,
      dealId, messageDigest: recipientMessageDigest, policyFingerprint: recipientReview.policyFingerprint};
    if (verifyRecipientToken(raw.recipientApprovalToken, binding)) return null;
    return NextResponse.json({recipientReviewRequired: {
      recipients: recipientReview.recipients, token: mintRecipientToken(binding),
    }});
  }
  try {
    const reviewResponse = await checkRecipientApproval();
    if (reviewResponse) return reviewResponse;
  } catch (error) {
    return jsonError('Recipient relationships unavailable', error instanceof RecipientPolicyError ? error.status : 503);
  }

  // #490: the sending mailbox, read BEFORE the screen. A read error fails here
  // rather than reading as "no connection" (R21). A Gmail connection that
  // cannot send (approval ended, or the sending client switched off) is
  // refused before any screen, AI spend, audit row or pending row (R23).
  const identity = await sendingIdentity(auth.admin, auth.user.id).catch(() => undefined);
  if (identity === undefined) return jsonError(MAILBOX_UNAVAILABLE_COPY, 500);
  const refusal = connectedSendRefusal(identity);
  if (refusal) return jsonError(providerFailureCopy(refusal), 502);

  // Send friction (Issue #95, D105): a firm on confirm_external asks the
  // sender once before any send that reaches outside it. Asked before the
  // screen, so nothing is screened, spent or recorded until they confirm.
  // A boundary we could not verify asks too: when in doubt, the firm's
  // setting says ask. A UX nudge, not a supervisory control: the confirm is
  // asserted by the client (externalConfirmed), so the audit's
  // externalConfirmed is not evidence that a person confirmed (D105).
  // Answered 409, so a caller that only checks res.ok never reads it as sent.
  const frictionApplies =
    settings.sendFriction === SEND_FRICTION.CONFIRM_EXTERNAL && boundary !== 'internal';
  if (frictionApplies && raw.externalConfirmed !== true) {
    const everyone = [...to, ...cc, ...bcc];
    const outside = everyone.filter((email) => recipientBoundary([email], verifiedDomains) !== 'internal');
    return NextResponse.json(
      { externalConfirmationRequired: { recipients: outside.length ? outside : everyone } },
      { status: 409 },
    );
  }

  // The subject travels with the message — screen it too, the attachment
  // NAMES (a filename like "internal-valuation-510M.xlsx" is itself a leak),
  // and the HTML body AS TEXT: providers prefer html over text when both are
  // present, so unscreened html would be an open side door around the gate.
  // Fields are screened SEPARATELY (fullScreenFields) so \s+ in the patterns
  // cannot match across field seams and flag phrases that exist in no field
  // (MNPI alone is still checked across fields — a figure in one field and
  // its valuation context in another read together as a leak).
  // Attachment CONTENT too (Storm, Oct 9, Option B): the text of each
  // attachment read in full is one more field. One not read in full is never
  // clean: withUnreadAttachments below turns the screen into a hold.
  const attachmentRead = await readAttachments(
    attachments.map((a) => ({ name: a.filename, type: a.contentType ?? null, contentBase64: a.contentBase64 })),
  );
  const screenedFields = [
    subject,
    messageBody,
    ...(html ? [toPlainText(html)] : []),
    ...attachments.map((a) => a.filename),
    ...attachmentRead.texts,
  ];

  // Sender sign-off claims from the composer (#155/#156). Validation lives
  // INSIDE fullScreenFields (intersected with the hits the rule pack itself
  // recomputes) — an unvalidated path to the AI prompt cannot be expressed
  // from here. The validated list rides back for the audit record.
  const claims = Array.isArray(raw.preApproved)
    ? (raw.preApproved as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  // The evidence hash covers the full screened content, in order, as a JSON
  // array — NOT joined text. The fields are screened separately, so two
  // decompositions of the same bytes (a phrase split across subject and
  // body vs. the same phrase in one field) screen differently; a joined hash
  // would let the milder read be replayed over the recomposed text. It is
  // what the send-as-is token is BOUND to (with the sender and the deal):
  // "send as written" is only honored for the exact fields the sender saw
  // the concern about. The attachments' byte hashes are bound too (PR #536
  // review): an attachment that could not be read contributes only its name
  // to the fields, so without them "send anyway" would carry over to
  // different bytes under the same name. They are hashed, never screened.
  const screenedSha = createHash('sha256')
    .update(JSON.stringify(attachmentMeta.length ? [screenedFields, attachmentMeta.map((a) => a.sha256)] : screenedFields))
    .digest('hex');
  const screenSubject = {
    sha: screenedSha,
    actorId: auth.user.id,
    dealId,
    // #490 (R17), Gmail only: a send-as-is carries over only to the same
    // recipients and the same sending mailbox. Other tokens are unchanged.
    ...(identity?.provider === 'google' ? { envelope: envelopeSha({ to, cc, bcc }, identity) } : {}),
  };

  // The Risk Patcher (#192, written decision Aug 24): NOTHING blocks or
  // holds a send any more, MNPI included — the platform reduces real risk
  // through traceability, not blocking. When the screen reports risk issues,
  // the decision returns to the SENDER: use the AI's draft, edit, or send
  // as-is. Without the send-as-is flag, nothing is stored or sent — the
  // screen audit below still records that the control fired.
  //
  // Slice 2b: the flag rides with the FIRST screen's read, signed and bound
  // to the content sha (screenToken). A genuine token REPLAYS that screen —
  // no second LLM call, and the record is exactly what the sender approved.
  // A missing, forged, edited-content or expired token is not an error: the
  // content is screened afresh, and the sender gets a fresh token (an
  // unbound flag could otherwise apply the decision to issues they were
  // never shown, or drop the marker from the audit).
  const sendAsIsRequested = raw.sendAsIs === true || raw.overrideReputational === true;
  const replay = sendAsIsRequested ? verifyScreenToken(raw.overrideToken, screenSubject) : null;
  // A replay runs no model: its screen carries the first screen's gate
  // decision from the signed token, and the row records this request's gate
  // beside it (replayGate).
  // A replayed token already carries the unread-attachment reasons it was minted with.
  // Jev's second opinion (D82) is off by default; jevCallAllowed is its one
  // gate, read only when the rules leave a flag, and it needs the model gate's
  // own decision for Jev (#339; a sender with no tenant is withheld). Jev
  // reads the subject and body alone, so a flag raised elsewhere is never
  // cleared.
  const tenantId = sender.tenant_id as string;
  const jevModel = modelCallsAllowed((sender.tenant_id as string | null) ?? null, 'mail_send_second_opinion');
  const secondOpinion = {
    subject,
    body: messageBody,
    model: jevModel,
    gate: () => jevCallAllowed(jevModel, supabaseFlagSource),
  };
  const screened = replay
    ? screenedFromToken(replay)
    : withUnreadAttachments(
        await fullScreenFields(screenedFields, model, { claims, secondOpinion }),
        attachmentRead.findings,
      );
  const preApproved = screened.preApproved ?? [];
  const riskIssues = screened.verdict !== 'compliant';
  const sendAsIs = replay !== null;

  // The band (#192): derived here, stored on the row and cited in the audit.
  // The heat number is consumed by the derivation and then dropped. The band
  // only applies where a message proceeds: a screen returned to the sender
  // stores nothing and cites no band.
  // Band floor (#192 review): a send the sender explicitly pushed past a
  // risk screen is ALWAYS the CCO's business — the REQUEST is the signal,
  // whether the token replayed the first screen or (expired, rotated key)
  // a fresh screen ran and came back compliant. The override request itself
  // queues the message for post-send review.
  const riskBand = sendAsIsRequested ? RISK_BAND.QUEUED : riskBandFor(screened, settings);
  const proceeds = !riskIssues || sendAsIs;

  // The AI spend ledger (#109): a fresh LLM pass is a cost line; a token
  // replay ran no model and records nothing.
  if (screened.ai) {
    await recordAiUsage(auth.admin, {
      tenantId: sender.tenant_id as string,
      dealId,
      actorId: auth.user.id,
      source: 'screen',
      task: 'mail_send_screen',
      externalId: randomUUID(),
      model: screened.ai.model,
      usage: screened.ai,
    });
  }
  // Jev's call is its own cost line (D82): the gateway's price, or null
  // (unknown, not free). Content-free, like the line above.
  if (screened.secondOpinionAi) {
    await recordAiUsage(auth.admin, {
      tenantId,
      dealId,
      actorId: auth.user.id,
      source: 'screen',
      task: 'mail_send_second_opinion',
      externalId: randomUUID(),
      model: screened.secondOpinionAi.model,
      costUsd: screened.secondOpinionAi.costUsd,
    });
  }

  // The screen event is the control's own evidence — if it cannot be
  // recorded, nothing proceeds (and nothing has been stored or sent yet).
  const { error: screenAuditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.SCREEN,
    deal_id: dealId,
    detail: {
      mode: 'full',
      ...replyAudit,
      // Internal mail is screened exactly like external mail (D86); the
      // boundary lets a reviewer see a flagged message was internal-only.
      recipientBoundary: boundary,
      verdict: screened.verdict,
      reasons: screened.reasons,
      llmChecked: screened.llmChecked,
      // The model gate's decision (#339), and why the model pass was
      // withheld when it was. On a replay both are the first screen's.
      modelDecision: screened.modelDecision,
      ...(screened.llmWithheld ? { llmWithheld: screened.llmWithheld } : {}),
      // The sender's validated sign-offs are part of the compliance record:
      // supervision can see exactly which flagged terms were kept knowingly.
      ...(preApproved.length ? { preApproved } : {}),
      // The hold cause routes supervision (#158); the ephemeral heat score is
      // deliberately NOT recorded (Storm: display at send time, never persist).
      ...(screened.holdCause ? { holdCause: screened.holdCause } : {}),
      // Every verdict cites the lexicon VERSION it enforced (#163 — the
      // lexicon is a working draft, not adopted policy; adoption stays a CCO
      // decision, and the record must say which vocabulary produced what).
      ...(screened.lexicon ? lexiconAuditFields(screened.lexicon) : {}),
      // An honored send-as-is is part of THIS row's evidence too — without
      // it the screen row would read "returned to sender" for a message that
      // the very next row shows was sent.
      ...(riskIssues && sendAsIs ? { sentAsIs: true } : {}),
      // No screen ran on this request: the row applies the first screen's
      // read (same sha) to the send. The label must not claim a fresh check.
      // The replaying request's own gate decision rides beside the first
      // screen's (#339): a withheld one here says so, without implying the
      // replayed read ran or skipped a model.
      ...(replay ? { replayed: true, replayGate: modelDecisionRecord(model) } : {}),
      // A screen whose issues went back to the sender queued NOTHING — the
      // marker keeps the audit label honest (legacy held rows lack it and
      // keep their true queue label).
      ...(riskIssues && !sendAsIs ? { returned: true } : {}),
      ...(proceeds ? { riskBand } : {}),
      // Which attachment was read, and which carried a rule hit: by position,
      // never by name or text (D80: a returned screen gains no content).
      ...(attachmentRead.findings.length ? { attachments: attachmentRead.findings } : {}),
      // Jev's second opinion (D82): outcome, threshold and the rule reasons a
      // clear lifted. Never Jev's probabilities (a raw score, #192), never content.
      ...(screened.secondOpinion ? { secondOpinion: screened.secondOpinion } : {}),
      sha256: screenedSha,
    },
  });
  if (screenAuditError) {
    return jsonError(`Audit write failed (${errorCodeOf(screenAuditError)})`, 500);
  }
  if (riskIssues && !sendAsIs) {
    return NextResponse.json(
      {
        riskIssues: {
          reasons: screened.reasons,
          // Only an LLM-written BODY is offered as a one-click send; the rule
          // pack's advisory note travels as advice — text a sender must never
          // email to a counterparty (#192 review).
          rewrite: screened.rewriteIsBody ? (screened.rewrite ?? null) : null,
          advice: screened.rewriteIsBody ? null : (screened.rewrite ?? null),
          heat: typeof screened.heat === 'number' ? screened.heat : null,
          cause: screened.holdCause ?? (screened.verdict === 'blocked' ? 'promissory' : null),
          token: mintScreenToken(screenTokenRecord(screened, screenSubject)),
        },
      },
      { status: 200 },
    );
  }

  // Screening may be slow; recheck the current roster before committing the send.
  try {
    const reviewResponse = await checkRecipientApproval();
    if (reviewResponse) return reviewResponse;
  } catch (error) {
    return jsonError('Recipient relationships unavailable', error instanceof RecipientPolicyError ? error.status : 503);
  }

  // Record-first: the row exists BEFORE anything can leave the platform,
  // inserted as 'pending' and flipped to 'sent' only after the provider
  // accepts it. Every stored row sends now (#192): the screen's verdict is
  // preserved on the row as the control's record; the status is what
  // happened. 'held' and 'blocked' are no longer produced on this path —
  // legacy rows keep their review flow.
  const initialStatus: OutboxStatus = OUTBOX_STATUS.PENDING;

  const { data: row, error: insertError } = await auth.admin
    .from('outbound_messages')
    .insert({
      tenant_id: sender.tenant_id,
      deal_id: dealId,
      sender_id: auth.user.id,
      recipient_boundary: boundary,
      recipient_review: recipientReview,
      to_emails: to,
      cc_emails: cc,
      bcc_emails: bcc,
      subject,
      body: messageBody,
      body_html: html,
      attachments: attachmentMeta,
      verdict: screened.verdict,
      reasons: screened.reasons,
      rewrite: screened.rewrite ?? null,
      llm_checked: screened.llmChecked,
      risk_band: riskBand,
      status: initialStatus,
      provider: null,
      provider_message_id: null,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    })
    .select(MESSAGE_SELECT)
    .single();
  // The insert IS the idempotency claim: a concurrent request with the same
  // clientRequestId loses on the unique index and gets the winner's answer.
  if (insertError && clientRequestId && errorCodeOf(insertError) === '23505') {
    const prior = await priorSend(auth.admin, auth.user.id, clientRequestId);
    if (prior) return prior;
  }
  if (insertError) return jsonError(`Outbox write failed (${errorCodeOf(insertError)})`, 500);
  const inserted = row as unknown as MessageRow;

  let receipt: { id: string; provider: string; simulated?: boolean };
  try {
    // No From yet (#490): a connected mailbox sends as its own address, so
    // the platform From is resolved only when the platform transport sends.
    // A missing EMAIL_FROM then never fails a connected sender's mail.
    const message: MessageInput = {
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject,
      text: messageBody,
      ...(html ? { html } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(replyThreading ?? {}),
    };
    // A connected mailbox is authoritative — the message leaves as the
    // banker's real address (Graph or Gmail). Otherwise the default
    // transport. The mailbox must still be the one read before the screen.
    receipt =
      (await sendAsConnectedUser(auth.admin, auth.user.id, message, { expect: identity })) ??
      (await getEmailTransport().send({ from: defaultFromAddress(), ...message }));
  } catch (err) {
    // Nothing left the platform; drop the pending row so the sender can
    // retry once the provider is healthy. The 'screen' audit row remains.
    await auth.admin.from('outbound_messages').delete().eq('id', inserted.id);
    return jsonError(providerFailureCopy(err), 502);
  }

  const { data: sentRow, error: updateError } = await auth.admin
    .from('outbound_messages')
    .update({
      status: OUTBOX_STATUS.SENT,
      provider: receipt.provider,
      provider_message_id: receipt.id,
    })
    .eq('id', inserted.id)
    .select(MESSAGE_SELECT)
    .single();
  // The message HAS left; a failure past this point must be loud, never
  // silent — the row stays 'pending' as evidence of the in-flight send.
  if (updateError) {
    return jsonError(`Message sent but record update failed (${errorCodeOf(updateError)})`, 500);
  }

  // Issue #429: a send that needed recipient approval reached here only with a
  // verified approval token, so the row says so explicitly instead of leaving
  // supervision to infer it from recipientReview. Issue #378: the approved
  // outsiders new to the deal are known recipients from this send on (the
  // history is the deal's sent mail). Only a SENT message carries this (D80).
  const sentReview = recipientReview as Awaited<ReturnType<typeof loadRecipientReview>> | null;
  const approvedRecipients = sentReview?.recipients.filter(recipient => recipient.requiresConfirmation) ?? [];
  const knownRecipientsAdded = approvedRecipients.filter(becomesKnownRecipient).map(recipient => recipient.email);
  const { error: sendAuditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.SEND,
    deal_id: dealId,
    detail: {
      messageId: inserted.id,
      provider: receipt.provider,
      providerMessageId: receipt.id,
      recipients: to.length,
      ...replyAudit,
      recipientBoundary: boundary,
      ...(sentReview ? {recipientReview: sentReview} : {}),
      ...(approvedRecipients.length ? {recipientOverride: true} : {}),
      ...(knownRecipientsAdded.length ? {knownRecipientsAdded} : {}),
      ...(receipt.simulated ? { simulated: true } : {}),
      // The firm's confirm step ran and the sender confirmed (Issue #95).
      ...(frictionApplies ? { externalConfirmed: true } : {}),
      // A model lifted a rule flag on this sent message (D82), and nothing
      // escalated it again afterwards.
      ...(screened.secondOpinion?.outcome === 'cleared' && screened.verdict === 'compliant'
        ? { secondOpinion: 'cleared' }
        : {}),
      // The sender chose to send despite reported risk issues — the decision
      // is the record (the heat number deliberately is not). The cause CAN
      // be named now: a replayed screen is the one the sender saw, not a
      // nondeterministic second read. `sentAsIsRequested` (flag sent, token
      // not honored, fresh screen compliant) keeps the intent visible.
      ...(riskIssues && sendAsIs
        ? { sentAsIs: true, ...(screened.holdCause ? { holdCause: screened.holdCause } : {}) }
        : sendAsIsRequested
          ? { sentAsIsRequested: true }
          : {}),
    },
  });
  if (sendAuditError) {
    return jsonError(`Message sent but audit write failed (${errorCodeOf(sendAuditError)})`, 500);
  }

  // Anything Queued that still went out reaches the CCO afterwards (Issue #94).
  if (riskBand === RISK_BAND.QUEUED) {
    await notifyQueuedSend(auth.admin, {
      tenantId: sender.tenant_id as string,
      senderId: auth.user.id,
      messageId: inserted.id,
      dealId,
    });
  }

  return NextResponse.json(
    { message: toApiMessage(sentRow as unknown as MessageRow) },
    { status: 201 },
  );
}

export async function GET(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  if (status && !OUTBOX_STATUSES.includes(status as OutboxStatus)) {
    return jsonError(`status must be one of ${OUTBOX_STATUSES.join(', ')}`, 400);
  }
  // The post-send review filter (#192 slice 3): ?status=sent&band=queued is
  // the CCO's queue now that nothing holds before sending.
  const band = url.searchParams.get('band');
  if (band && !RISK_BANDS.includes(band as RiskBand)) {
    return jsonError(`band must be one of ${RISK_BANDS.join(', ')}`, 400);
  }
  // Optional per-project scope, resolved as leniently as the send path: a
  // sandbox slug means NO filter. A deal the caller cannot see, or a
  // deal-shaped ref that matches nothing, filters to a deal id that matches
  // nothing, so both read as an empty list (D65, #245). A lookup ERROR fails
  // loud — silently dropping the filter would widen the read scope.
  let dealId: string | null;
  try {
    const dealRef = await resolveDealRefLenient(auth.admin, auth.user.id, url.searchParams.get('dealId'));
    dealId = dealRef.kind === 'deal' ? dealRef.id : dealRef.kind === 'hidden' ? NO_SUCH_DEAL : null;
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Deal lookup failed', 500);
  }

  const { data: caller } = await auth.admin
    .from('users')
    .select('tenant_id, firm_role, is_external')
    .eq('id', auth.user.id)
    .single();
  if (!caller) return jsonError('User profile not found', 404);

  // The external wall beats any firm_role: an external user must never read
  // the tenant-wide queue (the invite-phase schema lets externals hold one).
  const overseer =
    !caller.is_external &&
    (caller.firm_role === FIRM_ROLE.CCO || caller.firm_role === FIRM_ROLE.ADMIN);

  // deals(code) rides along so the supervisory queue can show which deal a
  // held message belongs to without a second lookup.
  let query = auth.admin
    .from('outbound_messages')
    .select(`${MESSAGE_SELECT}, deal:deals(code)`);
  // An overseer reads tenant-wide (the supervisory queue); everyone else
  // reads only their own outbox.
  query = overseer
    ? query.eq('tenant_id', caller.tenant_id)
    : query.eq('sender_id', auth.user.id);
  if (status) query = query.eq('status', status);
  if (band) query = query.eq('risk_band', band);
  if (dealId) query = query.eq('deal_id', dealId);

  const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
  if (error) return jsonError(`Outbox read failed (${errorCodeOf(error)})`, 500);

  return NextResponse.json({
    messages: ((data ?? []) as unknown as MessageRow[]).map(toApiMessage),
  });
}
