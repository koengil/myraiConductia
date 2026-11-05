import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  MAIL_WARNING_KINDS,
  MAIL_WARNING_OUTCOMES,
  type MailWarningKind,
  type MailWarningOutcome,
} from '@/lib/constants/mailWarningOutcomes';
import { requireFlag } from '@/lib/flags/requireFlag';

/** One report covers at most the two warning kinds a draft can meet. */
const MAX_OUTCOMES = MAIL_WARNING_KINDS.length;

/**
 * POST /api/v1/mail-warning-outcomes
 *
 * The composer reports an email sent after a send-time warning (the Risk
 * Patcher or the recipient review, not the advisory shown while typing), sent
 * anyway or after fixing it. Body: `{ outcomes: [{ kind, outcome }] }`, with
 * `outcome` always `sent_after_warning`: a discarded or abandoned draft is
 * never recorded (D80, Storm at the Oct 5 Weekly Build Sync).
 *
 * Anonymous by design: the tenant is resolved from the signed-in user and
 * only a daily counter per tenant, kind and outcome moves. No person, deal or
 * message content is recorded (Storm's answer 7A keeps no record of unsent
 * emails). It answers 204 and the client never waits on it.
 */
export async function POST(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const outcomes = (raw as { outcomes?: unknown })?.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_OUTCOMES) {
    return jsonError(`outcomes must list 1 to ${MAX_OUTCOMES} warnings`, 400);
  }
  const pairs = new Map<string, { kind: MailWarningKind; outcome: MailWarningOutcome }>();
  for (const entry of outcomes) {
    const { kind, outcome } = (entry ?? {}) as { kind?: unknown; outcome?: unknown };
    if (!MAIL_WARNING_KINDS.includes(kind as MailWarningKind)) return jsonError('Unknown warning kind', 400);
    if (!MAIL_WARNING_OUTCOMES.includes(outcome as MailWarningOutcome)) return jsonError('Only emails sent after a warning are counted', 400);
    pairs.set(`${kind}:${outcome}`, { kind: kind as MailWarningKind, outcome: outcome as MailWarningOutcome });
  }

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (profileError) return jsonError('User profile is unavailable', 503);
  if (!profile?.tenant_id) return jsonError('User profile not found', 404);

  for (const { kind, outcome } of pairs.values()) {
    const { error } = await auth.admin.rpc('record_mail_warning_outcome', {
      p_tenant_id: profile.tenant_id,
      p_kind: kind,
      p_outcome: outcome,
    });
    if (error) return jsonError('Could not record the outcome', 500);
  }
  return new Response(null, { status: 204 });
}
