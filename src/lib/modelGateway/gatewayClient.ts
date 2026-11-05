// The one client for the AI Gateway's Messages endpoint. It holds no prompt
// and imports nothing from discovery, so the outbox, screen and code-name
// routes can use it without pulling mailbox code into their import closure
// (tests/agent-surfaces.test.ts). gatewayTransport in ./transports delegates here.

import { usageFromAnthropicReply, type AiCallUsage } from '@/lib/ai/usage';
import { codeShaped, errorCodeFromBody } from '@/lib/errors/upstream';
import { logServerEvent, type LineFor } from '@/lib/log';
import { FEATURE_OK_LOGGED, type Feature } from '@/lib/log/values';

export const GATEWAY_MESSAGES_URL = 'https://ai-gateway.vercel.sh/v1/messages';

/** Is a gateway key set? Production readiness requires it (#505-2); dev and preview run rules only without it. */
export function gatewayKeyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY?.trim());
}

/** The auth and version headers every gateway Messages request carries. */
export function gatewayHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}

/** 'claude-sonnet-5' -> 'anthropic/claude-sonnet-5'. An id that already names a provider passes through. */
export function gatewayModelId(id: string): string {
  return id.includes('/') ? id : `anthropic/${id}`;
}

/**
 * The worker's runs log this, once, when the gateway refuses zero data
 * retention (every call also writes its model_outcome line). Nothing falls
 * back to another path or a direct provider. A 403 (the plan has no ZDR) is
 * never retried (D90). A 400 no_providers_available can be a passing
 * gap in ZDR capacity, so a batch run asks again on ZDR_RETRY_DELAYS_MS first
 * (#625, D106); an interactive caller does not wait.
 */
export const ZDR_REFUSED_MESSAGE =
  "AI Gateway refused zero data retention: key's team plan or model has no ZDR; AI is off";

/** The waits before a batch run asks again after a no_providers_available refusal (#625, D106): about 15s, then 45s, then it stops. */
export const ZDR_RETRY_DELAYS_MS = [15_000, 45_000] as const;

/** Which ZDR refusal it was: the gateway's code-shaped error type, never its message. */
export type ZdrReason = 'no_providers_available' | 'permission_denied';

/** A ZDR refusal a batch run may ask again (D106): no ZDR provider serving right now. A 403 is permanent (D90). */
export function isRetryableZdrRefusal(r: { ok: boolean; code?: string; zdrReason?: ZdrReason }): boolean {
  return !r.ok && r.code === 'zdr_unavailable' && r.zdrReason === 'no_providers_available';
}

export type GatewayMessagesResult =
  | { ok: true; text: string | null; responseId: string; usage: AiCallUsage | null }
  | {
      ok: false;
      /** zdr_unavailable: the gateway refused the zero-retention request (see classifyRefusal). */
      code: 'no_key' | 'timeout' | 'http' | 'zdr_unavailable';
      /** Set with zdr_unavailable: which refusal it was. */
      zdrReason?: ZdrReason;
      status?: number;
      errorCode?: string | null;
      /** Set on every failure after a 2xx header: the provider answered, so the attempt was billed (#645). */
      billed?: true;
      /** Set with billed: the reply's usage, null when it carried none or was not read. The spend still goes on the ledger. */
      usage?: AiCallUsage | null;
      /** Set with billed: the reply's id, '' when it carried none or was not read. */
      responseId?: string;
    };

const isTimeout = (err: unknown) => err instanceof Error && err.name === 'TimeoutError';

export type GatewayMessagesRequest = {
  /** Which feature asks: named on the call's model_outcome line (#474). */
  feature: Feature;
  /** The tenant the call serves, when the caller holds one (the worker does): a UUID on the line. */
  tenant?: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  /** Omitted = the provider default (the compliance screen). */
  thinking?: { type: 'disabled' };
  /** Default: AI_GATEWAY_API_KEY, read at call time. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

type ModelFailure = NonNullable<LineFor<'model_outcome'>['failure']>;
/** A call's result, plus the closed reason for a failure its code alone does not tell apart. */
type Sent = { result: GatewayMessagesResult; failure?: ModelFailure };

/**
 * The one request to the AI Gateway. It owns the URL, the auth and the
 * zero-retention body field (Q10), which is deliberately not a parameter:
 * every caller sends to Anthropic only, with zero data retention. No raw reply
 * leaves the function: the JSON parse, the object guard and every field read
 * happen inside the try, so a malformed 2xx reply is reported as 'http' (or
 * 'timeout' when its body did not arrive in time) marked billed, with its usage
 * and id when the reply carried them, and a non-2xx reply is reduced to its
 * status and a code-shaped error type.
 *
 * It writes model_outcome for every call it receives (#474): one line per call,
 * so a retried call writes one line per attempt, the same unit #645 bills and
 * ledgers (a billed attempt is one line and one ai_usage row). The worker
 * transport decides and logs its own no_key, from the key it read when it was
 * built.
 * Every failure is logged; a success only for a feature FEATURE_OK_LOGGED names
 * (the worker counts its successes elsewhere).
 */
export async function postGatewayMessages(req: GatewayMessagesRequest): Promise<GatewayMessagesResult> {
  const started = Date.now();
  const sent = await sendMessages(req);
  logOutcome(req, sent, Math.max(0, Date.now() - started));
  return sent.result;
}

function logOutcome(req: GatewayMessagesRequest, { result, failure }: Sent, ms: number): void {
  if (result.ok) {
    if (FEATURE_OK_LOGGED[req.feature]) logServerEvent({ evt: 'model_outcome', feature: req.feature, outcome: 'ok', tenant: req.tenant, ms });
    return;
  }
  logServerEvent({
    evt: 'model_outcome',
    feature: req.feature,
    outcome: result.code,
    failure,
    zdrReason: result.zdrReason,
    status: result.status,
    tenant: req.tenant,
    ms,
  });
}

async function sendMessages(req: GatewayMessagesRequest): Promise<Sent> {
  const apiKey = req.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) return { result: { ok: false, code: 'no_key' } };
  // The request is pinned to only: ['anthropic'], so any other provider's id is a configuration error:
  // refuse it here, before anything is sent, rather than let the gateway answer it.
  if (!req.model.startsWith('anthropic/')) {
    return { result: { ok: false, code: 'http', errorCode: 'non_anthropic_model' }, failure: 'non_anthropic_model' };
  }
  const doFetch = req.fetchImpl ?? fetch;
  try {
    const res = await doFetch(GATEWAY_MESSAGES_URL, {
      method: 'POST',
      headers: gatewayHeaders(apiKey),
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        ...(req.thinking ? { thinking: req.thinking } : {}),
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        // Q10: zero data retention, Anthropic only. A top-level body field, not a header.
        providerOptions: { gateway: { zeroDataRetention: true, only: ['anthropic'] } },
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    if (!res.ok) {
      // The status and a code-shaped error type; the body can quote the prompt.
      const { errorCode, zdrReason } = await classifyRefusal(res);
      if (zdrReason) {
        return { result: { ok: false, code: 'zdr_unavailable', zdrReason, status: res.status, errorCode }, failure: 'upstream_status' };
      }
      return { result: { ok: false, code: 'http', status: res.status, errorCode }, failure: 'upstream_status' };
    }
    // Billed from here: the provider answered 2xx, so every exit below says so (#645), with what was read so far.
    let usage: AiCallUsage | null = null;
    let responseId = '';
    try {
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object') {
        return { result: { ok: false, code: 'http', billed: true, usage, responseId }, failure: 'malformed_reply' };
      }
      const reply = data as { id?: unknown; content?: Array<{ type: string; text?: string }> };
      responseId = typeof reply.id === 'string' ? reply.id : '';
      // Read the bill before the content: a 2xx reply was paid for even when its content is malformed.
      usage = usageFromAnthropicReply(data);
      const text = reply.content?.find((c) => c.type === 'text')?.text;
      return { result: { ok: true, text: typeof text === 'string' ? text : null, responseId, usage } };
    } catch (err) {
      // The reply arrived but its body did not read: billed (#645). A body that timed out is a timeout, not a failure value.
      const code = isTimeout(err) ? 'timeout' : 'http';
      return { result: { ok: false, code, billed: true, usage, responseId }, failure: code === 'http' ? 'malformed_reply' : undefined };
    }
  } catch (err) {
    // Before any 2xx header (a network error or a timeout): not known to be billed.
    if (isTimeout(err)) return { result: { ok: false, code: 'timeout' } };
    return { result: { ok: false, code: 'http' }, failure: 'network' };
  }
}

const warned = new Set<string>();

/** Warn once per process, per feature and message: a missing key or a ZDR refusal is a configuration fact, not a per-request event. */
export function warnOnce(feature: string, message: string): void {
  const key = `${feature}\u0000${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[${feature}] ${message}`);
}

export function __resetWarnOnceForTests(): void {
  warned.clear();
}

const ZDR_MENTION = /zero data retention|\bZDR\b/i;

/**
 * Reads an error reply once. Two refusals mean the gateway would not keep the
 * request at zero retention: 403 `permission_denied` naming ZDR (the key's team
 * plan has no ZDR) and 400 `no_providers_available` (no ZDR provider serves
 * the model). The message is matched here and dropped; only the status, a
 * code-shaped type and the verdict leave this function.
 */
async function classifyRefusal(res: Response): Promise<{ errorCode: string | null; zdrReason: ZdrReason | null }> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { errorCode: null, zdrReason: null };
  }
  const errorCode = errorCodeFromBody(body);
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {};
  const type = gatewayErrorType(body);
  const message = typeof nested.message === 'string' ? nested.message : typeof record.message === 'string' ? record.message : '';
  if (res.status === 400 && type === 'no_providers_available') return { errorCode, zdrReason: 'no_providers_available' };
  if (res.status === 403 && type === 'permission_denied' && ZDR_MENTION.test(message)) return { errorCode, zdrReason: 'permission_denied' };
  return { errorCode, zdrReason: null };
}

/** The code-shaped error type of a gateway error body: `error.type` (the Anthropic shape), else a top-level `type`. */
export function gatewayErrorType(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {};
  return codeShaped(nested.type) ?? codeShaped(record.type);
}
