import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';
import { parsePublishCheck } from '@/lib/railTemplates/catalogPublish';
import { retainTemplateSkills } from '@/lib/railTemplates/providerClient';
import { TemplateError, type RetainReceipt } from '@/lib/railTemplates/types';

type RouteContext = { params: Promise<{ templateId: string }> };
type RpcError = { code?: string; message: string };

const PUBLISH_CONFLICT: Readonly<Record<string, string>> = {
  nothing_to_publish: 'There are no changes to publish.',
  name_taken: 'Another saved rail in this company already uses this name.',
  missing_protected_step:
    'This template is missing a step every deal needs, so it cannot be published.',
  draft_changed: 'This template changed while it was being published. Publish again.',
};

const SKILLS_OFF = 'Skills are not enabled here, so this template was not published.';
const SKILL_GONE = 'A skill on this template is no longer available, so it was not published.';
const SKILL_SERVICE_DOWN = 'The skill service did not answer, so nothing was published.';
const SKILL_ANSWER_UNUSABLE =
  'The skill service returned an answer Conductia could not use, so nothing was published.';
const SKILL_COPY_FAILED = 'The skills on this template could not be copied, so nothing was published.';

function refusal(error: RpcError) {
  const conflict = PUBLISH_CONFLICT[error.message];
  if (conflict) return jsonError(conflict, 409);
  if (error.code === 'P0003') return jsonError('Template not found.', 404);
  return jsonError('The template was not published. Try again.', 500);
}

function retainRefusal(error: TemplateError) {
  if (error.code === 'skill_unavailable') return jsonError(SKILL_GONE, 409);
  if (error.code === 'provider_unavailable' && error.status === 502) {
    return jsonError(SKILL_ANSWER_UNUSABLE, 502);
  }
  if (error.code === 'provider_unavailable') return jsonError(SKILL_SERVICE_DOWN, 503);
  return jsonError(SKILL_COPY_FAILED, 500);
}

export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (!isUuid(templateId)) return jsonError('Template not found.', 404);

  const protectedIds = [...PROTECTED_STEP_IDS];
  const check = await auth.admin.rpc('rail_catalog_publish_check', {
    p_template_id: templateId,
    p_company_id: actor.companyId,
    p_protected_ids: protectedIds,
  });
  if (check.error) return refusal(check.error);

  const plan = parsePublishCheck(check.data);
  if (!plan) return jsonError('Could not read the template.', 500);

  let revisionId: string | null = null;
  let receipt: RetainReceipt | null = null;
  if (plan.skills.length > 0) {
    if (!(await isFlagEnabled('skill_authoring'))) return jsonError(SKILLS_OFF, 409);
    revisionId = randomUUID();
    try {
      receipt = await retainTemplateSkills(revisionId, {
        companyId: plan.tenantId,
        skills: plan.skills,
      });
    } catch (error) {
      if (error instanceof TemplateError) return retainRefusal(error);
      throw error;
    }
  }

  const { data, error } = await auth.admin.rpc('publish_rail_template', {
    p_template_id: templateId,
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_protected_ids: protectedIds,
    p_revision_id: revisionId,
    p_receipt: receipt,
  });
  if (error) return refusal(error);

  return NextResponse.json(data);
}
