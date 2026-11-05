import { NextResponse } from "next/server";
import { isUuid, jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";
import { parseDraftPatch } from "@/lib/skillAuthoring/parse";
import {
  callRpc,
  correlationId,
  isParsedError,
  normalizeAuthoritativeDraft,
  normalizeReceipt,
  readJson,
  type RpcClient,
} from "@/lib/skillAuthoring/browserRoute";

type RouteContext = { params: Promise<{ dealId: string; draftId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const flag = await requireFlag("skill_authoring");
  if (flag) return flag;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { dealId, draftId } = await context.params;
  const correlation = correlationId(request);
  const access = await requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealId,
    correlation,
  );
  if (!access.ok) return jsonError(access.message, access.status);
  if (!isUuid(draftId)) return jsonError("Draft not found.", 404);

  const result = await callRpc(
    auth.admin as unknown as RpcClient,
    "skill_authoring_read_draft",
    {
      p_actor_id: auth.user.id,
      p_deal_id: access.deal.id,
      p_draft_id: draftId,
      p_correlation_id: correlation,
    },
  );
  if ("response" in result) return result.response;
  const draft = normalizeAuthoritativeDraft(
    (result.data as { draft?: unknown } | null)?.draft ?? result.data,
  );
  if (!draft)
    return jsonError("Unable to process skill authoring request.", 500);
  return NextResponse.json({ draft });
}

export async function PATCH(request: Request, context: RouteContext) {
  const flag = await requireFlag("skill_authoring");
  if (flag) return flag;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { dealId, draftId } = await context.params;
  const correlation = correlationId(request);
  const access = await requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealId,
    correlation,
  );
  if (!access.ok) return jsonError(access.message, access.status);
  if (!isUuid(draftId)) return jsonError("Draft not found.", 404);
  const patch = parseDraftPatch(await readJson(request));
  if (isParsedError(patch)) return jsonError(patch.error, 400);

  const result = await callRpc(
    auth.admin as unknown as RpcClient,
    "skill_authoring_patch_draft",
    {
      p_actor_id: auth.user.id,
      p_deal_id: access.deal.id,
      p_draft_id: draftId,
      p_expected_revision: patch.expectedEditRevision,
      p_name: patch.name,
      p_phase_index: patch.placement?.phaseIndex ?? null,
      p_placement_kind: patch.placement?.kind ?? null,
      p_anchor_step_id:
        patch.placement?.kind === "after" ? patch.placement.afterStepId : null,
      p_composer_text: patch.composerText,
      p_correlation_id: correlation,
    },
  );
  if ("response" in result) return result.response;
  const receipt = normalizeReceipt(result.data);
  if (!receipt)
    return jsonError("Unable to process skill authoring request.", 500);
  return NextResponse.json(receipt);
}
