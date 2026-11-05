import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { changeSetBody } from '@/lib/railTemplates/changeSetTitles';
import { requireTemplateChangeReader } from '@/lib/railTemplates/templateChangeRouteGuard';

type RouteContext = { params: Promise<{ dealId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { dealId } = await context.params;
  const guard = await requireTemplateChangeReader(dealId);
  if (!guard.ok) return guard.response;

  const { data, error } = await guard.auth.admin.rpc('deal_template_changes', {
    p_deal_id: guard.deal.id,
    p_protected_ids: [...PROTECTED_STEP_IDS],
  });
  if (error) return jsonError('The template changes could not be read. Try again.', 500);

  return NextResponse.json(changeSetBody(data));
}
