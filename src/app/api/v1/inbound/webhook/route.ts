import { timingSafeEqual, createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/flags/requireFlag';
import { logServerEvent } from '@/lib/log';

/**
 * POST /api/v1/inbound/webhook — the receive side of the mail channel. The
 * email provider (Resend inbound, or any provider that can POST) delivers
 * received mail here; rows land in inbound_messages and surface in the Inbox.
 *
 * Auth: NOT a user session — the provider authenticates with a shared secret
 * (header x-inbound-secret vs INBOUND_WEBHOOK_SECRET). Unconfigured -> 503,
 * so an unset environment can never accept mail. The tenant rides in the
 * webhook URL (?tenant=<uuid>), set per tenant in the provider dashboard.
 *
 * Payloads: a direct shape { from, to, cc?, subject?, text?, html?,
 * attachments? } or a Resend-style envelope { type, data: {...} } — both
 * normalize to the same row. Attachment BYTES are dropped; only metadata is
 * retained, matching the outbound record.
 *
 * deal_id stays null until the per-project address scheme is ratified —
 * resolution will map to_email onto a deal then.
 */

const MAX_TEXT = 100_000;

type RawInbound = {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  text?: unknown;
  body?: unknown;
  html?: unknown;
  attachments?: unknown;
  email_id?: unknown;
};

function firstEmail(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function emailArray(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function str(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Constant-time secret comparison (hash first so lengths always match). */
function secretMatches(candidate: string | null, secret: string): boolean {
  if (!candidate) return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;

  // Each refusal writes one line with its reason; the header value never reaches it (#474).
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    logServerEvent({ evt: 'auth_unavailable', reason: 'misconfigured', status: 503, gate: 'inbound_webhook' });
    return jsonError('Inbound not configured', 503);
  }
  if (!secretMatches(request.headers.get('x-inbound-secret'), secret)) {
    logServerEvent({ evt: 'auth_denied', reason: 'bad_secret', status: 401, gate: 'inbound_webhook' });
    return jsonError('Unauthorized', 401);
  }

  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant');
  if (!tenant || !isUuid(tenant)) return jsonError('tenant query param required', 400);

  let raw: RawInbound & { type?: unknown; data?: RawInbound };
  try {
    raw = (await request.json()) as typeof raw;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  // Resend envelope -> inner data; direct payload -> itself.
  const payload: RawInbound = raw.data && typeof raw.data === 'object' ? raw.data : raw;

  const from = firstEmail(payload.from);
  const to = firstEmail(payload.to);
  if (!from || !to) return jsonError('from and to are required', 400);

  type RawAttachment = { name?: unknown; filename?: unknown; type?: unknown; bytes?: unknown };
  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
    .map((a: RawAttachment) => ({
      name: str(a.name ?? a.filename, 255),
      type: typeof a.type === 'string' ? a.type : null,
      bytes: typeof a.bytes === 'number' ? a.bytes : null,
    }))
    .filter((a) => a.name);

  let admin: ReturnType<typeof createSupabaseAdminClient>;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return jsonError('Server misconfigured', 503);
  }

  // The tenant must actually exist (some user belongs to it) — otherwise a
  // mistyped or forged ?tenant= files mail under a phantom tenant no one can
  // ever read.
  const { data: tenantUser, error: tenantError } = await admin
    .from('users')
    .select('id')
    .eq('tenant_id', tenant)
    .limit(1)
    .maybeSingle();
  if (tenantError) return jsonError(tenantError.message, 500);
  if (!tenantUser) return jsonError('Unknown tenant', 404);

  const { data: row, error } = await admin
    .from('inbound_messages')
    .insert({
      tenant_id: tenant,
      from_email: from,
      to_email: to,
      cc_emails: emailArray(payload.cc),
      subject: str(payload.subject, 1_000),
      body: str(payload.text ?? payload.body),
      body_html: str(payload.html) || null,
      attachments,
      provider: raw.data ? 'resend' : null,
      provider_message_id: str(payload.email_id, 255) || null,
    })
    .select('id')
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id: (row as { id: string }).id }, { status: 201 });
}
