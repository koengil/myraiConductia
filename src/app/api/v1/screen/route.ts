import { recordAiUsage } from '@/lib/ai/usage';
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { auditFailed, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { fullScreen } from '@/lib/compliance/llm';
import { modelCallsAllowed } from '@/lib/ai/modelPolicy';
import { lexiconAuditFields } from '@/lib/compliance/lexicon';
import { screenMessage } from '@/lib/compliance/screen';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * POST /api/v1/screen — the pre-send screening service (the platform contract,
 * BESIDE the ConductiaAPI seam; ADR-0008). One engine, two modes:
 *
 *   fast — deterministic screenMessage() only. As-you-type advisory checks;
 *          sub-100ms, NOT audited (a debounced keystroke stream would flood
 *          the append-only log — only the send-time decision is a record).
 *   full — deterministic first, then the LLM escalation layer (llm.ts).
 *          The send-time gate; audited as one 'screen' row carrying the
 *          verdict + a sha256 of the text (content itself lives in
 *          outbound_messages when a send is attempted, not in audit detail).
 *
 * Verdict shape is ADR-0003 (compliant | hold | blocked + reasons + rewrite);
 * a rules-based verdict is never downgraded by the LLM.
 */

const MODES = new Set(['fast', 'full']);
const MAX_TEXT_LENGTH = 50_000;

type ScreenBody = { text?: unknown; mode?: unknown; dealId?: unknown };

// The LLM screen may legitimately take >15s on hard judgments (llm.ts
// TIMEOUT_MS 25s) — without this the platform default kills the request
// mid-screen instead of degrading visibly.
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: ScreenBody;
  try {
    body = (await request.json()) as ScreenBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const text = typeof body.text === 'string' ? body.text : null;
  if (!text) return jsonError('text is required', 400);
  if (text.length > MAX_TEXT_LENGTH) return jsonError('text too long', 400);

  const mode = body.mode === undefined ? 'fast' : body.mode;
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    return jsonError("mode must be 'fast' or 'full'", 400);
  }

  const dealId = typeof body.dealId === 'string' && body.dealId ? body.dealId : null;
  if (dealId) {
    const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealId);
    if (!allowed) return jsonError('Forbidden', 403);
  }

  if (mode === 'fast') {
    return NextResponse.json({ ...screenMessage(text), mode, llmChecked: false });
  }

  // The model gate (#339) needs the caller's tenant before the screen runs. A
  // failed lookup or a user with no tenant is withheld (tenant_unresolved):
  // the screen still answers, from its deterministic layer.
  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  const tenantId = profileError ? null : ((profile?.tenant_id as string | null | undefined) ?? null);
  const merged = await fullScreen(text, modelCallsAllowed(tenantId, 'mail_screen'));

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.SCREEN,
    deal_id: dealId,
    detail: {
      mode,
      verdict: merged.verdict,
      reasons: merged.reasons,
      llmChecked: merged.llmChecked,
      // The model gate's decision (#339), same keys as the outbox writer.
      modelDecision: merged.modelDecision,
      ...(merged.llmWithheld ? { llmWithheld: merged.llmWithheld } : {}),
      // Every screen audit cites the enforced vocabulary (#163) — same
      // builder as the outbox route, so the two rows never diverge.
      ...(merged.lexicon ? lexiconAuditFields(merged.lexicon) : {}),
      // Same evidence shape as the outbox writer: without the cause a
      // reputational hold would render as a supervisory-queue entry.
      ...(merged.holdCause ? { holdCause: merged.holdCause } : {}),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  });
  if (auditError) return auditFailed(auditError, 'The screen could not be recorded, so its verdict cannot be used. Try again.');

  // The AI spend ledger (#109): the pass that just ran, priced. The audit row
  // stays the compliance evidence; this is the cost line beside it. A pass
  // runs only when the gate allowed it, which needs a resolved tenant.
  if (merged.ai && tenantId) {
    await recordAiUsage(auth.admin, {
      tenantId,
      dealId,
      actorId: auth.user.id,
      source: 'screen',
      task: 'mail_screen',
      externalId: randomUUID(),
      model: merged.ai.model,
      usage: merged.ai,
    });
  }

  return NextResponse.json({
    verdict: merged.verdict,
    reasons: merged.reasons,
    ...(merged.rewrite ? { rewrite: merged.rewrite } : {}),
    mode,
    llmChecked: merged.llmChecked,
  });
}
