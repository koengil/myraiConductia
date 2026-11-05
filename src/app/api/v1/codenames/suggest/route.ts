import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { modelCallsAllowed } from '@/lib/ai/modelPolicy';
import { recordAiUsage, type AiCallUsage } from '@/lib/ai/usage';

import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { suggestCodenames } from '@/lib/gate0/codenameLlm';
import { resolveCompany, type SearchableCompany } from '@/lib/rail/deals';

type SuggestBody = {
  companyId?: unknown;
  name?: unknown;
  sector?: unknown;
  offset?: unknown;
};

/**
 * POST /api/v1/codenames/suggest — AI-themed Gate 0 code-name proposals.
 *
 * Returns three themes with four masked "Project …" suggestions each. Falls back
 * to deterministic themes when the model gate withholds the call, when the LLM
 * is unavailable, or when every pick fails the mask check.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: SuggestBody;
  try {
    body = (await request.json()) as SuggestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return jsonError('name is required', 400);

  const sector =
    typeof body.sector === 'string' && body.sector.trim()
      ? body.sector.trim()
      : 'Private company';
  const companyId =
    typeof body.companyId === 'string' && body.companyId.trim()
      ? body.companyId.trim()
      : undefined;
  const offset =
    typeof body.offset === 'number' && Number.isFinite(body.offset)
      ? Math.abs(Math.floor(body.offset))
      : 0;

  const company: SearchableCompany = companyId
    ? { id: companyId, name, sector }
    : resolveCompany(name);

  // The model gate (#339): the prompt names the target company, which is
  // tenant content. A failed lookup or a user with no tenant is withheld
  // (tenant_unresolved), and the suggestions come from the fallback list.
  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  const tenantId = profileError ? null : ((profile?.tenant_id as string | null | undefined) ?? null);

  // The AI spend ledger (#109): a codename call has no deal yet (it names
  // one), so it lands on the actor with the lead's company id.
  let ai: AiCallUsage | null = null;
  const result = await suggestCodenames(company, offset, modelCallsAllowed(tenantId, 'codename_suggest'), (usage) => {
    ai = usage;
  });
  if (ai && tenantId) {
    await recordAiUsage(auth.admin, {
      tenantId,
      companyId: companyId ?? null,
      actorId: auth.user.id,
      source: 'screen',
      task: 'codename_suggest',
      externalId: randomUUID(),
      model: (ai as AiCallUsage).model,
      usage: ai,
    });
  }
  return NextResponse.json(result);
}
