import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import {
  importAddedStepSkill,
  parseChangeSkillPlan,
  type StepSkillImport,
} from '@/lib/railTemplates/acceptStepSkill';
import { SKILL_STEP_NOT_ADDED } from '@/lib/railTemplates/changeReview';
import { changeSetBody } from '@/lib/railTemplates/changeSetTitles';
import { requireTemplateChangeDecider } from '@/lib/railTemplates/templateChangeRouteGuard';
import { TemplateError } from '@/lib/railTemplates/types';

type RouteContext = { params: Promise<{ dealId: string; changeId: string }> };

const DECISIONS = new Set(['accepted', 'discarded']);
const STALE = 'This change is no longer offered';
const DECISION_FAILED = 'The decision was not recorded. Try again.';
const SKILLS_OFF = 'Skills are not enabled here, so this step was not added.';
const SKILL_GONE = 'The skill on this step is no longer available, so the step was not added.';
const SKILL_SERVICE_DOWN = 'The skill service did not answer, so the step was not added.';
const SKILL_ANSWER_UNUSABLE =
  'The skill service returned an answer Conductia could not use, so the step was not added.';
const SKILL_COPY_FAILED = 'The skill on this step could not be copied, so the step was not added.';

function skillRefusal(error: string, status: number): Prepared {
  return { ok: false, response: NextResponse.json({ error, code: SKILL_STEP_NOT_ADDED }, { status }) };
}

type Prepared = { ok: true; skillImport: StepSkillImport | null } | { ok: false; response: Response };

async function prepareSkillImport(
  admin: SupabaseClient,
  dealId: string,
  changeId: string,
  revisionId: string,
): Promise<Prepared> {
  const { data, error } = await admin.rpc('deal_template_change_skill', {
    p_deal_id: dealId,
    p_change_id: changeId,
    p_revision_id: revisionId,
    p_protected_ids: [...PROTECTED_STEP_IDS],
  });
  if (error?.message === 'stale_change') return { ok: false, response: jsonError(STALE, 409) };
  if (error) return { ok: false, response: jsonError(DECISION_FAILED, 500) };

  const plan = parseChangeSkillPlan(data);
  if (!plan) return { ok: false, response: jsonError('Could not read this change.', 500) };
  if (plan.skillKey === null) return { ok: true, skillImport: null };
  if (!(await isFlagEnabled('skill_authoring'))) {
    return skillRefusal(SKILLS_OFF, 409);
  }

  try {
    const skillImport = await importAddedStepSkill({
      tenantId: plan.tenantId,
      revisionId: plan.revisionId,
      dealId,
      skillKey: plan.skillKey,
    });
    return { ok: true, skillImport };
  } catch (failure) {
    if (!(failure instanceof TemplateError)) throw failure;
    if (failure.code === 'skill_unavailable') return skillRefusal(SKILL_GONE, 409);
    if (failure.code === 'provider_unavailable') {
      return failure.status === 502
        ? skillRefusal(SKILL_ANSWER_UNUSABLE, 502)
        : skillRefusal(SKILL_SERVICE_DOWN, 503);
    }
    return skillRefusal(SKILL_COPY_FAILED, 500);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { dealId, changeId } = await context.params;
  const guard = await requireTemplateChangeDecider(dealId);
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { decision?: unknown; revisionId?: unknown } | null;
  const decision = body?.decision;
  if (typeof decision !== 'string' || !DECISIONS.has(decision)) {
    return jsonError('decision must be accepted or discarded', 400);
  }
  const revisionId = body?.revisionId;
  if (typeof revisionId !== 'string' || !isUuid(revisionId)) {
    return jsonError('revisionId must be the template version under review', 400);
  }

  let skillImport: StepSkillImport | null = null;
  if (decision === 'accepted' && changeId.startsWith('added:')) {
    const prepared = await prepareSkillImport(guard.auth.admin, guard.deal.id, changeId, revisionId);
    if (!prepared.ok) return prepared.response;
    skillImport = prepared.skillImport;
  }

  const { data, error } = await guard.auth.admin.rpc('deal_template_change_decide', {
    p_deal_id: guard.deal.id,
    p_actor_id: guard.auth.user.id,
    p_change_id: changeId,
    p_decision: decision,
    p_revision_id: revisionId,
    p_protected_ids: [...PROTECTED_STEP_IDS],
    p_import: skillImport,
  });
  if (error?.message === 'stale_change') return jsonError(STALE, 409);
  if (error) return jsonError(DECISION_FAILED, 500);

  return NextResponse.json(changeSetBody(data));
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { dealId, changeId } = await context.params;
  const guard = await requireTemplateChangeDecider(dealId);
  if (!guard.ok) return guard.response;

  const { error } = await guard.auth.admin.rpc('deal_template_change_reopen', {
    p_deal_id: guard.deal.id,
    p_actor_id: guard.auth.user.id,
    p_change_id: changeId,
  });
  if (error?.message === 'not_reopenable') {
    return jsonError('Only a discarded or kept change can be reopened', 409);
  }
  if (error) return jsonError('The decision was not reopened. Try again.', 500);

  const { data, error: readError } = await guard.auth.admin.rpc('deal_template_changes', {
    p_deal_id: guard.deal.id,
    p_protected_ids: [...PROTECTED_STEP_IDS],
  });
  if (readError) return jsonError('The template changes could not be read. Try again.', 500);

  return NextResponse.json(changeSetBody(data));
}
